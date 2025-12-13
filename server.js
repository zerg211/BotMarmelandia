import express from "express";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { DateTime } from "luxon";

const app = express();
app.use(express.json());

// --- Health routes (браузер будет видеть OK — это нормально) ---
app.get("/", (req, res) => res.status(200).send("OK"));
app.get("/index.html", (req, res) => res.status(200).send("OK"));
app.get("/health", (req, res) => res.status(200).json({ status: "ok" }));

const PORT = process.env.PORT || 8080;
const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL; // уже работает
const OZON_API_BASE = process.env.OZON_API_BASE || "https://api-seller.ozon.ru";
const SALES_TZ = process.env.SALES_TZ || "Europe/Moscow";

// Для “запоминания” ключей (файл в контейнере)
// ⚠️ На некоторых деплоях/пересборках Railway файл может обнуляться.
// Если нужно 100% навсегда — сделаем хранение в Postgres/Redis.
const DATA_DIR = process.env.DATA_DIR || ".";
const STORE_PATH = path.join(DATA_DIR, "store.json");

// Шифрование ключа (чтобы не хранить Api-Key открытым текстом)
const ENCRYPTION_KEY_B64 = process.env.ENCRYPTION_KEY_B64; // 32 bytes base64 желательно

// --- простое хранилище + state диалога ---
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
  // Если ключа шифрования нет — храним как есть (но лучше поставить ENCRYPTION_KEY_B64)
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

// --- OZON: продажи за сегодня ---
async function ozonAnalyticsToday({ clientId, apiKey }) {
  // /v1/analytics/data — метрики revenue и ordered_units доступны всем (без Premium тоже) :contentReference[oaicite:0]{index=0}
  const dtFrom = DateTime.now().setZone(SALES_TZ).startOf("day");
  const dtTo = DateTime.now().setZone(SALES_TZ);

  const body = {
    date_from: dtFrom.toUTC().toISO({ suppressMilliseconds: true }),
    date_to: dtTo.toUTC().toISO({ suppressMilliseconds: true }),
    metrics: ["revenue", "ordered_units"],
    dimension: ["day"],
    filters: [],
    sort: [],
    limit: 1000,
    offset: 0,
  };

  const resp = await fetch(`${OZON_API_BASE}/v1/analytics/data`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Client-Id": String(clientId),
      "Api-Key": String(apiKey),
    },
    body: JSON.stringify(body),
  });

  const data = await resp.json().catch(() => null);

  if (!resp.ok || !data?.result) {
    const msg = data?.message || data?.error || JSON.stringify(data);
    throw new Error(`Ozon API error (${resp.status}): ${msg}`);
  }

  // Ожидаем result.data: [{dimensions:[...], metrics:[revenue, ordered_units]}]
  // Если dimension=["day"], то обычно 1 строка на текущий день (или несколько — зависит от ответа).
  const rows = data.result?.data || data.result || [];
  let revenue = 0;
  let orderedUnits = 0;

  for (const r of rows) {
    if (Array.isArray(r.metrics)) {
      revenue += Number(r.metrics[0] || 0);
      orderedUnits += Number(r.metrics[1] || 0);
    }
  }

  return { revenue, orderedUnits, from: dtFrom, to: dtTo };
}

function widgetText({ revenue, orderedUnits, from, to }) {
  return [
    `📊 <b>Продажи за сегодня</b> (${from.toFormat("dd.LL.yyyy")} ${SALES_TZ})`,
    ``,
    `🧾 Заказано товаров: <b>${orderedUnits}</b>`,
    `💰 Выручка (revenue): <b>${Math.round(revenue * 100) / 100}</b>`,
    ``,
    `Обновлено: ${to.toFormat("HH:mm:ss")}`,
  ].join("\n");
}

function widgetKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: "🔄 Обновить", callback_data: "refresh_today" }],
        [{ text: "🔑 Сменить ключи", callback_data: "reset_keys" }],
      ],
    },
  };
}

