import express from "express";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { DateTime } from "luxon";

const app = express();
app.use(express.json());

app.get("/", (req, res) => res.status(200).send("OK"));
app.get("/index.html", (req, res) => res.status(200).send("OK"));
app.get("/health", (req, res) => res.status(200).json({ status: "ok" }));

const PORT = process.env.PORT || 8080;
const BOT_TOKEN = process.env.BOT_TOKEN;

const OZON_API_BASE = process.env.OZON_API_BASE || "https://api-seller.ozon.ru";
const SALES_TZ = process.env.SALES_TZ || "Europe/Moscow";

const DATA_DIR = process.env.DATA_DIR || ".";
const STORE_PATH = path.join(DATA_DIR, "store.json");

const ENCRYPTION_KEY_B64 = process.env.ENCRYPTION_KEY_B64;

const pending = new Map();

// caches
const postingTypeCache = new Map();      // posting_number -> 'fbs'|'fbo'
const postingAmountCache = new Map();    // posting_number -> { amount, type, ts }
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
  if (!data?.ok) {
    const descr = String(data?.description || "");
    if (!descr.includes("message is not modified")) console.error("❌ editMessageText failed:", data);
  }
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
  const toIso = (dt) => dt.toUTC().toISO({ suppressMilliseconds: true });
  return {
    dateStr,
    fromUtcIso: toIso(from),
    toUtcIso: toIso(to),
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

// ---------------- Finance: get operations for day ----------------
async function listFinanceOperationsForDate({ clientId, apiKey, dateStr }) {
  const { fromUtcIso, toUtcIso } = rangeForDate(dateStr);

  let page = 1;
  const page_size = 1000;
  const ops = [];

  while (true) {
    const data = await ozonPost("/v3/finance/transaction/list", {
      clientId,
      apiKey,
      body: {
        filter: {
          date: { from: fromUtcIso, to: toUtcIso },
          operation_type: [],
          posting_number: "",
          transaction_type: "",
        },
        page,
        page_size,
      },
    });

    const result = data?.result || {};
    const chunk = result?.operations || [];
    ops.push(...chunk);

    const pageCount = Number(result?.page_count || 0);
    if (pageCount && page >= pageCount) break;
    if (!chunk || chunk.length < page_size) break;

    page += 1;
    if (page > 50) break;
  }

  return ops;
}

function isCancelOrReturn(opType, opName) {
  const s = `${opType || ""} ${opName || ""}`.toLowerCase();
  return (
    s.includes("return") ||
    s.includes("refund") ||
    s.includes("cancel") ||
    s.includes("возврат") ||
    s.includes("отмен")
  );
}

// чтобы не посчитать “услуги/комиссии/доставку” как заказ:
function isServiceLike(opType, opName) {
  const s = `${opType || ""} ${opName || ""}`.toLowerCase();
  return (
    s.includes("service") ||
    s.includes("fee") ||
    s.includes("commission") ||
    s.includes("delivery") ||
    s.includes("logistic") ||
    s.includes("storage") ||
    s.includes("fulfillment") ||
    s.includes("acquiring") ||
    s.includes("комисс") ||
    s.includes("услуг") ||
    s.includes("достав") ||
    s.includes("логист") ||
    s.includes("хранен")
  );
}

// “заказ поступил” по finance: есть posting_number, не отмена/возврат, не услуга.
function isOrderEvent(opType, opName) {
  if (isCancelOrReturn(opType, opName)) return false;
  if (isServiceLike(opType, opName)) return false;
  // на всякий — многие операции называются sale/заказ/начисление
  const s = `${opType || ""} ${opName || ""}`.toLowerCase();
  if (s.includes("sale") || s.includes("order") || s.includes("заказ") || s.includes("начисл") || s.includes("выручк")) {
    return true;
  }
  // fallback: если это не услуга и не отмена, считаем как “событие заказа”
  return true;
}

async function getDailyOrdersAndCancels({ clientId, apiKey, dateStr }) {
  const ops = await listFinanceOperationsForDate({ clientId, apiKey, dateStr });

  const orderNums = new Set();
  const cancelNums = new Set();

  for (const o of ops) {
    const num = o?.posting?.posting_number;
    if (!num) continue;

    if (isCancelOrReturn(o.operation_type, o.operation_type_name)) cancelNums.add(num);
    else if (isOrderEvent(o.operation_type, o.operation_type_name)) orderNums.add(num);
  }

  const ordersArr = [...orderNums];
  const cancelsArr = [...cancelNums];

  // суммы “как в ЛК рядом с заказом”
  const ordersInfo = await mapLimit(ordersArr, 8, (n) =>
    getPostingAmountAndType({ clientId, apiKey, postingNumber: n })
  );
  const cancelsInfo = await mapLimit(cancelsArr, 8, (n) =>
    getPostingAmountAndType({ clientId, apiKey, postingNumber: n })
  );

  let ordersFbs = 0, ordersFbo = 0, ordersSum = 0;
  for (const r of ordersInfo) {
    if (!r || typeof r.amount !== "number") continue;
    ordersSum += r.amount;
    if (r.type === "fbs") ordersFbs += 1;
    else if (r.type === "fbo") ordersFbo += 1;
  }

  let cancelsFbs = 0, cancelsFbo = 0, cancelsSum = 0;
  for (const r of cancelsInfo) {
    if (!r || typeof r.amount !== "number") continue;
    cancelsSum += r.amount;
    if (r.type === "fbs") cancelsFbs += 1;
    else if (r.type === "fbo") cancelsFbo += 1;
  }

  const ordersTotal = ordersFbs + ordersFbo;
  const cancelsTotal = cancelsFbs + cancelsFbo;

  return {
    dateStr,
    ordersFbs,
    ordersFbo,
    ordersTotal,
    ordersSumTotal: ordersSum,
    cancelsFbs,
    cancelsFbo,
    cancelsTotal,
    cancelsSumTotal: cancelsSum,
    netOrders: ordersTotal - cancelsTotal,
    netSum: ordersSum - cancelsSum,
  };
}

// ---------------- widget ----------------
function moneyRub(x) {
  const v = Math.round(Number(x || 0) * 100) / 100;
  return v.toLocaleString("ru-RU");
}

function widgetText(s) {
  return [
    `📅 <b>Заказы за дату</b>: <b>${s.dateStr}</b> (${SALES_TZ})`,
    ``,
    `📥 Заказы поступили (FBS): <b>${s.ordersFbs}</b>`,
    `📥 Заказы поступили (FBO): <b>${s.ordersFbo}</b>`,
    `📥 Заказы поступили всего: <b>${s.ordersTotal}</b>`,
    `💰 Сумма заказов: <b>${moneyRub(s.ordersSumTotal)}</b> ₽`,
    ``,
    `❌ Отмены/возвраты (FBS): <b>${s.cancelsFbs}</b>`,
    `❌ Отмены/возвраты (FBO): <b>${s.cancelsFbo}</b>`,
    `❌ Отмены/возвраты всего: <b>${s.cancelsTotal}</b>`,
    `🔄 Сумма отмен/возвратов: <b>${moneyRub(s.cancelsSumTotal)}</b> ₽`,
    ``,
    `✅ Актуально заказов (поступило − отмены): <b>${s.netOrders}</b>`,
    `✅ Актуальная сумма (заказы − отмены): <b>${moneyRub(s.netSum)}</b> ₽`,
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
    const stats = await getDailyOrdersAndCancels({ clientId, apiKey, dateStr });
    const text = widgetText(stats);

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
        await tgSendMessage(chatId, "✅ Ключи уже сохранены. Показываю заказы за сегодня:");
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
      await tgSendMessage(chatId, "✅ Сохранил. Открываю заказы за сегодня:");
      await showWidget(chatId, userId, todayDateStr());
      return;
    }

    await tgSendMessage(chatId, "Команды:\n/start\n/date YYYY-MM-DD\n/reset");
  } catch (err) {
    console.error("Webhook handler error:", err);
  }
});

app.listen(PORT, () => console.log(`✅ Server started on :${PORT}`));
