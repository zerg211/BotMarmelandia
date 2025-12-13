import express from "express";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { DateTime } from "luxon";

const app = express();
app.use(express.json());

// Health routes
app.get("/", (req, res) => res.status(200).send("OK"));
app.get("/index.html", (req, res) => res.status(200).send("OK"));
app.get("/health", (req, res) => res.status(200).json({ status: "ok" }));

const PORT = process.env.PORT || 8080;
const BOT_TOKEN = process.env.BOT_TOKEN;

const OZON_API_BASE = process.env.OZON_API_BASE || "https://api-seller.ozon.ru";
const SALES_TZ = process.env.SALES_TZ || "Europe/Moscow";

// store
const DATA_DIR = process.env.DATA_DIR || ".";
const STORE_PATH = path.join(DATA_DIR, "store.json");

// encryption (optional)
const ENCRYPTION_KEY_B64 = process.env.ENCRYPTION_KEY_B64;

// dialog state
const pending = new Map();

// cache
const postingTypeCache = new Map(); // posting_number -> 'fbs'|'fbo'
const postingAmountCache = new Map(); // posting_number -> { amount, type, ts }
const POSTING_CACHE_TTL_MS = 60_000;

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
  if (key.length !== 32) {
    console.warn("⚠️ ENCRYPTION_KEY_B64 should decode to 32 bytes. Fallback to plain.");
    return { mode: "plain", value: text };
  }

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
  const payload = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...opts,
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const data = await resp.json().catch(() => null);
  if (!data?.ok) console.error("❌ sendMessage failed:", data);
  return data;
}

async function tgEditMessage(chatId, messageId, text, opts = {}) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`;
  const payload = {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...opts,
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const data = await resp.json().catch(() => null);
  if (!data?.ok) console.error("❌ editMessageText failed:", data);
  return data;
}

async function tgAnswerCallback(callbackQueryId) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId }),
  });
}

// ---------------- ozon helpers ----------------
async function ozonPost(pathname, { clientId, apiKey, body }) {
  const resp = await fetch(`${OZON_API_BASE}${pathname}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Client-Id": String(clientId),
      "Api-Key": String(apiKey),
    },
    body: JSON.stringify(body),
  });

  const data = await resp.json().catch(() => null);
  if (!resp.ok) {
    const msg = data?.message || data?.error || JSON.stringify(data);
    throw new Error(`Ozon API ${pathname} (${resp.status}): ${msg}`);
  }
  return data;
}

function todayDateStr() {
  return DateTime.now().setZone(SALES_TZ).toFormat("yyyy-LL-dd");
}

function rangeForDate(dateStr) {
  const from = DateTime.fromFormat(dateStr, "yyyy-LL-dd", { zone: SALES_TZ }).startOf("day");
  const to = DateTime.fromFormat(dateStr, "yyyy-LL-dd", { zone: SALES_TZ }).endOf("day");
  return {
    dateStr,
    fromUtcIso: from.toUTC().toISO(),
    toUtcIso: to.toUTC().toISO(),
  };
}

// сумма “как в ЛК рядом с заказом”: Σ customer_price * quantity
function calcOrderAmountFromPostingFinancial(financialData) {
  const products = financialData?.products || [];
  let sum = 0;
  for (const p of products) {
    const qty = Number(p.quantity ?? 1) || 1;
    const customerPrice = Number(p.customer_price ?? 0) || 0;
    sum += customerPrice * qty;
  }
  return sum;
}

