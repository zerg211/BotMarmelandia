import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import axios from 'axios';
import Database from 'better-sqlite3';
import { DateTime } from 'luxon';
import { Telegraf, Markup } from 'telegraf';

// ================= ENV =================
const {
  PORT,
  BASE_URL,                // https://<your-railway-domain>
  BOT_TOKEN,
  ENCRYPTION_KEY_B64,
  OZON_API_BASE = 'https://api-seller.ozon.ru',
  SALES_TIMEZONE = 'Europe/Moscow'
} = process.env;

if (!BOT_TOKEN) throw new Error('BOT_TOKEN is not set');
if (!BASE_URL) throw new Error('BASE_URL is not set');
if (!ENCRYPTION_KEY_B64) throw new Error('ENCRYPTION_KEY_B64 is not set');

const LISTEN_PORT = Number(PORT || 8080);
const BASE = String(BASE_URL).replace(/\/$/, '');

// 32 bytes key (base64) for AES-256-GCM
const ENC_KEY = Buffer.from(ENCRYPTION_KEY_B64, 'base64');
if (ENC_KEY.length !== 32) {
  throw new Error('ENCRYPTION_KEY_B64 must be base64 of 32 bytes (AES-256)');
}

// ================= APP =================
const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '200kb' }));

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const publicDir = path.join(__dirname, 'public');

// Railway healthcheck + quick debug
app.get('/', (req, res) => res.status(200).send('OK'));
app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));

// Static Mini App
app.use('/app', express.static(publicDir, { extensions: ['html'] }));
// Backward-compat: open miniapp on /
app.use('/', express.static(publicDir, { extensions: ['html'] }));

// ================= DB (SQLite) =================
const dataDir = path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });

const dbPath = path.join(dataDir, 'app.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    tg_user_id INTEGER PRIMARY KEY,
    ozon_client_id TEXT NOT NULL,
    ozon_api_key_enc TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

const upsertUser = db.prepare(`
  INSERT INTO users (tg_user_id, ozon_client_id, ozon_api_key_enc, created_at, updated_at)
  VALUES (@tg_user_id, @ozon_client_id, @ozon_api_key_enc, @created_at, @updated_at)
  ON CONFLICT(tg_user_id) DO UPDATE SET
    ozon_client_id=excluded.ozon_client_id,
    ozon_api_key_enc=excluded.ozon_api_key_enc,
    updated_at=excluded.updated_at
`);

const getUser = db.prepare('SELECT * FROM users WHERE tg_user_id = ?');
const deleteUser = db.prepare('DELETE FROM users WHERE tg_user_id = ?');

// ================= Crypto (AES-256-GCM) =================
function encryptString(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

function decryptString(encB64) {
  const raw = Buffer.from(encB64, 'base64');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const enc = raw.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', ENC_KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

// ================= Telegram initData verify =================
function parseInitData(initData) {
  const params = new URLSearchParams(initData);
  const obj = {};
  for (const [k, v] of params.entries()) obj[k] = v;
  return obj;
}

function verifyInitData(initData, botToken) {
  const data = parseInitData(initData);
  const hash = data.hash;
  if (!hash) return { ok: false, reason: 'no hash' };
  delete data.hash;

  const keys = Object.keys(data).sort();
  const dataCheckString = keys.map(k => `${k}=${data[k]}`).join('\n');

  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computed = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');

  if (computed !== hash) return { ok: false, reason: 'hash mismatch' };

  const authDate = Number(data.auth_date || '0');
  const now = Math.floor(Date.now() / 1000);
  if (authDate && (now - authDate) > 24 * 3600) {
    return { ok: false, reason: 'initData too old' };
  }

  return { ok: true, data };
}

function getTgUserIdFromInitData(initData) {
  const parsed = parseInitData(initData);
  if (!parsed.user) return null;
  try {
    const userObj = JSON.parse(parsed.user);
    return userObj.id;
  } catch {
    return null;
  }
}

function requireTelegram(req, res, next) {
  const initData = req.header('x-telegram-init-data') || '';
  const v = verifyInitData(initData, BOT_TOKEN);
  if (!v.ok) return res.status(401).json({ error: 'Unauthorized', reason: v.reason });

  const tgUserId = getTgUserIdFromInitData(initData);
  if (!tgUserId) return res.status(401).json({ error: 'Unauthorized', reason: 'no user id' });

  req.tgUserId = tgUserId;
  next();
}

// ================= Ozon Seller API =================
async function fetchFboPostingsForToday({ clientId, apiKey }) {
  const now = DateTime.now().setZone(SALES_TIMEZONE);
  const since = now.startOf('day').toUTC().toISO({ suppressMilliseconds: true });
  const to = now.endOf('day').toUTC().toISO({ suppressMilliseconds: true });

  const limit = 1000;
  let offset = 0;
  const all = [];

  while (true) {
    const body = {
      filter: { since, to },
      limit,
      offset,
      with: { financial_data: true }
    };

    const resp = await axios.post(`${OZON_API_BASE}/v2/posting/fbo/list`, body, {
      headers: {
        'Client-Id': clientId,
        'Api-Key': apiKey,
        'Content-Type': 'application/json'
      },
      timeout: 25000
    });

    const list = Array.isArray(resp?.data?.result)
      ? resp.data.result
      : (resp?.data?.result?.postings || []);

    all.push(...list);

    if (list.length < limit) break;
    offset += limit;
    if (offset > 100000) break;
  }

  return { since, to, postings: all };
}

function isCancelledStatus(status) {
  const s = String(status || '').toLowerCase();
  return s.includes('cancel') || s.includes('cancell') || s.includes('отмен');
}

function calcTotals(postings) {
  let units = 0;
  let sum = 0;
  let cancelledUnits = 0;
  let cancelledSum = 0;

  for (const p of postings) {
    const status = p.status;
    const products = p?.financial_data?.products || [];

    let postingUnits = 0;
    let postingSum = 0;

    for (const pr of products) {
      const qty = Number(pr.quantity || 0);
      const price = Number(pr.price || 0);
      postingUnits += qty;
      postingSum += price * qty;
    }

    units += postingUnits;
    sum += postingSum;

    if (isCancelledStatus(status)) {
      cancelledUnits += postingUnits;
      cancelledSum += postingSum;
    }
  }

  return { units, sum, cancelledUnits, cancelledSum };
}

// ================= API =================
app.get('/api/me', requireTelegram, (req, res) => {
  const row = getUser.get(req.tgUserId);
  res.json({
    connected: !!row,
    ozon_client_id: row?.ozon_client_id || null
  });
});

app.post('/api/connect', requireTelegram, (req, res) => {
  const { clientId, apiKey } = req.body || {};
  if (!clientId || !apiKey) return res.status(400).json({ error: 'clientId and apiKey required' });

  const now = new Date().toISOString();
  upsertUser.run({
    tg_user_id: req.tgUserId,
    ozon_client_id: String(clientId).trim(),
    ozon_api_key_enc: encryptString(String(apiKey).trim()),
    created_at: now,
    updated_at: now
  });

  res.json({ ok: true });
});

app.post('/api/disconnect', requireTelegram, (req, res) => {
  deleteUser.run(req.tgUserId);
  res.json({ ok: true });
});

app.get('/api/today', requireTelegram, async (req, res) => {
  try {
    const row = getUser.get(req.tgUserId);
    if (!row) return res.status(400).json({ error: 'not connected' });

    const clientId = row.ozon_client_id;
    const apiKey = decryptString(row.ozon_api_key_enc);

    const { since, to, postings } = await fetchFboPostingsForToday({ clientId, apiKey });
    const totals = calcTotals(postings);

    res.json({
      ok: true,
      timezone: SALES_TIMEZONE,
      since,
      to,
      postings_count: postings.length,
      ...totals,
      updated_at: new Date().toISOString()
    });
  } catch (e) {
    const msg = e?.response?.data ? JSON.stringify(e.response.data) : (e?.message || 'unknown error');
    res.status(500).json({ error: 'ozon_fetch_failed', details: msg });
  }
});

// ================= TELEGRAM BOT (webhook only) =================
const bot = new Telegraf(BOT_TOKEN);

bot.start(async (ctx) => {
  await ctx.reply(
    'Открой мини‑приложение. Там можно ввести Client‑Id и Api‑Key (Seller API) и смотреть продажи за сегодня.',
    Markup.inlineKeyboard([
      Markup.button.webApp('📊 Открыть продажи', `${BASE}/`)
    ])
  );
});

bot.command('sales', async (ctx) => {
  await ctx.reply(
    'Открывай мини‑приложение:',
    Markup.inlineKeyboard([Markup.button.webApp('📊 Продажи за сегодня', `${BASE}/`)])
  );
});

bot.command('ping', (ctx) => ctx.reply('pong'));

const WEBHOOK_PATH = '/telegram-webhook';
app.post(WEBHOOK_PATH, (req, res) => {
  bot.handleUpdate(req.body);
  res.sendStatus(200);
});

// ================= START =================
app.listen(LISTEN_PORT, async () => {
  console.log(`✅ Server started on :${LISTEN_PORT}`);

  // IMPORTANT: switch bot to webhook mode (no polling, no 409)
  await bot.telegram.setWebhook(`${BASE}${WEBHOOK_PATH}`);
  console.log(`✅ Telegram webhook set: ${BASE}${WEBHOOK_PATH}`);
});