async function showWidget(chatId, userId, editMessageId = null) {
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
    const stats = await ozonAnalyticsToday({ clientId, apiKey });
    const text = widgetText(stats);

    if (editMessageId) {
      await tgEditMessage(chatId, editMessageId, text, widgetKeyboard());
    } else {
      await tgSendMessage(chatId, text, widgetKeyboard());
    }
  } catch (e) {
    const msg =
      `❌ Не смог получить продажи за сегодня.\n` +
      `Проверь Client ID / Api-Key.\n\n` +
      `<code>${String(e.message || e)}</code>`;
    if (editMessageId) {
      await tgEditMessage(chatId, editMessageId, msg, widgetKeyboard());
    } else {
      await tgSendMessage(chatId, msg, widgetKeyboard());
    }
  }
}

// --- Telegram webhook ---
app.post("/telegram-webhook", async (req, res) => {
  // Telegram должен быстро получить 200
  res.sendStatus(200);

  try {
    const update = req.body;
    console.log("TG update:", JSON.stringify(update));

    const msg = update?.message;
    const cb = update?.callback_query;

    // --- callbacks (кнопки) ---
    if (cb) {
      const chatId = cb.message?.chat?.id;
      const userId = cb.from?.id;
      const messageId = cb.message?.message_id;
      const data = cb.data;

      await tgAnswerCallback(cb.id);

      if (!chatId || !userId) return;

      if (data === "refresh_today") {
        await showWidget(chatId, userId, messageId);
        return;
      }
      if (data === "reset_keys") {
        deleteUserCreds(userId);
        pending.set(userId, { step: "clientId" });
        await tgEditMessage(
          chatId,
          messageId,
          "🔑 Ок, давай заново.\n\nОтправь <b>Client ID</b> (число)."
        );
        return;
      }
      return;
    }

    // --- обычные сообщения ---
    const chatId = msg?.chat?.id;
    const userId = msg?.from?.id;
    const text = msg?.text?.trim();

    if (!chatId || !userId || !text) return;

    // /reset — принудительно переспросить ключи
    if (text === "/reset") {
      deleteUserCreds(userId);
      pending.set(userId, { step: "clientId" });
      await tgSendMessage(chatId, "Ок. Отправь <b>Client ID</b> (число).");
      return;
    }

    // /start — либо просим ключи, либо показываем виджет
    if (text === "/start") {
      const creds = getUserCreds(userId);
      if (creds?.clientId && creds?.apiKey) {
        await tgSendMessage(chatId, "✅ Ключи уже сохранены. Показываю виджет:");
        await showWidget(chatId, userId);
        return;
      }
      pending.set(userId, { step: "clientId" });
      await tgSendMessage(
        chatId,
        "Привет! Сначала настроим доступ к Ozon.\n\nОтправь <b>Client ID</b> (число)."
      );
      return;
    }

    // Если мы в процессе ввода ключей
    const st = pending.get(userId);
    if (st?.step === "clientId") {
      // принимаем любое, но обычно число
      pending.set(userId, { step: "apiKey", clientId: text });
      await tgSendMessage(chatId, "Теперь отправь <b>Api-Key</b> (ключ доступа).");
      return;
    }
    if (st?.step === "apiKey") {
      const clientId = st.clientId;
      const apiKeyEnc = encrypt(text);

      setUserCreds(userId, { clientId, apiKey: apiKeyEnc, savedAt: Date.now() });
      pending.delete(userId);

      await tgSendMessage(chatId, "✅ Сохранил. Открываю виджет продаж за сегодня:");
      await showWidget(chatId, userId);
      return;
    }

    // Если ключи сохранены — можно просто показывать виджет по любому сообщению (или по команде)
    if (text === "/today") {
      await showWidget(chatId, userId);
      return;
    }

    // По умолчанию — подсказка
    await tgSendMessage(
      chatId,
      "Команды:\n/start — настройка и виджет\n/today — продажи за сегодня\n/reset — заново ввести Client ID и Api-Key"
    );
  } catch (err) {
    console.error("Webhook handler error:", err);
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server started on :${PORT}`);
  // Webhook ты уже ставишь — поэтому тут можно ничего не делать
  // (оставляю молча, чтобы не ломать то, что работает)
});
