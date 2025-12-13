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

// Хранилище ключей (файл)
// ⚠️ На Railway при пересборке может обнулиться. Если нужно “навсегда” — подключим Postgres.
const DATA_DIR = process.env.DATA_DIR || ".";
const STORE_PATH = path.join(DATA_DIR, "store.json");

// Шифрование Api-Key (рекомендую задать ENCRYPTION_KEY_B64 в Railway Variables)
const ENCRYPTION_KEY_B64 = process.env.ENCRYPTION_KEY_B64;

// --- state диалога ввода ключей ---
const pending = new Map(); // userId -> { step: 'clientId'|'apiKey', clientId? }

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

// --- Telegram helpers ---
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

// --- Ozon helpers ---
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

function isoRangeForDate(dateStr /* yyyy-LL-dd */) {
  const from = DateTime.fromFormat(dateStr, "yyyy-LL-dd", { zone: SALES_TZ }).startOf("day");
  const to = DateTime.fromFormat(dateStr, "yyyy-LL-dd", { zone: SALES_TZ }).endOf("day");

  return {
    dateStr,
    from,
    to,
    sinceISO: from.toUTC().toISO({ suppressMilliseconds: true }),
    toISO: to.toUTC().toISO({ suppressMilliseconds: true }),
  };
}

function safeNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

// Пытаемся достать “сумму заказа” из финансовых данных постинга.
// У Ozon поля могут отличаться, поэтому делаем несколько fallback-ов.
function calcPostingAmountFromFinancial(financialData) {
  if (!financialData) return 0;

  // Иногда есть итоговые поля на уровне posting_services / payout и т.д.
  // Но самое стабильное — суммировать продукты.
  const products = financialData.products || [];
  let sum = 0;

  for (const p of products) {
    const qty =
      safeNum(p.quantity) ||
      safeNum(p.qty) ||
      1;

    // приоритет: price -> item_price -> customer_price -> payout
    const unit =
      safeNum(p.price) ||
      safeNum(p.item_price) ||
      safeNum(p.customer_price) ||
      safeNum(p.payout);

    sum += unit * qty;
  }

  // Иногда products пустой, но есть total/amount
  if (sum === 0) {
    sum =
      safeNum(financialData.total) ||
      safeNum(financialData.amount) ||
      safeNum(financialData.payout) ||
      0;
  }

  return sum;
}

async function listFbsPostings({ clientId, apiKey, sinceISO, toISO }) {
  let offset = 0;
  const limit = 50;
  const postings = [];

  while (true) {
    const data = await ozonPost("/v3/posting/fbs/list", {
      clientId,
      apiKey,
      body: {
        filter: {
          since: sinceISO,
          to: toISO,
          // статус не ограничиваем — нужны все созданные сегодня
        },
        limit,
        offset,
        with: {
          financial_data: false, // суммы возьмём точнее через /get
        },
      },
    });

    const result = data?.result;
    const chunk = result?.postings || [];
    postings.push(...chunk);

    if (!result?.has_next) break;
    offset += limit;
    if (offset > 5000) break; // защита от бесконечности
  }

  return postings;
}

async function listFboPostings({ clientId, apiKey, sinceISO, toISO }) {
  let offset = 0;
  const limit = 50;
  const postings = [];

  while (true) {
    const data = await ozonPost("/v2/posting/fbo/list", {
      clientId,
      apiKey,
      body: {
        filter: {
          since: sinceISO,
          to: toISO,
        },
        limit,
        offset,
        with: {
          financial_data: false,
        },
      },
    });

    const result = data?.result;
    const chunk = result?.postings || [];
    postings.push(...chunk);

    if (!result?.has_next) break;
    offset += limit;
    if (offset > 5000) break;
  }

  return postings;
}

async function getFbsPostingAmount({ clientId, apiKey, postingNumber }) {
  const data = await ozonPost("/v3/posting/fbs/get", {
    clientId,
    apiKey,
    body: {
      posting_number: postingNumber,
      with: { financial_data: true },
    },
  });

  const fin = data?.result?.financial_data;
  return calcPostingAmountFromFinancial(fin);
}

async function getFboPostingAmount({ clientId, apiKey, postingNumber }) {
  const data = await ozonPost("/v2/posting/fbo/get", {
    clientId,
    apiKey,
    body: {
      posting_number: postingNumber,
      with: { financial_data: true },
    },
  });

  const fin = data?.result?.financial_data;
  return calcPostingAmountFromFinancial(fin);
}

