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

const PORT = process.env.PORT || 8080;
const BOT_TOKEN = process.env.BOT_TOKEN;
const OZON_API_BASE = process.env.OZON_API_BASE || "https://api-seller.ozon.ru";
const OZON_DEFAULT_CLIENT_ID = process.env.OZON_DEFAULT_CLIENT_ID || process.env.OZON_CLIENT_ID;
const OZON_DEFAULT_API_KEY = process.env.OZON_DEFAULT_API_KEY || process.env.OZON_API_KEY;

const SALES_TZ = process.env.SALES_TZ || "Europe/Moscow";
const DATA_DIR = process.env.DATA_DIR || ".";
const STORE_PATH = path.join(DATA_DIR, "store.json");
const ENCRYPTION_KEY_B64 = process.env.ENCRYPTION_KEY_B64;

// --- ТВОИ ОРИГИНАЛЬНЫЕ ХЕЛПЕРЫ STORE ---
function loadStore() {
  try {
    if (!fs.existsSync(STORE_PATH)) return { users: {} };
    return JSON.parse(fs.readFileSync(STORE_PATH, "utf-8"));
  } catch { return { users: {} }; }
}
function saveStore(store) { fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), "utf-8"); }
function getUserCreds(userId) { return loadStore().users?.[String(userId)] || null; }

// --- ТВОЙ ОРИГИНАЛЬНЫЙ CRYPTO ---
function decrypt(obj) {
  if (!obj || obj.mode === "plain") return obj?.value || null;
  try {
    const key = Buffer.from(ENCRYPTION_KEY_B64 || "", "base64");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(obj.iv, "base64"));
    decipher.setAuthTag(Buffer.from(obj.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(obj.value, "base64")), decipher.final()]).toString("utf8");
  } catch { return null; }
}

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

// --- ВСЕ ТВОИ ФУНКЦИИ РАСЧЕТА (БЕЗ ИЗМЕНЕНИЙ) ---
function todayDateStr() { return DateTime.now().setZone(SALES_TZ).toFormat("yyyy-LL-dd"); }
function dayBoundsUtcFromLocal(dateStr) {
  const fromLocal = DateTime.fromFormat(dateStr, "yyyy-LL-dd", { zone: SALES_TZ }).startOf("day");
  const toLocal = DateTime.fromFormat(dateStr, "yyyy-LL-dd", { zone: SALES_TZ }).endOf("day");
  return { since: fromLocal.toUTC().toISO({ suppressMilliseconds: false }), to: toLocal.toUTC().toISO({ suppressMilliseconds: false }) };
}
function isSameDayLocal(iso, dateStr) {
  if (!iso) return false;
  const d = DateTime.fromISO(iso, { setZone: true }).setZone(SALES_TZ);
  return d.isValid && d.toFormat("yyyy-LL-dd") === dateStr;
}
function toCents(val) {
  let s = String(val || "0").trim().replace(",", ".");
  const parts = s.split(".");
  const rub = parseInt(parts[0] || "0", 10);
  const kop = parseInt((parts[1] || "0").padEnd(2, "0").slice(0, 2), 10);
  return (s.startsWith("-") ? -1 : 1) * (Math.abs(rub) * 100 + kop);
}
function centsToRubString(cents) { return `${(cents / 100).toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₽`; }

async function calcTodayStats({ clientId, apiKey, dateStr }) {
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
  let oC = 0, oA = 0, cC = 0, cA = 0;
  for (const p of all) {
    if (!isSameDayLocal(p?.created_at, dateStr)) continue;
    let sum = 0;
    for (const pr of p.products || []) sum += toCents(pr.price) * (pr.quantity || 1);
    oC++; oA += sum;
    if (String(p?.status).toLowerCase() === "cancelled") { cC++; cA += sum; }
  }
  return { ordersCount: oC, ordersAmount: oA, cancelsCount: cC, cancelsAmount: cA };
}

async function calcBalanceToday({ clientId, apiKey, dateStr }) {
    try {
        const data = await ozonPost("/v1/finance/balance", { clientId, apiKey, body: { date_from: dateStr, date_to: dateStr } });
        const t = data?.result?.total || data?.total;
        const sales = data?.result?.cashflows?.sales?.amount?.value || 0;
        const returns = data?.result?.cashflows?.returns?.amount?.value || 0;
        return {
            balance_cents: toCents(t?.closing_balance),
            balance_opening_cents: toCents(t?.opening_balance),
            buyouts_sum_cents: toCents(sales),
            returns_sum_cents: toCents(returns)
        };
    } catch { return { balance_cents: null }; }
}

function resolveCredsFromRequest(req) {
  const qClient = req.query.clientId;
  const qKey = req.query.apiKey;
  if (qClient && qKey) return { clientId: qClient, apiKey: qKey };
  const store = loadStore();
  const firstUser = Object.values(store.users || {})[0];
  if (firstUser) return { clientId: firstUser.clientId, apiKey: decrypt(firstUser.apiKey) };
  return { clientId: OZON_DEFAULT_CLIENT_ID, apiKey: OZON_DEFAULT_API_KEY };
}

// --- API ---
app.get("/api/dashboard/today", async (req, res) => {
  try {
    const creds = resolveCredsFromRequest(req);
    const dateStr = todayDateStr();
    const [s, b] = await Promise.all([calcTodayStats({ ...creds, dateStr }), calcBalanceToday({ ...creds, dateStr })]);
    res.json({
      title: `FBO: за сегодня ${dateStr}`,
      date: dateStr,
      ordersCount: s.ordersCount,
      ordersAmount: s.ordersAmount,
      cancelsCount: s.cancelsCount,
      cancelsAmount: s.cancelsAmount,
      balance_cents: b.balance_cents,
      balance_opening_cents: b.balance_opening_cents,
      buyouts_sum_cents: b.buyouts_sum_cents,
      returns_sum_cents: b.returns_sum_cents,
      updated_at: DateTime.now().setZone(SALES_TZ).toISO()
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => console.log(`✅ Started on :${PORT}`));
