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

// ====== MINI APP (страница + статика из /Public) ======
app.use("/public", express.static(path.join(__dirname, "Public")));

// если кто-то открывает кривой путь вида "/https://....." — редиректим на главную
app.get(/^\/https?:\/\//, (req, res) => res.redirect(302, "/"));

// главная Mini App
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "Public", "index.html"));
});
app.get("/index.html", (req, res) => {
  res.sendFile(path.join(__dirname, "Public", "index.html"));
});

app.get("/health", (req, res) => res.status(200).json({ status: "ok" }));

const PORT = process.env.PORT || 8080;
const BOT_TOKEN = process.env.BOT_TOKEN;
const OZON_API_BASE = process.env.OZON_API_BASE || "https://api-seller.ozon.ru";

// “Сегодня” считаем по МСК (или поменяй через ENV SALES_TZ)
const SALES_TZ = process.env.SALES_TZ || "Europe/Moscow";

const DATA_DIR = process.env.DATA_DIR || ".";
const STORE_PATH = path.join(DATA_DIR, "store.json");
const ENCRYPTION_KEY_B64 = process.env.ENCRYPTION_KEY_B64;
const pending = new Map();

// ---------------- store helpers ----------------
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

// ---------------- crypto helpers ----------------
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

// ---------------- telegram helpers ----------------
async function tgSendMessage(chatId, text, opts = {}) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const payload = { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true, ...opts };
  const resp = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  const data = await resp.json().catch(() => null);
  if (!data?.ok) console.error("❌ sendMessage failed:", data);
  return data;
}
async function tgEditMessage(chatId, messageId, text, opts = {}) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`;
  const payload = { chat_id: chatId, message_id: messageId, text, parse_mode: "HTML", disable_web_page_preview: true, ...opts };
  const resp = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  const data = await resp.json().catch(() => null);
  if (!data?.ok) {
    const descr = String(data?.description || "");
    if (!descr.includes("message is not modified")) console.error("❌ editMessageText failed:", data);
  }
  return data;
}
async function tgAnswerCallback(callbackQueryId) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`;
  await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ callback_query_id: callbackQueryId }) });
}