// Ограничиваем параллелизм, чтобы не уложить API
async function mapLimit(items, limit, fn) {
  const res = [];
  let i = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
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

async function getSalesForDate({ clientId, apiKey, dateStr }) {
  const { from, to, sinceISO, toISO } = isoRangeForDate(dateStr);

  // 1) получаем список постингов за дату
  const [fbsList, fboList] = await Promise.all([
    listFbsPostings({ clientId, apiKey, sinceISO, toISO }),
    listFboPostings({ clientId, apiKey, sinceISO, toISO }),
  ]);

  const fbsNumbers = [...new Set(fbsList.map((p) => p.posting_number).filter(Boolean))];
  const fboNumbers = [...new Set(fboList.map((p) => p.posting_number).filter(Boolean))];

  // 2) по каждому постингу тянем детализацию и считаем сумму
  const fbsAmounts = await mapLimit(fbsNumbers, 8, async (num) =>
    getFbsPostingAmount({ clientId, apiKey, postingNumber: num })
  );
  const fboAmounts = await mapLimit(fboNumbers, 8, async (num) =>
    getFboPostingAmount({ clientId, apiKey, postingNumber: num })
  );

  const sumFbs = fbsAmounts.reduce((acc, x) => acc + (typeof x === "number" ? x : 0), 0);
  const sumFbo = fboAmounts.reduce((acc, x) => acc + (typeof x === "number" ? x : 0), 0);

  return {
    dateStr,
    from,
    to: DateTime.now().setZone(SALES_TZ),
    ordersFbs: fbsNumbers.length,
    ordersFbo: fboNumbers.length,
    sumFbs,
    sumFbo,
  };
}

// --- UI ---
function moneyRub(x) {
  const v = Math.round(safeNum(x) * 100) / 100;
  return v.toLocaleString("ru-RU");
}

function widgetText(s) {
  const totalOrders = s.ordersFbs + s.ordersFbo;
  const totalSum = s.sumFbs + s.sumFbo;

  return [
    `📊 <b>Заказы за дату</b>: <b>${s.dateStr}</b> (${SALES_TZ})`,
    ``,
    `🧾 FBS заказов: <b>${s.ordersFbs}</b>`,
    `🧾 FBO заказов: <b>${s.ordersFbo}</b>`,
    `🧾 Всего заказов: <b>${totalOrders}</b>`,
    ``,
    `💰 Сумма FBS: <b>${moneyRub(s.sumFbs)}</b> ₽`,
    `💰 Сумма FBO: <b>${moneyRub(s.sumFbo)}</b> ₽`,
    `💰 Итого сумма: <b>${moneyRub(totalSum)}</b> ₽`,
    ``,
    `Обновлено: ${s.to.toFormat("HH:mm:ss")}`,
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
    await tgSendMessage(
      chatId,
      "❗ Ключи Ozon не настроены.\n\nНапиши /start — и я попрошу Client ID и Api-Key."
    );
    return;
  }

  const apiKey = decrypt(creds.apiKey);
  const clientId = creds.clientId;

  try {
    const stats = await getSalesForDate({ clientId, apiKey, dateStr });
    const text = widgetText(stats);

    if (editMessageId) {
      await tgEditMessage(chatId, editMessageId, text, widgetKeyboard(dateStr));
    } else {
      await tgSendMessage(chatId, text, widgetKeyboard(dateStr));
    }
  } catch (e) {
    const msg =
      `❌ Не смог получить заказы/сумму за дату <b>${dateStr}</b>.\n` +
      `Проверь Client ID / Api-Key.\n\n` +
      `<code>${String(e.message || e)}</code>`;

    if (editMessageId) {
      await tgEditMessage(chatId, editMessageId, msg, widgetKeyboard(dateStr));
    } else {
      await tgSendMessage(chatId, msg, widgetKeyboard(dateStr));
    }
  }
}

function todayDateStr() {
  return DateTime.now().setZone(SALES_TZ).toFormat("yyyy-LL-dd");
}

// --- Telegram webhook ---
app.post("/telegram-webhook", async (req, res) => {
  // Telegram должен быстро получить 200
  res.sendStatus(200);

  try {
    const update = req.body;

    const msg = update?.message;
    const cb = update?.callback_query;

    // --- callbacks ---
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
        await tgEditMessage(chatId, messageId, "🔑 Ок, давай заново.\n\nОтправь <b>Client ID</b>.");
        return;
      }

      return;
    }

    // --- messages ---
    const chatId = msg?.chat?.id;
    const userId = msg?.from?.id;
    const text = msg?.text?.trim();

    if (!chatId || !userId || !text) return;

    if (text === "/reset") {
      deleteUserCreds(userId);
      pending.set(userId, { step: "clientId" });
      await tgSendMessage(chatId, "Ок. Отправь <b>Client ID</b>.");
      return;
    }

    if (text === "/start") {
      const creds = getUserCreds(userId);
      if (creds?.clientId && creds?.apiKey) {
        await tgSendMessage(chatId, "✅ Ключи уже сохранены. Показываю виджет за сегодня:");
        await showWidget(chatId, userId, todayDateStr());
        return;
      }
      pending.set(userId, { step: "clientId" });
      await tgSendMessage(
        chatId,
        "Привет! Настроим доступ к Ozon.\n\nОтправь <b>Client ID</b>."
      );
      return;
    }

    // /date YYYY-MM-DD
    if (text.startsWith("/date")) {
      const parts = text.split(/\s+/);
      const dateStr = parts[1];
      if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        await tgSendMessage(chatId, "Формат: <code>/date YYYY-MM-DD</code>\nНапример: <code>/date 2025-12-13</code>");
        return;
      }
      await showWidget(chatId, userId, dateStr);
      return;
    }

    // ввод ключей пошагово
    const st = pending.get(userId);
    if (st?.step === "clientId") {
      pending.set(userId, { step: "apiKey", clientId: text });
      await tgSendMessage(chatId, "Теперь отправь <b>Api-Key</b>.");
      return;
    }
    if (st?.step === "apiKey") {
      const clientId = st.clientId;
      const apiKeyEnc = encrypt(text);

      setUserCreds(userId, { clientId, apiKey: apiKeyEnc, savedAt: Date.now() });
      pending.delete(userId);

      await tgSendMessage(chatId, "✅ Сохранил. Открываю виджет за сегодня:");
      await showWidget(chatId, userId, todayDateStr());
      return;
    }

    // по умолчанию
    await tgSendMessage(
      chatId,
      "Команды:\n/start — настройка и виджет за сегодня\n/date YYYY-MM-DD — статистика за дату\n/reset — заново ввести ключи"
    );
  } catch (err) {
    console.error("Webhook handler error:", err);
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server started on :${PORT}`);
});
