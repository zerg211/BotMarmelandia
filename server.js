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

// Ширина окна, чтобы Ozon точно отдавал postings (иначе часто 0)
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS || 30);

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

// ---------------- date helpers ----------------
function todayDateStr() {
  return DateTime.now().setZone(SALES_TZ).toFormat("yyyy-LL-dd");
}

function isoWithMillis(dt) {
  // Ozon иногда капризничает без миллисекунд
  return dt.toUTC().toISO({ suppressMilliseconds: false });
}

function wideSinceToUTC(dateStr) {
  const dayStart = DateTime.fromFormat(dateStr, "yyyy-LL-dd", { zone: SALES_TZ }).startOf("day");
  const dayEnd = DateTime.fromFormat(dateStr, "yyyy-LL-dd", { zone: SALES_TZ }).endOf("day");

  // расширяем окно назад, чтобы точно “зацепить” postings
  const since = isoWithMillis(dayStart.minus({ days: LOOKBACK_DAYS }));
  const to = isoWithMillis(dayEnd.plus({ days: 1 })); // +1 день на всякий случай

  return { since, to };
}

function isSameDayInTZ(iso, dateStr) {
  if (!iso) return false;
  const d = DateTime.fromISO(iso, { setZone: true }).setZone(SALES_TZ);
  return d.isValid && d.toFormat("yyyy-LL-dd") === dateStr;
}

function pickBestCreatedISO(p) {
  // главное — created_at, иначе fallback
  return p?.created_at || p?.in_process_at || p?.shipment_date || null;
}

// ---------------- Core: load FBO postings ----------------
async function listFboPostingsWide({ clientId, apiKey, dateStr, status }) {
  const { since, to } = wideSinceToUTC(dateStr);

  let offset = 0;
  const limit = 1000;
  const postings = [];

  while (true) {
    const filter = { since, to };
    // статус добавляем только если явно указан
    if (status) filter.status = status;

    const data = await ozonPost("/v2/posting/fbo/list", {
      clientId,
      apiKey,
      body: {
        dir: "asc",
        filter,
        limit,
        offset,
        with: { financial_data: false },
      },
    });

    const result = data?.result || {};
    const page = result?.postings || [];
    postings.push(...page);

    if (!result?.has_next) break;
    offset += limit;
    if (offset > 200000) break;
  }

  return postings;
}

async function countFboOrdersArrivedToday({ clientId, apiKey, dateStr }) {
  // 1) обычные статусы
  const base = await listFboPostingsWide({ clientId, apiKey, dateStr });

  // 2) пробуем отдельно cancelled (если метод принимает)
  let cancelled = [];
  try {
    cancelled = await listFboPostingsWide({ clientId, apiKey, dateStr, status: "cancelled" });
  } catch (e) {
    // если Ozon не принимает status=cancelled — просто игнорируем
    console.warn("⚠️ cancelled fetch skipped:", String(e.message || e));
  }

  // Объединяем по posting_number
  const map = new Map();
  for (const p of [...base, ...cancelled]) {
    if (p?.posting_number) map.set(p.posting_number, p);
  }

  // Фильтруем “сегодня” по created_at (если есть), иначе fallback
  let totalToday = 0;
  for (const p of map.values()) {
    const iso = pickBestCreatedISO(p);
    if (isSameDayInTZ(iso, dateStr)) totalToday += 1;
  }

  // Debug в логи: покажем 3 примера, чтобы понять какими датами Ozon реально отдаёт
  const samples = [];
  for (const p of map.values()) {
    if (samples.length >= 3) break;
    samples.push({
      posting_number: p.posting_number,
      status: p.status,
      created_at: p.created_at,
      in_process_at: p.in_process_at,
      shipment_date: p.shipment_date,
    });
  }
  console.log("🔎 FBO samples:", JSON.stringify(samples, null, 2));

  return totalToday;
}

// ---------------- widget ----------------
function widgetText(c) {
  return [
    `📅 <b>FBO: поступившие заказы сегодня</b>: <b>${c.dateStr}</b> (${SALES_TZ})`,
    `ℹ️ Отмены <b>не вычитаем</b>`,
    ``,
    `✅ Кол-во заказов: <b>${c.total}</b>`,
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
    const total = await countFboOrdersArrivedToday({ clientId, apiKey, dateStr });
    const text = widgetText({ dateStr, total });

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
        await tgSendMessage(chatId, "✅ Ключи уже сохранены. Показываю FBO заказы за сегодня:");
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
      await tgSendMessage(chatId, "✅ Сохранил. Открываю FBO заказы за сегодня:");
      await showWidget(chatId, userId, todayDateStr());
      return;
    }

    await tgSendMessage(chatId, "Команды:\n/start\n/reset");
  } catch (err) {
    console.error("Webhook handler error:", err);
  }
});

app.listen(PORT, () => console.log(`✅ Server started on :${PORT}`));