async function getPostingAmountAndType({ clientId, apiKey, postingNumber }) {
  const cached = postingAmountCache.get(postingNumber);
  if (cached && Date.now() - cached.ts < POSTING_CACHE_TTL_MS) return cached;

  const knownType = postingTypeCache.get(postingNumber);

  const tryFbs = async () => {
    const data = await ozonPost("/v3/posting/fbs/get", {
      clientId,
      apiKey,
      body: { posting_number: postingNumber, with: { financial_data: true } },
    });
    const fin = data?.result?.financial_data;
    const amount = calcOrderAmountFromPostingFinancial(fin);
    postingTypeCache.set(postingNumber, "fbs");
    return { amount, type: "fbs" };
  };

  const tryFbo = async () => {
    const data = await ozonPost("/v2/posting/fbo/get", {
      clientId,
      apiKey,
      body: { posting_number: postingNumber, with: { financial_data: true } },
    });
    const fin = data?.result?.financial_data;
    const amount = calcOrderAmountFromPostingFinancial(fin);
    postingTypeCache.set(postingNumber, "fbo");
    return { amount, type: "fbo" };
  };

  let result;
  if (knownType === "fbs") {
    try { result = await tryFbs(); } catch { result = await tryFbo(); }
  } else if (knownType === "fbo") {
    try { result = await tryFbo(); } catch { result = await tryFbs(); }
  } else {
    try { result = await tryFbs(); } catch { result = await tryFbo(); }
  }

  const out = { ...result, ts: Date.now() };
  postingAmountCache.set(postingNumber, out);
  return out;
}

async function mapLimit(items, limit, fn) {
  const res = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) break;
      try {
        res[idx] = await fn(items[idx], idx);
      } catch (e) {
        res[idx] = { __error: String(e?.message || e) };
      }
    }
  });
  await Promise.all(workers);
  return res;
}

// классификация по operation_type / operation_type_name
function classifyOperation(opType, opName) {
  const s = `${opType || ""} ${opName || ""}`.toLowerCase();
  if (s.includes("sale") || s.includes("продаж")) return "sale";
  if (s.includes("return") || s.includes("refund") || s.includes("cancel") || s.includes("возврат") || s.includes("отмен"))
    return "return";
  return "other";
}

async function listFinanceTransactionsForDate({ clientId, apiKey, dateStr }) {
  const { fromUtcIso, toUtcIso } = rangeForDate(dateStr);

  let page = 1;
  const page_size = 1000;
  const ops = [];

  while (true) {
    const body = {
      filter: {
        date: { from: fromUtcIso, to: toUtcIso },
        operation_type: [],
        posting_number: "",
        transaction_type: "", // <-- ВАЖНО: не фильтруем тип, чтобы не получить пусто
      },
      page,
      page_size,
    };

    const data = await ozonPost("/v3/finance/transaction/list", { clientId, apiKey, body });

    const result = data?.result || {};
    const chunk = result?.operations || [];
    ops.push(...chunk);

    const pageCount = Number(result?.page_count || 0);
    if (pageCount && page >= pageCount) break;
    if (!chunk || chunk.length < page_size) break;

    page += 1;
    if (page > 50) break;
  }

  // DEBUG: чтобы ты видел, что реально приходит
  if (ops.length) {
    const sample = ops.slice(0, 5).map(o => ({
      operation_type: o.operation_type,
      operation_type_name: o.operation_type_name,
      posting_number: o?.posting?.posting_number,
      delivery_schema: o?.posting?.delivery_schema
    }));
    console.log("Finance sample:", JSON.stringify(sample));
  } else {
    console.log("Finance: 0 operations for date", dateStr);
  }

  return ops;
}