// ---------------- ozon helpers ----------------
async function ozonPost(pathname, { clientId, apiKey, body }) {
  const resp = await fetch(`${OZON_API_BASE}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Client-Id": String(clientId), "Api-Key": String(apiKey) },
    body: JSON.stringify(body),
  });

  const data = await resp.json().catch(() => null);
  if (!resp.ok) {
    const msg = data?.message || data?.error || JSON.stringify(data);
    throw new Error(`Ozon API ${pathname} (${resp.status}): ${msg}`);
  }
  return data;
}

// ---------------- date helpers ----------------
function todayDateStr() {
  return DateTime.now().setZone(SALES_TZ).toFormat("yyyy-LL-dd");
}
function dayBoundsUtcFromLocal(dateStr) {
  const fromLocal = DateTime.fromFormat(dateStr, "yyyy-LL-dd", { zone: SALES_TZ }).startOf("day");
  const toLocal = DateTime.fromFormat(dateStr, "yyyy-LL-dd", { zone: SALES_TZ }).endOf("day");
  return {
    since: fromLocal.toUTC().toISO({ suppressMilliseconds: false }),
    to: toLocal.toUTC().toISO({ suppressMilliseconds: false }),
  };
}
function isSameDayLocal(iso, dateStr) {
  if (!iso) return false;
  const d = DateTime.fromISO(iso, { setZone: true }).setZone(SALES_TZ);
  return d.isValid && d.toFormat("yyyy-LL-dd") === dateStr;
}

// ---------------- money helpers (без float) ----------------
function toCents(val) {
  if (val === null || val === undefined) return 0;
  const s = String(val).trim().replace(",", ".");
  if (!s) return 0;
  const parts = s.split(".");
  const rub = parseInt(parts[0] || "0", 10) || 0;
  const kop = parseInt((parts[1] || "0").padEnd(2, "0").slice(0, 2), 10) || 0;
  return rub * 100 + kop;
}
const rubFmt = new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function centsToRubString(cents) {
  return `${rubFmt.format(cents / 100)} ₽`;
}

function postingAmountCents(posting) {
  const qtyBySku = new Map();
  for (const pr of posting?.products || []) {
    qtyBySku.set(String(pr.sku), Number(pr.quantity || 0));
  }

  const finProds = posting?.financial_data?.products || [];
  if (Array.isArray(finProds) && finProds.length > 0) {
    let sum = 0;
    for (const fp of finProds) {
      const id = String(fp.product_id);
      const qty = qtyBySku.get(id) ?? 1;
      sum += toCents(fp.price) * qty;
    }
    if (sum > 0) return sum;
  }

  let sum2 = 0;
  for (const pr of posting?.products || []) {
    sum2 += toCents(pr.price) * Number(pr.quantity || 0);
  }
  return sum2;
}

// ---------------- Core: FBO fetch + stats ----------------
function extractPostings(data) {
  if (Array.isArray(data?.result)) return { postings: data.result, hasNext: false };
  const r = data?.result || {};
  if (Array.isArray(r?.postings)) return { postings: r.postings, hasNext: Boolean(r.has_next) };
  if (Array.isArray(data?.postings)) return { postings: data.postings, hasNext: Boolean(data?.has_next) };
  return { postings: [], hasNext: false };
}

async function fetchFboAllForDay({ clientId, apiKey, dateStr }) {
  const { since, to } = dayBoundsUtcFromLocal(dateStr);

  let offset = 0;
  const limit = 1000;
  const all = [];

  while (true) {
    const body = {
      dir: "ASC",
      filter: { since, to, status: "" },
      limit,
      offset,
      translit: true,
      with: { analytics_data: true, financial_data: true, legal_info: false },
    };

    const data = await ozonPost("/v2/posting/fbo/list", { clientId, apiKey, body });
    const { postings, hasNext } = extractPostings(data);

    all.push(...postings);
    if (!hasNext) break;

    offset += limit;
    if (offset > 200000) break;
  }

  return all;
}

async function calcTodayStats({ clientId, apiKey, dateStr }) {
  const postings = await fetchFboAllForDay({ clientId, apiKey, dateStr });

  let ordersCount = 0;
  let ordersAmount = 0;

  let cancelsCount = 0;
  let cancelsAmount = 0;

  for (const p of postings) {
    if (!isSameDayLocal(p?.created_at, dateStr)) continue;

    const amt = postingAmountCents(p);

    ordersCount += 1;
    ordersAmount += amt;

    if (String(p?.status || "").toLowerCase() === "cancelled") {
      cancelsCount += 1;
      cancelsAmount += amt;
    }
  }

  return { dateStr, ordersCount, ordersAmount, cancelsCount, cancelsAmount };
}


// ---------------- Core: buyouts / returns / refusals by posting details ----------------
// Идея: берём список отправлений за последние N дней (/v2/posting/fbo/list),
// затем для каждого posting_number берём детали (/v2/posting/fbo/get) и классифицируем по substatus.

async function fetchFboPostingNumbersLastDays({ clientId, apiKey, dateStr, days = 10 }) {
  const from = DateTime.fromFormat(dateStr, "yyyy-LL-dd", { zone: SALES_TZ }).minus({ days }).startOf("day");
  const to = DateTime.fromFormat(dateStr, "yyyy-LL-dd", { zone: SALES_TZ }).endOf("day");
  const sinceIso = from.toUTC().toISO({ suppressMilliseconds: false });
  const toIso = to.toUTC().toISO({ suppressMilliseconds: false });

  let offset = 0;
  const limit = 1000;
  const nums = [];

  while (true) {
    const body = {
      dir: "ASC",
      filter: { since: sinceIso, to: toIso, status: "" },
      limit,
      offset,
      translit: true,
      with: { analytics_data: false, financial_data: false, legal_info: false },
    };

    const data = await ozonPost("/v2/posting/fbo/list", { clientId, apiKey, body });
    const { postings, hasNext } = extractPostings(data);
    for (const p of postings || []) {
      if (p?.posting_number) nums.push(String(p.posting_number));
    }
    if (!hasNext) break;

    offset += limit;
    if (offset > 200000) break;
  }

  // уникальные
  return Array.from(new Set(nums));
}

async function fetchFboPostingDetails({ clientId, apiKey, postingNumber }) {
  const body = {
    posting_number: postingNumber,
    translit: true,
    with: { analytics_data: false, financial_data: false, legal_info: false },
  };
  const data = await ozonPost("/v2/posting/fbo/get", { clientId, apiKey, body });
  return data?.result || null;
}

function pickEventIsoForSubstatus(d) {
  // пытаемся найти "когда статус поменялся" — в API может называться по-разному
  return (
    d?.status_updated_at ||
    d?.updated_at ||
    d?.substatus_updated_at ||
    d?.in_process_at ||
    d?.created_at ||
    null
  );
}

async function calcEventsToday({ clientId, apiKey, dateStr }) {
  const byBuyout = new Map();
  const byReturn = new Map();
  const byRefusal = new Map();

  let buyoutsQty = 0;
  let returnsQty = 0;
  let refusalsQty = 0;
  let refusalsAmount = 0; // копейки

  const postingNumbers = await fetchFboPostingNumbersLastDays({ clientId, apiKey, dateStr, days: 10 });

  // защита от слишком больших выборок
  const MAX_DETAILS = 400;
  const list = postingNumbers.slice(0, MAX_DETAILS);

  // батчи по 10, чтобы не задушить API
  const batchSize = 10;
  for (let i = 0; i < list.length; i += batchSize) {
    const batch = list.slice(i, i + batchSize);
    const details = await Promise.all(batch.map((pn) => fetchFboPostingDetails({ clientId, apiKey, postingNumber: pn }).catch(() => null)));

    for (const d of details) {
      if (!d) continue;

      const status = String(d.status || "").toLowerCase();
      const sub = String(d.substatus || "").toLowerCase();

      // 1) Выкуплено сегодня: delivered + fact_delivery_date сегодня
      if (status === "delivered" && isSameDayLocal(d.fact_delivery_date, dateStr)) {
        for (const pr of d.products || []) {
          const offerId = pr?.offer_id ? String(pr.offer_id) : (pr?.sku ? String(pr.sku) : "UNKNOWN");
          const qty = Number(pr?.quantity || 0) || 0;
          if (qty <= 0) continue;
          buyoutsQty += qty;
          byBuyout.set(offerId, (byBuyout.get(offerId) || 0) + qty);
        }
      }

      // 2) Возвраты / Отказы: по substatus и дате обновления (если есть)
      if (sub === "posting_received" || sub === "posting_canceled") {
        const eventIso = pickEventIsoForSubstatus(d);
        if (!isSameDayLocal(eventIso, dateStr)) continue;

        for (const pr of d.products || []) {
          const offerId = pr?.offer_id ? String(pr.offer_id) : (pr?.sku ? String(pr.sku) : "UNKNOWN");
          const qty = Number(pr?.quantity || 0) || 0;
          if (qty <= 0) continue;

          if (sub === "posting_received") {
            returnsQty += qty;
            byReturn.set(offerId, (byReturn.get(offerId) || 0) + qty);
          } else {
            refusalsQty += qty;
            byRefusal.set(offerId, (byRefusal.get(offerId) || 0) + qty);
            // сумма отказов считаем по цене товара из products
            refusalsAmount += toCents(pr?.price) * qty;
          }
        }
      }
    }
  }

  const buyouts_list = Array.from(byBuyout.entries()).map(([offer_id, qty]) => ({ offer_id, qty })).sort((a, b) => b.qty - a.qty);
  const returns_list = Array.from(byReturn.entries()).map(([offer_id, qty]) => ({ offer_id, qty })).sort((a, b) => b.qty - a.qty);
  const refusals_list = Array.from(byRefusal.entries()).map(([offer_id, qty]) => ({ offer_id, qty })).sort((a, b) => b.qty - a.qty);

  return {
    buyouts_total_qty: buyoutsQty,
    buyouts_list,
    returns_total_qty: returnsQty,
    returns_list,
    refusals_total_qty: refusalsQty,
    refusals_amount: refusalsAmount,
    refusals_list,
    scanned_postings: list.length,
  };
}

async function getBalanceForDay({ clientId, apiKey, dateStr }) {
  // dateStr: YYYY-MM-DD
  const body = { date_from: dateStr, date_to: dateStr };
  const data = await ozonPost("/v1/finance/balance", { clientId, apiKey, body });
  const closing = data?.total?.closing_balance?.value;
  const opening = data?.total?.opening_balance?.value;
  return {
    balance_opening_cents: Math.round(Number(opening || 0) * 100),
    balance_closing_cents: Math.round(Number(closing || 0) * 100),
  };
}

// ====== API: получить ключи из (query → user_id → первый юзер) ======
function resolveCredsFromRequest(req) {
  const qClient = req.query.clientId || req.query.client_id;
  const qKey = req.query.apiKey || req.query.api_key;

  // 1) Если MiniApp передал ключи прямо в запросе
  if (qClient && qKey) {
    return { clientId: String(qClient), apiKey: String(qKey), source: "query" };
  }

  // 2) Если передан user_id (telegram id)
  const qUserId = req.query.user_id || req.query.userId;
  if (qUserId) {
    const creds = getUserCreds(String(qUserId));
    if (creds?.clientId && creds?.apiKey) {
      return { clientId: creds.clientId, apiKey: decrypt(creds.apiKey), source: "user_id" };
    }
  }

  // 3) Иначе — первый пользователь в store.json
  const store = loadStore();
  const firstUserId = Object.keys(store.users || {})[0];
  if (firstUserId) {
    const creds = getUserCreds(firstUserId);
    if (creds?.clientId && creds?.apiKey) {
      return { clientId: creds.clientId, apiKey: decrypt(creds.apiKey), source: "first_user" };
    }
  }

  return null;
}

async function handleToday(req, res) {
  try {
    const resolved = resolveCredsFromRequest(req);
    if (!resolved) return res.status(400).json({ error: "no_creds" });

    const dateStr = todayDateStr();
    const s = await calcTodayStats({ clientId: resolved.clientId, apiKey: resolved.apiKey, dateStr });
    const [eventsRes, balRes] = await Promise.allSettled([
      calcEventsToday({ clientId: resolved.clientId, apiKey: resolved.apiKey, dateStr }),
      getBalanceForDay({ clientId: resolved.clientId, apiKey: resolved.apiKey, dateStr }),
    ]);

    const events = eventsRes.status === "fulfilled" ? eventsRes.value : {
      buyouts_total_qty: 0,
      buyouts_list: [],
      returns_total_qty: 0,
      returns_list: [],
      refusals_total_qty: 0,
      refusals_amount: 0,
      refusals_list: [],
      scanned_postings: 0,
    };

    const bal = balRes.status === "fulfilled" ? balRes.value : { balance_opening_cents: null, balance_closing_cents: null };

    return res.json({
      title: `FBO: за сегодня ${s.dateStr} (${SALES_TZ})`,
      tz: SALES_TZ,
      date: s.dateStr,

      // для совместимости — и так и так
      orders: s.ordersCount,
      ordersCount: s.ordersCount,

      orders_sum: s.ordersAmount,          // копейки
      ordersAmount: s.ordersAmount,        // копейки
      orders_sum_text: centsToRubString(s.ordersAmount),

      // ❗ В интерфейсе переименовано в «Отказы» и считается по substatus=posting_canceled
      cancels: events.refusals_total_qty,
      cancelsCount: events.refusals_total_qty,

      cancels_sum: events.refusals_amount,        // копейки
      cancelsAmount: events.refusals_amount,      // копейки
      cancels_sum_text: centsToRubString(events.refusals_amount),

      // выкупы / возвраты
      buyouts_total_qty: events.buyouts_total_qty,
      buyouts_list: events.buyouts_list,
      returns_total_qty: events.returns_total_qty,
      returns_list: events.returns_list,

      // баланс
      balance_opening: bal.balance_opening_cents,
      balance_closing: bal.balance_closing_cents,
      balance_closing_text: (bal.balance_closing_cents === null ? "—" : centsToRubString(bal.balance_closing_cents)),

      debug_scanned_postings: events.scanned_postings,
      widgets_errors: {
        events: eventsRes.status === "rejected" ? String(eventsRes.reason?.message || eventsRes.reason) : null,
        balance: balRes.status === "rejected" ? String(balRes.reason?.message || balRes.reason) : null,
      },

      updated_at: DateTime.now().setZone(SALES_TZ).toISO(),
      source: resolved.source
    });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}

// ТРИ URL (на случай, что фронт зовёт другой путь)
app.get("/api/dashboard/today", handleToday);
app.get("/api/today", handleToday);
app.get("/api/stats/today", handleToday);

// ---------------- widget (чат) ----------------
function widgetText(s) {
  return [
    `📅 <b>FBO: за сегодня</b> <b>${s.dateStr}</b> (${SALES_TZ})`,
    ``,
    `📦 Заказы: <b>${s.ordersCount}</b>`,
    `💰 Сумма заказов: <b>${centsToRubString(s.ordersAmount)}</b>`,
    ``,
    `❌ Отмены: <b>${s.cancelsCount}</b>`,
    `💸 Сумма отмен: <b>${centsToRubString(s.cancelsAmount)}</b>`,
  ].join("\n");
}

function widgetKeyboard(dateStr) {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: "🔄 Обновить", callback_data: `refresh:${dateStr}` }],
        [{ text: "🔑 Сменить ключи", callback_data: "reset_keys" }],
      ],
    },
  };
}

async function showWidget(chatId, userId, dateStr, editMessageId = null) {
  const creds = getUserCreds(userId);
  if (!creds?.clientId || !creds?.apiKey) {
    await tgSendMessage(chatId, "❗ Ключи Ozon не настроены. Напиши /start.");
    return;
  }

  const apiKey = decrypt(creds.apiKey);
  const clientId = creds.clientId;

  try {
    const s = await calcTodayStats({ clientId, apiKey, dateStr });
    const text = widgetText(s);
    if (editMessageId) await tgEditMessage(chatId, editMessageId, text, widgetKeyboard(dateStr));
    else await tgSendMessage(chatId, text, widgetKeyboard(dateStr));
  } catch (e) {
    const msg = `❌ Не смог получить данные за <b>${dateStr}</b>.\n\n<code>${String(e.message || e)}</code>`;
    if (editMessageId) await tgEditMessage(chatId, editMessageId, msg, widgetKeyboard(dateStr));
    else await tgSendMessage(chatId, msg, widgetKeyboard(dateStr));
  }
}

// ---------------- webhook ----------------
app.post("/telegram-webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const update = req.body;
    const msg = update?.message;
    const cb = update?.callback_query;

    if (cb) {
      const chatId = cb.message?.chat?.id;
      const userId = cb.from?.id;
      const messageId = cb.message?.message_id;
      const data = cb.data;

      await tgAnswerCallback(cb.id);
      if (!chatId || !userId) return;

      if (data?.startsWith("refresh:")) {
        const dateStr = data.split(":")[1] || todayDateStr();
        await showWidget(chatId, userId, dateStr, messageId);
        return;
      }

      if (data === "reset_keys") {
        deleteUserCreds(userId);
        pending.set(userId, { step: "clientId" });
        await tgEditMessage(chatId, messageId, "🔑 Ок, заново.\n\nОтправь <b>Client ID</b>.");
        return;
      }
      return;
    }

    const chatId = msg?.chat?.id;
    const userId = msg?.from?.id;
    const text = msg?.text?.trim();
    if (!chatId || !userId || !text) return;

    if (text === "/start") {
      const creds = getUserCreds(userId);
      if (creds?.clientId && creds?.apiKey) {
        await tgSendMessage(chatId, "✅ Ключи уже сохранены. Показываю статистику за сегодня:");
        await showWidget(chatId, userId, todayDateStr());
        return;
      }
      pending.set(userId, { step: "clientId" });
      await tgSendMessage(chatId, "Отправь <b>Client ID</b>.");
      return;
    }

    if (text === "/reset") {
      deleteUserCreds(userId);
      pending.set(userId, { step: "clientId" });
      await tgSendMessage(chatId, "Ок. Отправь <b>Client ID</b>.");
      return;
    }

    const st = pending.get(userId);
    if (st?.step === "clientId") {
      pending.set(userId, { step: "apiKey", clientId: text });
      await tgSendMessage(chatId, "Теперь отправь <b>Api-Key</b>.");
      return;
    }
    if (st?.step === "apiKey") {
      setUserCreds(userId, { clientId: st.clientId, apiKey: encrypt(text), savedAt: Date.now() });
      pending.delete(userId);
      await tgSendMessage(chatId, "✅ Сохранил. Открываю статистику за сегодня:");
      await showWidget(chatId, userId, todayDateStr());
      return;
    }

    await tgSendMessage(chatId, "Команды:\n/start\n/reset");
  } catch (err) {
    console.error("Webhook handler error:", err);
  }
});

app.listen(PORT, () => console.log(`✅ Server started on :${PORT}`));
