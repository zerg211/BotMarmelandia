import express from "express";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { DateTime } from "luxon";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

// ================== STATIC (MINI APP) ==================
app.use("/public", express.static(path.join(__dirname, "Public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "Public", "index.html"));
});

// ================== HEALTH ==================
app.get("/health", (req, res) => res.json({ status: "ok" }));

// ================== CONFIG ==================
const PORT = process.env.PORT || 8080;
const BOT_TOKEN = process.env.BOT_TOKEN;
const OZON_API_BASE = process.env.OZON_API_BASE || "https://api-seller.ozon.ru";
const SALES_TZ = process.env.SALES_TZ || "Europe/Moscow";

const DATA_DIR = process.env.DATA_DIR || ".";
const STORE_PATH = path.join(DATA_DIR, "store.json");
const ENCRYPTION_KEY_B64 = process.env.ENCRYPTION_KEY_B64;

const pending = new Map();

// ================== STORE ==================
function loadStore() {
  try {
    if (!fs.existsSync(STORE_PATH)) return { users: {} };
    return JSON.parse(fs.readFileSync(STORE_PATH, "utf-8"));
  } catch {
    return { users: {} };
  }
}
function saveStore(store) {
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), "utf-8");
}
function getUserCreds(userId) {
  const store = loadStore();
  return store.users?.[String(userId)] || null;
}
function setUserCreds(userId, creds) {
  const store = loadStore();
  store.users = store.users || {};
  store.users[String(userId)] = creds;
  saveStore(store);
}
function deleteUserCreds(userId) {
  const store = loadStore();
  if (store.users) delete store.users[String(userId)];
  saveStore(store);
}

// ================== CRYPTO ==================
function encrypt(text) {
  if (!ENCRYPTION_KEY_B64) return { mode: "plain", value: text };
  const key = Buffer.from(ENCRYPTION_KEY_B64, "base64");
  if (key.length !== 32) return { mode: "plain", value: text };

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    mode: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    value: enc.toString("base64"),
  };
}
function decrypt(obj) {
  if (!obj) return null;
  if (obj.mode === "plain") return obj.value;

  const key = Buffer.from(ENCRYPTION_KEY_B64 || "", "base64");
  const iv = Buffer.from(obj.iv, "base64");
  const tag = Buffer.from(obj.tag, "base64");
  const data = Buffer.from(obj.value, "base64");

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(data), decipher.final()]);
  return dec.toString("utf8");
}

// ================== DATE ==================
function todayDateStr() {
  return DateTime.now().setZone(SALES_TZ).toFormat("yyyy-LL-dd");
}
function dayBoundsUtcFromLocal(dateStr) {
  const fromLocal = DateTime.fromFormat(dateStr, "yyyy-LL-dd", { zone: SALES_TZ }).startOf("day");
  const toLocal = DateTime.fromFormat(dateStr, "yyyy-LL-dd", { zone: SALES_TZ }).endOf("day");
  return {
    since: fromLocal.toUTC().toISO(),
    to: toLocal.toUTC().toISO(),
  };
}
function isSameDayLocal(iso, dateStr) {
  if (!iso) return false;
  return DateTime.fromISO(iso).setZone(SALES_TZ).toFormat("yyyy-LL-dd") === dateStr;
}

// ================== MONEY ==================
function toCents(val) {
  if (!val) return 0;
  const s = String(val).replace(",", ".");
  const [r, k = "0"] = s.split(".");
  return parseInt(r, 10) * 100 + parseInt(k.padEnd(2, "0").slice(0, 2), 10);
}
function centsToRub(c) {
  return new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 2 }).format(c / 100);
}

// ================== OZON ==================
async function ozonPost(pathname, { clientId, apiKey, body }) {
  const r = await fetch(`${OZON_API_BASE}${pathname}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Client-Id": String(clientId),
      "Api-Key": String(apiKey),
    },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.message || "Ozon error");
  return data;
}

async function fetchFboForToday({ clientId, apiKey }) {
  const dateStr = todayDateStr();
  const { since, to } = dayBoundsUtcFromLocal(dateStr);

  const body = {
    dir: "ASC",
    filter: { since, to, status: "" },
    limit: 1000,
    offset: 0,
    with: { analytics_data: true, financial_data: true },
  };

  const data = await ozonPost("/v2/posting/fbo/list", { clientId, apiKey, body });
  const postings = data?.result || [];

  let orders = 0, ordersSum = 0;
  let cancels = 0, cancelsSum = 0;

  for (const p of postings) {
    if (!isSameDayLocal(p.created_at, dateStr)) continue;

    const amount = toCents(p.financial_data?.products?.[0]?.price || 0);
    orders++;
    ordersSum += amount;

    if (String(p.status).toLowerCase() === "cancelled") {
      cancels++;
      cancelsSum += amount;
    }
  }

  return { orders, ordersSum, cancels, cancelsSum, dateStr };
}

// ================== API FOR MINI APP ==================
app.get("/api/dashboard/today", async (req, res) => {
  try {
    const store = loadStore();
    const userId = Object.keys(store.users || {})[0];
    if (!userId) return res.status(400).json({ error: "no user" });

    const creds = getUserCreds(userId);
    const apiKey = decrypt(creds.apiKey);
    const clientId = creds.clientId;

    const s = await fetchFboForToday({ clientId, apiKey });

    res.json({
      orders: s.orders,
      orders_sum: s.ordersSum,
      cancels: s.cancels,
      cancels_sum: s.cancelsSum,
      updated_at: DateTime.now().setZone(SALES_TZ).toISO(),
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message) });
  }
});

// ================== START ==================
app.listen(PORT, () => console.log(`✅ Server started on ${PORT}`));
