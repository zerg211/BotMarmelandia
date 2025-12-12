import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import path from 'path';
import crypto from 'crypto';
import axios from 'axios';
import Database from 'better-sqlite3';
import { DateTime } from 'luxon';
import { Telegraf, Markup } from 'telegraf';

const {
  PORT = '3000',
  BASE_URL, // https://your-domain.tld (нужно для WebApp кнопки, можно оставить пустым и задать в .env)
  BOT_TOKEN,
  ENCRYPTION_KEY_B64,
  OZON_API_BASE = 'https://api-seller.ozon.ru',
  SALES_TIMEZONE = 'Europe/Moscow'
} = process.env;


// Normalize BASE_URL once (avoid duplicate declarations)
const BASE_URL_CLEAN = (BASE_URL || '').replace(/\/+$/, '');
if (!BOT_TOKEN) {
  console.error('❌ Не задан BOT_TOKEN в .env');
  process.exit(1);
}
if (!ENCRYPTION_KEY_B64) {
  console.error('❌ Не задан ENCRYPTION_KEY_B64 в .env');
  process.exit(1);
}

// 32 bytes key (base64)
const ENC_KEY = Buffer.from(ENCRYPTION_KEY_B64, 'base64');
if (ENC_KEY.length !== 32) {
  console.error('❌ ENCRYPTION_KEY_B64 должен быть base64 от 32 байт (AES-256).');
  process.exit(1);
}

const app = express();
app.use(helmet({
  contentSecurityPolicy: false // иначе WebApp скрипт Telegram может конфликтовать
}));
app.use(express.json({ limit: '100kb' }));

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const publicDir = path.join(__dirname, 'public');
app.use('/', express.static(publicDir, { extensions: ['html'] }));

// --- DB (SQLite) ---
const dbPath = path.join(__dirname, 'data', 'app.db');
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

const getUser = db.prepare(`SELECT * FROM users WHERE tg_user_id = ?`);
const deleteUser = db.prepare(`DELETE FROM users WHERE tg_user_id = ?`);

// --- Crypto helpers (AES-256-GCM) ---
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
  const plain = Buffer.concat([decipher.update(enc), decipher.final()]);
  return plain.toString('utf8');
}

// --- Telegram initData verification (защита от подмены user_id) ---
function parseInitData(initData) {
  const params = new URLSearchParams(initData);
  const obj = {};
  for (const [k, v] of params.entries()) obj[k] = v;
  return obj;
}

function verifyInitData(initData, botToken) {
  // Telegram docs: build data_check_string from sorted key=value excluding hash
  const data = parseInitData(initData);
  const hash = data.hash;
  if (!hash) return { ok: false, reason: 'no hash' };
  delete data.hash;

  const keys = Object.keys(data).sort();
  const dataCheckString = keys.map(k => `${k}=${data[k]}`).join('\n');

  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computed = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');

  if (computed !== hash) return { ok: false, reason: 'hash mismatch' };

  // (опционально) проверка auth_date, чтобы не было слишком старых initData
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

// --- Ozon: fetch FBO postings for today ---
async function fetchFboPostingsForToday({ clientId, apiKey }) {
  const now = DateTime.now().setZone(SALES_TIMEZONE);
  const since = now.startOf('day').toUTC().toISO({ suppressMilliseconds: true });
  const to = now.endOf('day').toUTC().toISO({ suppressMilliseconds: true });

  const limit = 1000;
  let offset = 0;
  let all = [];

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

    const postings = resp?.data?.result || resp?.data?.result?.postings || resp?.data?.result?.postings || resp?.data?.result;
    // В документации result = postings[], но встречаются разные обертки в SDK/примерах — страхуемся:
    const list = Array.isArray(postings) ? postings : (resp?.data?.result?.postings || []);
    all.push(...list);

    if (list.length < limit) break;
    offset += limit;
    if (offset > 100000) break; // safety
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
      const price = Number(pr.price || 0); // как правило, это "цена продажи" с учетом скидок
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

  return {
    units,
    sum,
    cancelledUnits,
    cancelledSum
  };
}

// --- API ---
app.get('/api/me', requireTelegram, (req, res) => {
  const row = getUser.get(req.tgUserId);
  res.json({ connected: !!row, ozon_client_id: row?.ozon_client_id || null });
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

// --- Telegram bot ---
const bot = new Telegraf(BOT_TOKEN);

bot.start(async (ctx) => {
  const webAppUrl = BASE_URL_CLEAN || 'https://YOUR-DOMAIN.TLD';
  await ctx.reply(
    'Открой мини‑приложение и подключи Ozon (Client-Id + Api-Key) один раз.\n\nДальше будет показывать “Продажи за сегодня” и сумму.',
    Markup.inlineKeyboard([
      Markup.button.webApp('📊 Открыть продажи', `${webAppUrl}/`)
    ])
  );
});

bot.command('sales', async (ctx) => {
  const webAppUrl = BASE_URL_CLEAN || 'https://YOUR-DOMAIN.TLD';
  await ctx.reply(
    'Открывай:',
    Markup.inlineKeyboard([Markup.button.webApp('📊 Продажи за сегодня', `${webAppUrl}/`)])
  );
});


// --- Telegram bot start ---
// On hosting (Railway, etc.) we use Webhook to avoid Telegram 409 conflicts.
// Locally (without BASE_URL) we fallback to long polling.
const WEBHOOK_PATH = '/telegram-webhook';

async function startBot() {
  if (BASE_URL_CLEAN) {
    // Register webhook and mount handler in Express
    try {
      await bot.telegram.deleteWebhook({ drop_pending_updates: true });
    } catch (e) {
      // ignore if not set
    }
    await bot.telegram.setWebhook(`${BASE_URL_CLEAN}${WEBHOOK_PATH}`);
    app.use(WEBHOOK_PATH, bot.webhookCallback(WEBHOOK_PATH));
    console.log(`✅ Telegram webhook set: ${BASE_URL_CLEAN}${WEBHOOK_PATH}`);
  } else {
    // Local dev: polling
    await bot.launch();
    console.log('✅ Telegram bot started (polling)');
  }
}

// graceful shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

startBot().catch((err) => {
  console.error('❌ Failed to start Telegram bot:', err);
  process.exit(1);
});

app.listen(Number(PORT), () => {
  console.log(`✅ Server started on :${PORT}`);
});
