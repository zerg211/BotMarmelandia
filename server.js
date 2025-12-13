// server.js — Railway + Telegram Mini App (Seller API)
// - Always listens on Railway PORT (no hardcoded 8080)
// - Serves Mini App UI from /public
// - Telegram works ONLY via webhook (no polling => no 409)
// - Stores per-user Ozon keys encrypted in SQLite (mount Railway Volume if you want persistence)

import express from "express";
import bodyParser from "body-parser";
import path from "path";
import crypto from "crypto";
import Database from "better-sqlite3";
import { Telegraf, Markup } from "telegraf";

// ===================== ENV =====================
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) throw new Error("BOT_TOKEN is not set");

const PORT = Number.parseInt(process.env.PORT ?? "", 10);
if (!Number.isFinite(PORT)) throw new Error("PORT is not set by the platform");

const BASE_URL = (process.env.BASE_URL || "").replace(/\/$/, "");
if (!BASE_URL) throw new Error("BASE_URL is not set (example: https://xxxx.up.railway.app)");

const OZON_API_BASE = (process.env.OZON_API_BASE || "https://api-seller.ozon.ru").replace(/\/$/, "");
const SALES_TIMEZONE = process.env.SALES_TIMEZONE || "Europe/Moscow";

// 32-byte key in base64
const ENCRYPTION_KEY_B64 = process.env.ENCRYPTION_KEY_B64;
if (!ENCRYPTION_KEY_B64) throw new Error("ENCRYPTION_KEY_B64 is not set");
const ENC_KEY = Buffer.from(ENCRYPTION_KEY_B64, "base64");
if (ENC_KEY.length !== 32) throw new Error("ENCRYPTION_KEY_B64 must decode to 32 bytes");

// ===================== DB (SQLite) =====================
// NOTE: For persistence on Railway, mount a Volume and set DATA_DIR to that mount path.
const DATA_DIR = process.env.DATA_DIR || "./data";
const DB_PATH = path.join(DATA_DIR, "app.db");
await ensureDir(DATA_DIR);
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS user_keys (
    user_id TEXT PRIMARY KEY,
    enc_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);

// ===================== APP =====================
const app = express();
app.use(bodyParser.json({ limit: "1mb" }));

// Healthcheck (Railway / edge)
app.get("/health", (req, res) => res.status(200).json({ ok: true }));

// Serve Mini App
const __dirname = path.dirname(new URL(import.meta.url).pathname);
const publicDir = path.join(__dirname, "public");
app.use(express.static(publicDir, { index: "index.html" }));

// ===================== TELEGRAM =====================
const bot = new Telegraf(BOT_TOKEN);

const WEBHOOK_PATH = "/telegram-webhook";

// Webhook receiver
app.post(WEBHOOK_PATH, (req, res) => {
  bot.handleUpdate(req.body);
  res.sendStatus(200);
});

bot.start(async (ctx) => {
  const url = `${BASE_URL}/`;
  await ctx.reply(
    "Открываю мини‑приложение 👇",
    Markup.inlineKeyboard([Markup.button.webApp("Моя аналитика", url)])
  );
});

// Keep simple debug commands
bot.command("ping", (ctx) => ctx.reply("pong"));

// ===================== API HELPERS =====================

// Telegram initData verification (mandatory for per-user storage)
function verifyTelegramInitData(initData) {
  // initData is querystring: "query_id=...&user=...&hash=..."
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;

  params.delete("hash");

  // build data_check_string
  const pairs = [];
  for (const [k, v] of params.entries()) pairs.push(`${k}=${v}`);
  pairs.sort();
  const dataCheckString = pairs.join("\n");

  // secret key = sha256(bot_token)
  const secretKey = crypto.createHash("sha256").update(BOT_TOKEN).digest();
  const hmac = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  if (hmac !== hash) return null;

  const userJson = params.get("user");
  if (!userJson) return null;
  try {
    const user = JSON.parse(userJson);
    if (!user?.id) return null;
    return { user, params };
  } catch {
    return null;
  }
}

function getUserIdFromReq(req) {
  const initData = req.header("x-telegram-init-data") || "";
  const verified = verifyTelegramInitData(initData);
  if (!verified) return null;
  return String(verified.user.id);
}

