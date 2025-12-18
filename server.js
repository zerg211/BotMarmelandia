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

// --- STORE HELPERS ---
function loadStore() {
  try {
    if (!fs.existsSync(STORE_PATH)) return { users: {} };
    return JSON.parse(fs.readFileSync(STORE_PATH, "utf-8"));
  } catch { return { users: {} }; }
}
function saveStore(store) { fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), "utf-8"); }
function getUserCreds(userId) { return loadStore().users?.[String(userId)] || null; }
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

// --- CRYPTO ---
function encrypt(text) {
  if (!ENCRYPTION_KEY_B64) return { mode: "plain", value: text };
  const key = Buffer.from(ENCRYPTION_KEY_B64, "base64");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return { mode: "aes-256-gcm", iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), value: enc.toString("base64") };
}
function decrypt(obj) {
  if (!obj || obj.mode === "plain") return obj?.value || null;
  try {
    const key = Buffer.from(ENCRYPTION_KEY_B64 || "", "base64");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(obj.iv, "base64"));
    decipher.setAuthTag(Buffer.from(obj.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(obj.value, "base64")), decipher.final()]).toString("utf8");
  } catch { return null; }
}

// --- OZON CORE ---
async function ozonPost(pathname, { clientId, apiKey, body }) {
  const resp = await fetch(`${OZON_API_BASE}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Client-Id": String(clientId), "Api-Key": String(apiKey) },
    body: JSON.stringify(body),
  });
  const data = await resp.json().catch(() => null);
  if (!resp.ok) throw new Error(data?.message || "Ozon API Error");
  return data;
}

// --- ТВОЯ ОРИГИНАЛЬНАЯ ЛОГИКА РАСЧЕТОВ ---
function todayDateStr() { return DateTime.now().setZone(SALES_TZ).toFormat("yyyy-LL-dd"); }
function dayBoundsUtcFromLocal(dateStr) {
  const fromLocal = DateTime.fromFormat(dateStr, "yyyy-LL-dd", { zone: SALES_TZ }).startOf("day");
  const toLocal = DateTime.fromFormat(dateStr, "yyyy-LL-dd", { zone: SALES_TZ }).endOf("day");
  return { since: fromLocal.toUTC().toISO(), to: toLocal.toUTC().toISO() };
}
function toCents(val) {
  let s = String(val || "0").trim().replace(",", ".");
  const parts = s.split(".");
  const rub = parseInt(parts[0] || "0", 10);
  const kop = parseInt((parts[1] || "0").padEnd(2, "0").slice(0, 2), 10);
  return (s.startsWith("-") ? -1 : 1) * (Math.abs(rub) * 100 + kop);
}
function centsToRubString(cents) { return `${(cents / 100).toLocaleString("ru-RU", { minimumFractionDigits: 2 })} ₽`; }

function isSameDayLocal(iso, dateStr) {
  if (!iso) return false;
  const d = DateTime.fromISO(iso, { setZone: true }).setZone(SALES_TZ);
  return d.isValid && d.toFormat("yyyy-LL-dd") === dateStr;
}

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
    if (!isSameDayLocal(p?.created_at, dateStr)) continue;
    let sum = 0;
    for (const pr of p.products || []) sum += toCents(pr.price) * (pr.quantity || 1);
    oCount++; oAmt += sum;
    if (String(p?.status).toLowerCase() === "cancelled") { cCount++; cAmt += sum; }
  }
  return { dateStr, ordersCount: oCount, ordersAmount: oAmt, cancelsCount: cCount, cancelsAmount: cAmt };
}

async function calcBalanceToday({ clientId, apiKey, dateStr }) {
    try {
        const data = await ozonPost("/v1/finance/balance", { clientId, apiKey, body: { date_from: dateStr, date_to: dateStr } });
        const total = data?.result?.total || data?.total;
        const closing = total?.closing_balance || 0;
        const opening = total?.opening_balance || 0;
        const sales = data?.result?.cashflows?.sales?.amount?.value || 0;
        const returns = data?.result?.cashflows?.returns?.amount?.value || 0;
        return {
            balance_cents: toCents(closing),
            balance_opening_cents: toCents(opening),
            buyouts_sum_cents: toCents(sales),
            returns_sum_cents: toCents(returns)
        };
    } catch { return { balance_cents: null }; }
}

function resolveCredsFromRequest(req) {
  const qClient = req.query.clientId || req.body?.clientId;
  const qKey = req.query.apiKey || req.body?.apiKey;
  if (qClient && qKey) return { clientId: String(qClient), apiKey: String(qKey) };
  const store = loadStore();
  const firstUser = Object.values(store.users || {})[0];
  if (firstUser) return { clientId: firstUser.clientId, apiKey: decrypt(firstUser.apiKey) };
  return { clientId: OZON_DEFAULT_CLIENT_ID, apiKey: OZON_DEFAULT_API_KEY };
}

// --- API ENDPOINTS ---
app.get("/api/dashboard/today", async (req, res) => {
  try {
    const creds = resolveCredsFromRequest(req);
    if (!creds.clientId || !creds.apiKey) return res.status(400).json({ error: "no_creds" });
    const dateStr = todayDateStr();
    
    // ВЫЗОВ РЕАЛЬНЫХ ФУНКЦИЙ
    const [stats, balance] = await Promise.all([
      calcTodayStats({ ...creds, dateStr }),
      calcBalanceToday({ ...creds, dateStr })
    ]);

    res.json({
      title: `FBO: за сегодня ${dateStr}`,
      date: dateStr,
      ordersCount: stats.ordersCount,
      ordersAmount: stats.ordersAmount,
      cancelsCount: stats.cancelsCount,
      cancelsAmount: stats.cancelsAmount,
      balance_cents: balance.balance_cents,
      balance_opening_cents: balance.balance_opening_cents,
      buyouts_sum_cents: balance.buyouts_sum_cents,
      returns_sum_cents: balance.returns_sum_cents,
      updated_at: DateTime.now().setZone(SALES_TZ).toISO()
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Добавь сюда свои оригинальные /api/balance/ops/today и /api/balance/sale/detail, если они нужны в приложении

app.listen(PORT, () => console.log(`✅ Server (Full Analytics) started on :${PORT}`));