async function getDailySalesAndReturns({ clientId, apiKey, dateStr }) {
  const ops = await listFinanceTransactionsForDate({ clientId, apiKey, dateStr });

  const salesNumbers = new Set();
  const returnNumbers = new Set();

  for (const o of ops) {
    // ✅ FIX: posting number inside o.posting.posting_number (как в ответе документации)
    const num = o?.posting?.posting_number;
    if (!num) continue;

    const cls = classifyOperation(o.operation_type, o.operation_type_name);
    if (cls === "sale") salesNumbers.add(num);
    else if (cls === "return") returnNumbers.add(num);
  }

  const salesArr = [...salesNumbers];
  const returnsArr = [...returnNumbers];

  const salesInfo = await mapLimit(salesArr, 8, (num) => getPostingAmountAndType({ clientId, apiKey, postingNumber: num }));
  const retInfo = await mapLimit(returnsArr, 8, (num) => getPostingAmountAndType({ clientId, apiKey, postingNumber: num }));

  let salesFbs = 0, salesFbo = 0, salesSum = 0;
  for (const r of salesInfo) {
    if (!r || typeof r.amount !== "number") continue;
    salesSum += r.amount;
    if (r.type === "fbs") salesFbs += 1;
    else if (r.type === "fbo") salesFbo += 1;
  }

  let retFbs = 0, retFbo = 0, retSum = 0;
  for (const r of retInfo) {
    if (!r || typeof r.amount !== "number") continue;
    retSum += r.amount;
    if (r.type === "fbs") retFbs += 1;
    else if (r.type === "fbo") retFbo += 1;
  }

  return {
    dateStr,
    salesFbs,
    salesFbo,
    salesTotal: salesFbs + salesFbo,
    salesSum,
    retFbs,
    retFbo,
    retTotal: retFbs + retFbo,
    retSum,
  };
}

// ---------------- widget ----------------
function moneyRub(x) {
  const v = Math.round(Number(x || 0) * 100) / 100;
  return v.toLocaleString("ru-RU");
}

function widgetText(s) {
  const net = s.salesSum - s.retSum;
  return [
    `📊 <b>События за дату</b>: <b>${s.dateStr}</b> (${SALES_TZ})`,
    ``,
    `🟢 Продаж (FBS): <b>${s.salesFbs}</b>`,
    `🟢 Продаж (FBO): <b>${s.salesFbo}</b>`,
    `🟢 Продаж всего: <b>${s.salesTotal}</b>`,
    ``,
    `🔴 Отмен/возвратов (FBS): <b>${s.retFbs}</b>`,
    `🔴 Отмен/возвратов (FBO): <b>${s.retFbo}</b>`,
    `🔴 Отмен/возвратов всего: <b>${s.retTotal}</b>`,
    ``,
    `💰 Сумма продаж (как в ЛК): <b>${moneyRub(s.salesSum)}</b> ₽`,
    `🔄 Сумма отмен/возвратов: <b>${moneyRub(s.retSum)}</b> ₽`,
    `📉 Итог: <b>${moneyRub(net)}</b> ₽`,
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
    const stats = await getDailySalesAndReturns({ clientId, apiKey, dateStr });
    const text = widgetText(stats);

    if (editMessageId) await tgEditMessage(chatId, editMessageId, text, widgetKeyboard(dateStr));
    else await tgSendMessage(chatId, text, widgetKeyboard(dateStr));
  } catch (e) {
    const msg =
      `❌ Не смог получить события/суммы за <b>${dateStr}</b>.\n\n` +
      `<code>${String(e.message || e)}</code>`;
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
        await tgSendMessage(chatId, "✅ Ключи уже сохранены. Показываю виджет за сегодня:");
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

    if (text.startsWith("/date")) {
      const parts = text.split(/\s+/);
      const dateStr = parts[1];
      if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        await tgSendMessage(chatId, "Формат: <code>/date YYYY-MM-DD</code>\nПример: <code>/date 2025-12-13</code>");
        return;
      }
      await showWidget(chatId, userId, dateStr);
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
      await tgSendMessage(chatId, "✅ Сохранил. Открываю виджет за сегодня:");
      await showWidget(chatId, userId, todayDateStr());
      return;
    }

    await tgSendMessage(chatId, "Команды:\n/start\n/date YYYY-MM-DD\n/reset");
  } catch (err) {
    console.error("Webhook handler error:", err);
  }
});

app.listen(PORT, () => console.log(`✅ Server started on :${PORT}`));
