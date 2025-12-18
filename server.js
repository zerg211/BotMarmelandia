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

// ====== STATIC ======
app.use("/public", express.static(path.join(__dirname, "Public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "Public", "index.html"));
});

app.get("/health", (req, res) => res.status(200).json({ status: "ok" }));

const PORT = process.env.PORT || 8080;
const BOT_TOKEN = process.env.BOT_TOKEN;
const OZON_API_BASE = process.env.OZON_API_BASE || "https://api-seller.ozon.ru";
const OZON_DEFAULT_CLIENT_ID = process.env.OZON_DEFAULT_CLIENT_ID || process.env.OZON_CLIENT_ID;
const OZON_DEFAULT_API_KEY = process.env.OZON_DEFAULT_API_KEY || process.env.OZON_API_KEY;

const SALES_TZ = process.env.SALES_TZ || "Europe/Moscow";
const DATA_DIR = process.env.DATA_DIR || ".";
const STORE_PATH = path.join(DATA_DIR, "store.json");
const ENCRYPTION_KEY_B64 = process.env.ENCRYPTION_KEY_B64;
const pending = new Map();

// ---------------- store ----------------
function loadStore() {
  try {
    if (!fs.existsSync(STORE_PATH)) return { users: {} };
    return JSON.parse(fs.readFileSync(STORE_PATH, "utf-8"));
  } catch { return { users: {} }; }
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

// ---------------- crypto ----------------
function encrypt(text) {
  if (!ENCRYPTION_KEY_B64) return { mode: "plain", value: text };
  const key = Buffer.from(ENCRYPTION_KEY_B64, "base64");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return {
    mode: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    value: enc.toString("base64"),
  };
}
function decrypt(obj) {
  if (!obj || obj.mode === "plain") return obj?.value || null;
  const key = Buffer.from(ENCRYPTION_KEY_B64 || "", "base64");
  const iv = Buffer.from(obj.iv, "base64");
  const tag = Buffer.from(obj.tag, "base64");
  const data = Buffer.from(obj.value, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(data), decipher.final()]);
  return dec.toString("utf8");
}

// ---------------- ozon core ----------------
async function ozonPost(pathname, { clientId, apiKey, body }) {
  const resp = await fetch(`${OZON_API_BASE}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Client-Id": String(clientId), "Api-Key": String(apiKey) },
    body: JSON.stringify(body),
  });
  const data = await resp.json().catch(() => null);
  if (!resp.ok) throw new Error(data?.message || JSON.stringify(data));
  return data;
}

// ---------------- date/money ----------------
function todayDateStr() { return DateTime.now().setZone(SALES_TZ).toFormat("yyyy-LL-dd"); }
function dayBoundsUtcFromLocal(dateStr) {
  const fromLocal = DateTime.fromFormat(dateStr, "yyyy-LL-dd", { zone: SALES_TZ }).startOf("day");
  const toLocal = DateTime.fromFormat(dateStr, "yyyy-LL-dd", { zone: SALES_TZ }).endOf("day");
  return { since: fromLocal.toUTC().toISO(), to: toLocal.toUTC().toISO() };
}
function toCents(val) {
  let s = String(val || "0").replace(",", ".");
  const parts = s.split(".");
  const rub = parseInt(parts[0] || "0", 10);
  const kop = parseInt((parts[1] || "0").padEnd(2, "0").slice(0, 2), 10);
  return rub * 100 + (s.startsWith("-") ? -kop : kop);
}
function centsToRubString(cents) {
  return `${(cents / 100).toLocaleString("ru-RU", { minimumFractionDigits: 2 })} ₽`;
}

// ... (остальные хелперы: calcTodayStats, calcBuyoutsTodayByOffer, calcBalanceToday, fetchFinanceTransactions)
// Я их сокращаю здесь для краткости, но в рабочем коде они остаются без изменений

async function fetchFboAllForDay({ clientId, apiKey, dateStr }) {
    const { since, to } = dayBoundsUtcFromLocal(dateStr);
    let offset = 0, limit = 1000, all = [];
    while (true) {
      const body = { dir: "ASC", filter: { since, to, status: "" }, limit, offset, with: { financial_data: true } };
      const data = await ozonPost("/v2/posting/fbo/list", { clientId, apiKey, body });
      const postings = data?.result?.postings || data?.result || [];
      all.push(...postings);
      if (postings.length < limit) break;
      offset += limit;
    }
    return all;
}

async function calcTodayStats({ clientId, apiKey, dateStr }) {
    const postings = await fetchFboAllForDay({ clientId, apiKey, dateStr });
    let oCount = 0, oAmt = 0, cCount = 0, cAmt = 0;
    for (const p of postings) {
        let sum = 0;
        for (const pr of p.products || []) sum += toCents(pr.price) * (pr.quantity || 1);
        oCount++; oAmt += sum;
        if (p.status === "cancelled") { cCount++; cAmt += sum; }
    }
    return { dateStr, ordersCount: oCount, ordersAmount: oAmt, cancelsCount: cCount, cancelsAmount: cAmt };
}

// Эндпоинты дашборда
app.get("/api/dashboard/today", async (req, res) => {
    try {
        const qC = req.query.clientId;
        const qK = req.query.apiKey;
        if (!qC || !qK) return res.status(400).json({ error: "no_creds" });
        
        const dateStr = todayDateStr();
        const s = await calcTodayStats({ clientId: qC, apiKey: qK, dateStr });
        // упрощенный баланс
        const balData = await ozonPost("/v1/finance/balance", { clientId: qC, apiKey: qK, body: { date_from: dateStr, date_to: dateStr } }).catch(()=>null);
        const closing = balData?.result?.total?.closing_balance || 0;

        res.json({
            date: s.dateStr,
            ordersCount: s.ordersCount,
            ordersAmount: s.ordersAmount,
            cancelsCount: s.cancelsCount,
            cancelsAmount: s.cancelsAmount,
            balance_cents: toCents(closing),
            updated_at: new Date().toISOString()
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => console.log(`✅ Server (No-Calc) started on :${PORT}`));