function encryptJson(obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", ENC_KEY, iv);
  const plaintext = Buffer.from(JSON.stringify(obj), "utf8");
  const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

function decryptJson(b64) {
  const raw = Buffer.from(b64, "base64");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const enc = raw.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", ENC_KEY, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  return JSON.parse(dec.toString("utf8"));
}

function loadKeys(userId) {
  const row = db.prepare("SELECT enc_json FROM user_keys WHERE user_id = ?").get(userId);
  if (!row) return null;
  try {
    return decryptJson(row.enc_json);
  } catch {
    return null;
  }
}

function saveKeys(userId, keys) {
  const enc_json = encryptJson(keys);
  db.prepare(`
    INSERT INTO user_keys (user_id, enc_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      enc_json = excluded.enc_json,
      updated_at = excluded.updated_at
  `).run(userId, enc_json, Date.now());
}

function deleteKeys(userId) {
  db.prepare("DELETE FROM user_keys WHERE user_id = ?").run(userId);
}

// ===================== OZON Seller API =====================
// We count "postings" created today (all statuses) for FBS.
// If your account uses FBO or you want other logic — скажи, подправлю.
async function ozonRequest({ clientId, apiKey, path, body }) {
  const resp = await fetch(`${OZON_API_BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Client-Id": String(clientId),
      "Api-Key": String(apiKey),
    },
    body: JSON.stringify(body),
  });

  const text = await resp.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }

  if (!resp.ok) {
    const msg = json?.message || json?.error?.message || resp.statusText;
    throw new Error(`Ozon API error ${resp.status}: ${msg}`);
  }
  return json;
}

function isoDayRangeInTz(tz) {
  // Railway runs in UTC, so we compute today's range in requested TZ.
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  const parts = fmt.formatToParts(now);
  const y = parts.find(p => p.type === "year").value;
  const m = parts.find(p => p.type === "month").value;
  const d = parts.find(p => p.type === "day").value;

  // Start/end in TZ as ISO with offset: we just send date strings to Ozon; most endpoints accept ISO UTC.
  // We'll use UTC boundaries for that date in TZ by converting from "yyyy-mm-ddT00:00:00" in TZ to UTC.
  const startLocal = new Date(`${y}-${m}-${d}T00:00:00`);
  const endLocal = new Date(`${y}-${m}-${d}T23:59:59`);
  // These are in server local tz, but we only use date strings for display and safe request filters (see below).
  return { y, m, d, startLocal, endLocal, dateLabel: `${y}-${m}-${d}` };
}

async function getTodaySales({ clientId, apiKey }) {
  // FBS postings list
  const { dateLabel } = isoDayRangeInTz(SALES_TIMEZONE);

  // Ozon endpoint expects "since"/"to" in RFC3339 (UTC). We'll request the last 24h window as fallback.
  const now = new Date();
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const to = now.toISOString();

  const data = await ozonRequest({
    clientId,
    apiKey,
    path: "/v3/posting/fbs/list",
    body: {
      filter: { since, to },
      limit: 1000,
      offset: 0,
      with: { analytics_data: true, financial_data: true },
    },
  });

  const postings = data?.result?.postings || [];
  // Filter by "created_at" date (YYYY-MM-DD) in SALES_TIMEZONE
  const df = new Intl.DateTimeFormat("en-CA", { timeZone: SALES_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" });
  const today = dateLabel;

  const todays = postings.filter((p) => {
    const created = p?.created_at ? new Date(p.created_at) : null;
    if (!created) return false;
    const parts = df.formatToParts(created);
    const y = parts.find(x => x.type === "year").value;
    const m = parts.find(x => x.type === "month").value;
    const d = parts.find(x => x.type === "day").value;
    return `${y}-${m}-${d}` === today;
  });

  // Count and sum (if financial_data present)
  let count = todays.length;
  let sum = 0;
  for (const p of todays) {
    // try few common fields
    const amount =
      p?.financial_data?.products?.reduce?.((a, pr) => a + (Number(pr?.price) || 0), 0) ??
      Number(p?.financial_data?.posting_services?.marketplace_service_item_fulfillment) ??
      0;
    if (Number.isFinite(amount)) sum += amount;
  }

  return { date: today, count, sum };
}

// ===================== API =====================

app.get("/api/keys", (req, res) => {
  const userId = getUserIdFromReq(req);
  if (!userId) return res.status(401).json({ ok: false, error: "unauthorized" });

  const keys = loadKeys(userId);
  if (!keys) return res.status(404).json({ ok: false, error: "keys_not_found" });
  // never return secrets fully
  return res.json({ ok: true, hasKeys: true, clientId: String(keys.clientId || ""), apiKeyMasked: mask(keys.apiKey || "") });
});

app.post("/api/keys", (req, res) => {
  const userId = getUserIdFromReq(req);
  if (!userId) return res.status(401).json({ ok: false, error: "unauthorized" });

  const { clientId, apiKey } = req.body || {};
  if (!clientId || !apiKey) return res.status(400).json({ ok: false, error: "clientId_and_apiKey_required" });

  saveKeys(userId, { clientId: String(clientId).trim(), apiKey: String(apiKey).trim() });
  return res.json({ ok: true });
});

app.delete("/api/keys", (req, res) => {
  const userId = getUserIdFromReq(req);
  if (!userId) return res.status(401).json({ ok: false, error: "unauthorized" });
  deleteKeys(userId);
  return res.json({ ok: true });
});

app.get("/api/today", async (req, res) => {
  const userId = getUserIdFromReq(req);
  if (!userId) return res.status(401).json({ ok: false, error: "unauthorized" });

  const keys = loadKeys(userId);
  if (!keys?.clientId || !keys?.apiKey) return res.status(404).json({ ok: false, error: "keys_not_found" });

  try {
    const result = await getTodaySales(keys);
    return res.json({ ok: true, ...result });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ===================== START =====================
app.listen(PORT, async () => {
  console.log(`Server started on :${PORT}`);

  // Force webhook mode (avoid 409)
  await bot.telegram.deleteWebhook({ drop_pending_updates: true }).catch(() => {});
  await bot.telegram.setWebhook(`${BASE_URL}${WEBHOOK_PATH}`);
  console.log(`Telegram webhook set: ${BASE_URL}${WEBHOOK_PATH}`);

  // optional: set menu button for mini app
  await bot.telegram.setChatMenuButton({
    menu_button: { type: "web_app", text: "Моя аналитика", web_app: { url: `${BASE_URL}/` } },
  }).catch(() => {});
});

// ===================== UTIL =====================
async function ensureDir(dir) {
  await import("fs/promises").then(fs => fs.mkdir(dir, { recursive: true })).catch(() => {});
}
function mask(s) {
  const str = String(s || "");
  if (str.length <= 6) return "*".repeat(str.length);
  return str.slice(0, 3) + "*".repeat(str.length - 6) + str.slice(-3);
}
