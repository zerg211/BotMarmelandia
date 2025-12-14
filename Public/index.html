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


// ---------------- Core: buyouts (delivered today) + returns (today) ----------------
async function fetchFboAllForPeriod({ clientId, apiKey, sinceIso, toIso }) {
  let offset = 0;
  const limit = 1000;
  const all = [];

  while (true) {
    const body = {
      dir: "ASC",
      filter: { since: sinceIso, to: toIso, status: "delivered" },
      limit,
      offset,
      translit: true,
      with: { analytics_data: true, financial_data: false, legal_info: false },
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

function pickDeliveredIso(posting) {
  // Считаем момент "выкупа" как момент смены статуса на DELIVERED (обычно это status_updated_at).
  // Поля в разных версиях API могут отличаться — пробуем максимально широко.
  return (
    posting?.status_updated_at ||
    posting?.delivered_at ||
    posting?.analytics_data?.delivered_at ||
    posting?.analytics_data?.delivering_date ||
    posting?.analytics_data?.delivery_date ||
    posting?.analytics_data?.shipment_date ||
    posting?.delivering_date ||
    posting?.delivery_date ||
    null
  );
}

async function calcBuyoutsTodayByOffer({ clientId, apiKey, dateStr }) {
  // "Выкуплено сегодня" = отправления, у которых СТАТУС сменился на DELIVERED сегодня (по МСК).
  // Важно: /v2/posting/fbo/list фильтрует по created_at, поэтому берём широкий диапазон по созданию
  // и уже в коде отбираем по статусным датам.
  const day = DateTime.fromFormat(dateStr, "yyyy-LL-dd", { zone: SALES_TZ });
  const sinceCreated = day.minus({ days: 30 }).startOf("day").toUTC().toISO({ suppressMilliseconds: false });
  const toCreated = day.endOf("day").toUTC().toISO({ suppressMilliseconds: false });

  let offset = 0;
  const limit = 1000;

  const byOffer = new Map();
  let totalQty = 0;

  while (true) {
    const body = {
      dir: "ASC",
      filter: { since: sinceCreated, to: toCreated, status: "" },
      limit,
      offset,
      translit: true,
      with: { analytics_data: true, financial_data: false, legal_info: false },
    };

    const data = await ozonPost("/v2/posting/fbo/list", { clientId, apiKey, body });
    const { postings, hasNext } = extractPostings(data);

    for (const p of postings) {
      // берём момент смены статуса на delivered
      const deliveredIso = pickDeliveredIso(p);
      if (!isSameDayLocal(deliveredIso, dateStr)) continue;
      if (String(p?.status || "").toLowerCase() !== "delivered") continue;

      for (const pr of p?.products || []) {
        const offerId = pr?.offer_id != null ? String(pr.offer_id) : null;
        const qty = Number(pr?.quantity || 0) || 0;
        if (!offerId || qty <= 0) continue;

        totalQty += qty;
        byOffer.set(offerId, (byOffer.get(offerId) || 0) + qty);
      }
    }

    if (!hasNext) break;
    offset += limit;
    if (offset > 200000) break;
  }

  const list = Array.from(byOffer.entries())
    .map(([offer_id, qty]) => ({ offer_id, qty }))
    .sort((a, b) => b.qty - a.qty);

  return { buyouts_total_qty: totalQty, buyouts_list: list };
}

async function calcReturnsTodayByOffer({ clientId, apiKey, dateStr }) {
  // Возвраты сегодня: /v1/returns/list требует filter.status, но "all" у некоторых аккаунтов не работает.
  // Поэтому передаём status = "" (как "все"), и берём широкий период, затем фильтруем по дате обновления.
  const day = DateTime.fromFormat(dateStr, "yyyy-LL-dd", { zone: SALES_TZ });
  const fromStr = day.minus({ days: 30 }).toFormat("yyyy-LL-dd");
  const toStr = day.toFormat("yyyy-LL-dd");

  const byOffer = new Map();
  let totalQty = 0;

  let offset = 0;
  const limit = 1000;

  while (true) {
    const body = {
      filter: { date_from: fromStr, date_to: toStr, status: "" },
      limit,
      offset,
    };

    const data = await ozonPost("/v1/returns/list", { clientId, apiKey, body });

    const root = data?.result ?? data ?? {};
    const items =
      root?.returns ||
      root?.items ||
      root?.result ||
      root ||
      [];

    const arr = Array.isArray(items) ? items : [];
    if (arr.length === 0) break;

    for (const r of arr) {
      // дата изменения статуса/обновления
      const iso =
        r?.updated_at ||
        r?.status_updated_at ||
        r?.last_updated_at ||
        r?.last_changed_at ||
        r?.created_at ||
        null;

      if (!isSameDayLocal(iso, dateStr)) continue;

      const prods = Array.isArray(r?.products) ? r.products : [];
      if (prods.length) {
        for (const pr of prods) {
          const offerId = pr?.offer_id != null ? String(pr.offer_id) : null;
          const qty = Number(pr?.quantity || 0) || 0;
          if (!offerId || qty <= 0) continue;

          totalQty += qty;
          byOffer.set(offerId, (byOffer.get(offerId) || 0) + qty);
        }
      } else {
        // fallback если products нет
        const offerId = r?.offer_id != null ? String(r.offer_id) : null;
        const qty = Number(r?.quantity || 0) || 0;
        if (!offerId || qty <= 0) continue;

        totalQty += qty;
        byOffer.set(offerId, (byOffer.get(offerId) || 0) + qty);
      }
    }

    offset += limit;
    if (arr.length < limit) break;
  }

  const list = Array.from(byOffer.entries())
    .map(([offer_id, qty]) => ({ offer_id, qty }))
    .sort((a, b) => b.qty - a.qty);

  return { returns_total_qty: totalQty, returns_list: list };
}



// ---------------- Core: balance (today) ----------------
async function calcBalanceToday({ clientId, apiKey, dateStr }) {
  // Самый прямой метод (у тебя он работает): /v1/finance/balance
  // Запрос должен быть в формате YYYY-MM-DD
  try {
    const data = await ozonPost("/v1/finance/balance", {
      clientId,
      apiKey,
      body: { date_from: dateStr, date_to: dateStr },
    });

    const total = data?.total || data?.result?.total;
    const opening = total?.opening_balance?.value ?? total?.opening_balance ?? null;
    const closing = total?.closing_balance?.value ?? total?.closing_balance ?? null;

    if (closing !== null && closing !== undefined) {
      const cents = toCents(closing);
      const salesVal = data?.cashflows?.sales?.amount?.value ?? null;
      const returnsVal = data?.cashflows?.returns?.amount?.value ?? null;

      const buyouts_sum_cents = salesVal === null ? null : toCents(salesVal);
      const returns_sum_cents = returnsVal === null ? null : toCents(returnsVal);

      return {
        // совместимость: balance_* = closing
        balance_cents: cents,
        balance_text: centsToRubString(cents),

        // для динамики: opening/closing отдельно
        balance_opening_cents: opening === null || opening === undefined ? null : toCents(opening),
        balance_opening_text: (opening === null || opening === undefined) ? "—" : centsToRubString(toCents(opening)),
        balance_closing_cents: cents,
        balance_closing_text: centsToRubString(cents),

        buyouts_sum_cents,
        buyouts_sum_text: buyouts_sum_cents === null ? "—" : centsToRubString(buyouts_sum_cents),
        returns_sum_cents,
        returns_sum_text: returns_sum_cents === null ? "—" : centsToRubString(returns_sum_cents),
      };
    }
  } catch (e) {
    // пойдём дальше (фолбэки)
  }

  // Фолбэк 1: некоторые аккаунты имеют /v2/finance/balance
  try {
    const data = await ozonPost("/v2/finance/balance", {
      clientId,
      apiKey,
      body: { date_from: dateStr, date_to: dateStr },
    });

    const root = data?.result ?? data ?? {};
    const total = root?.total ?? root;
    const closing = total?.closing_balance?.value ?? total?.closing_balance ?? root?.balance ?? null;

    if (closing !== null && closing !== undefined) {
      const cents = toCents(closing);
      return { balance_cents: cents, balance_text: centsToRubString(cents) };
    }
  } catch (e) {}

  // Фолбэк 2: cash-flow (может быть неактуален по балансу, но лучше чем ничего)
  const { since, to } = dayBoundsUtcFromLocal(dateStr);
  try {
    const data = await ozonPost("/v1/finance/cash-flow-statement/list", {
      clientId,
      apiKey,
      body: { filter: { date_from: since, date_to: to } },
    });
    const r = data?.result ?? data ?? {};
    const balance =
      r?.summary?.closing_balance ??
      r?.summary?.end_balance ??
      r?.header?.closing_balance ??
      r?.header?.end_balance ??
      null;

    if (balance !== null && balance !== undefined) {
      const cents = toCents(balance);
      return { balance_cents: cents, balance_text: centsToRubString(cents) };
    }
  } catch (e) {}

  return { balance_cents: null, balance_text: "—" };
}

// ---------------- Core: balance (cabinet) ----------------
async function calcBalanceNowCents({ clientId, apiKey, dateStr }) {
  // В Seller API нет одного “идеального” метода баланса, поэтому делаем 2 попытки:
  // 1) /v1/finance/mutual-settlement (отчёт взаиморасчётов) — часто содержит итоговую задолженность/баланс.
  // 2) /v1/finance/cash-flow-statement/list (финансовый отчёт) — как запасной вариант.
  // Возвращаем копейки. Если не получилось — null (чтобы фронт показывал "—", а не 0).
  const fromMonth = DateTime.fromFormat(dateStr, "yyyy-LL-dd", { zone: SALES_TZ }).startOf("month").toUTC().toISO({ suppressMilliseconds: false });
  const to = DateTime.fromFormat(dateStr, "yyyy-LL-dd", { zone: SALES_TZ }).endOf("day").toUTC().toISO({ suppressMilliseconds: false });

  // 1) mutual-settlement
  try {
    const body = { date_from: fromMonth, date_to: to };
    const data = await ozonPost("/v1/finance/mutual-settlement", { clientId, apiKey, body });
    const r = data?.result || data;

    const candidates = [
      r?.summary?.ending_balance,
      r?.summary?.end_balance,
      r?.summary?.closing_balance,
      r?.header?.ending_balance,
      r?.header?.end_balance,
      r?.header?.closing_balance,
      r?.balance,
      r?.result?.balance,
    ];

    for (const c of candidates) {
      const cents = toCents(c);
      if (cents !== 0) return cents; // если реально есть баланс — возвращаем
    }
  } catch (_) {}

  // 2) cash-flow-statement
  try {
    const body = { filter: { date_from: fromMonth, date_to: to }, page: 1, page_size: 1000 };
    const data = await ozonPost("/v1/finance/cash-flow-statement/list", { clientId, apiKey, body });
    const r = data?.result || data;

    const candidates = [
      r?.summary?.closing_balance,
      r?.summary?.end_balance,
      r?.summary?.ending_balance,
      r?.header?.closing_balance,
      r?.header?.end_balance,
      r?.header?.ending_balance,
      r?.balance,
    ];

    for (const c of candidates) {
      const cents = toCents(c);
      if (cents !== 0) return cents;
    }
  } catch (_) {}

  return null;
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

    const [buyoutsR, balanceR] = await Promise.allSettled([
      calcBuyoutsTodayByOffer({ clientId: resolved.clientId, apiKey: resolved.apiKey, dateStr }),
      calcBalanceToday({ clientId: resolved.clientId, apiKey: resolved.apiKey, dateStr }),
    ]);

    // Возвраты по offer_id за «сегодня» через posting/substatus Ozon корректно не отдаёт (нет даты события).
    // Поэтому по артикулам не считаем, а показываем только сумму возвратов из finance/balance.
    const returnsData = { returns_total_qty: 0, returns_list: [] };

    const buyouts = buyoutsR.status === "fulfilled" ? buyoutsR.value : { buyouts_total_qty: 0, buyouts_list: [] };
    const balance = balanceR.status === "fulfilled" ? balanceR.value : { balance_cents: null, balance_text: "—" };

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

      cancels: s.cancelsCount,
      cancelsCount: s.cancelsCount,

      cancels_sum: s.cancelsAmount,        // копейки
      cancelsAmount: s.cancelsAmount,      // копейки
      cancels_sum_text: centsToRubString(s.cancelsAmount),

      // новые виджеты
      buyouts_total_qty: buyouts.buyouts_total_qty,
      buyouts_list: buyouts.buyouts_list,
      returns_total_qty: returnsData.returns_total_qty,
      returns_list: returnsData.returns_list,


      // деньги по факту за сегодня (по /v1/finance/balance) — совпадает с кабинетом
      buyouts_sum_cents: balance.buyouts_sum_cents ?? null,
      buyouts_sum_text: balance.buyouts_sum_text ?? "—",
      returns_sum_cents: balance.returns_sum_cents ?? null,
      returns_sum_text: balance.returns_sum_text ?? "—",

      balance_cents: balance.balance_cents,
      balance_text: balance.balance_text,
      balance_opening_cents: balance.balance_opening_cents ?? null,
      balance_opening_text: balance.balance_opening_text ?? "—",
      balance_closing_cents: balance.balance_closing_cents ?? balance.balance_cents ?? null,
      balance_closing_text: balance.balance_closing_text ?? balance.balance_text ?? "—",

      widgets_errors: {
        buyouts: buyoutsR.status === "rejected" ? String(buyoutsR.reason?.message || buyoutsR.reason) : null,
        returns: null,
        balance: balanceR.status === "rejected" ? String(balanceR.reason?.message || balanceR.reason) : null,
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

// ---------------- balance operations (Mini App) ----------------
function extractTransactionsList(data){
  const r = data?.result ?? data;
  const candidates = [
    r?.operations, r?.transactions, r?.items, r?.rows, r?.list, r?.result
  ];
  for (const c of candidates){
    if (Array.isArray(c)) return c;
  }
  // иногда result может быть объектом с полем "operations"
  if (Array.isArray(data?.result?.operations)) return data.result.operations;
  return [];
}

function normalizeAmountToCents(v){
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return Math.round(v * 100);
  if (typeof v === "string") return toCents(v);
  if (typeof v === "object"){
    // {value: 123.45, currency_code:"RUB"} или {value:"123.45"}
    if ("value" in v) return normalizeAmountToCents(v.value);
    if ("amount" in v) return normalizeAmountToCents(v.amount);
  }
  return 0;
}

async function fetchFinanceTransactions({ clientId, apiKey, fromUtcIso, toUtcIso }) {
  // 1) основной формат (как в большинстве примеров Ozon)
  const tryBodies = [
    {
      filter: {
        date: { from: fromUtcIso, to: toUtcIso },
        operation_type: [],
        posting_number: "",
        transaction_type: "all",
      },
      page: 1,
      page_size: 500,
    },
    // 2) альтернативный формат
    {
      filter: { date_from: fromUtcIso, date_to: toUtcIso },
      page: 1,
      page_size: 500,
    },
  ];

  let lastErr = null;
  for (const body of tryBodies) {
    try {
      const data = await ozonPost("/v3/finance/transaction/list", { clientId, apiKey, body });
      return extractTransactionsList(data);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("Не удалось получить транзакции");
}

function buildOpsRows(transactions) {
  const rows = [];

  for (const t of transactions) {
    const title =
      t?.operation_type_name ||
      t?.operation_type ||
      t?.type_name ||
      t?.type ||
      t?.name ||
      "Операция";

    const posting =
      t?.posting_number ||
      t?.posting?.posting_number ||
      t?.posting ||
      t?.postingNumber ||
      null;

    const occurredAt =
      t?.operation_date ||
      t?.date ||
      t?.created_at ||
      t?.createdAt ||
      t?.operationDate ||
      null;

    const ts = occurredAt ? Date.parse(occurredAt) : 0;

    // product lines (если есть)
    const prods =
      t?.products ||
      t?.items ||
      t?.product ||
      null;

    // 1) если есть массив products с деталями
    if (Array.isArray(prods) && prods.length) {
      for (const p of prods) {
        const amountCents =
          normalizeAmountToCents(p?.amount) ||
          normalizeAmountToCents(p?.price) ||
          normalizeAmountToCents(p?.payout) ||
          normalizeAmountToCents(t?.amount) ||
          0;

        rows.push({
          id: String(p?.transaction_id || p?.id || t?.transaction_id || t?.id || crypto.randomUUID?.() || Math.random()),
          title: String(title),
          subtitle: p?.name ? String(p.name) : "",
          posting_number: posting ? String(posting) : null,
          offer_id: p?.offer_id ? String(p.offer_id) : (p?.offerId ? String(p.offerId) : null),
          amount_cents: amountCents,
          occurred_at: occurredAt,
          ts,
        });
      }
      continue;
    }

    // 2) если нет products — одной строкой
    const amountCents =
      normalizeAmountToCents(t?.amount) ||
      normalizeAmountToCents(t?.sum) ||
      normalizeAmountToCents(t?.price) ||
      0;

    rows.push({
      id: String(t?.transaction_id || t?.id || crypto.randomUUID?.() || Math.random()),
      title: String(title),
      subtitle: "",
      posting_number: posting ? String(posting) : null,
      offer_id: null,
      amount_cents: amountCents,
      occurred_at: occurredAt,
      ts,
    });
  }

  // выкидываем нули
  const cleaned = rows.filter(r => Number(r.amount_cents || 0) !== 0);

  // сортировка: сначала самые свежие
  cleaned.sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0));

  return cleaned; // все операции
}

app.get("/api/balance/ops/today", async (req, res) => {
  try {
    const resolved = resolveCredsFromRequest(req);
    if (!resolved) return res.status(400).json({ error: "no_creds" });

    const dateStr = todayDateStr();
    const { since, to } = dayBoundsUtcFromLocal(dateStr);

    const tx = await fetchFinanceTransactions({
      clientId: resolved.clientId,
      apiKey: resolved.apiKey,
      fromUtcIso: since,
      toUtcIso: to,
    });

    const ops = buildOpsRows(tx);

    return res.json({
      date: dateStr,
      tz: SALES_TZ,
      title: `Сегодня ${dateStr} (${SALES_TZ})`,
      ops,
    });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
});
// ====== API: детализация операции по отправлению за сегодня ======
app.get("/api/balance/op/detail", async (req, res) => {
  try {
    const resolved = resolveCredsFromRequest(req);
    if (!resolved) return res.status(400).json({ error: "no_creds" });

    const posting = (req.query.posting_number || "").toString().trim();
    if (!posting) return res.status(400).json({ error: "no_posting_number" });

    const dateStr = todayDateStr();
    const { since, to } = dayBoundsUtcFromLocal(dateStr);

    const tx = await fetchFinanceTransactions({
      clientId: resolved.clientId,
      apiKey: resolved.apiKey,
      fromUtcIso: since,
      toUtcIso: to,
    });

    const flat = buildOpsRows(tx).filter(r => String(r.posting_number || "") === posting);

    // gross = сумма всех положительных строк (для процентов)
    const gross = flat.reduce((s, r) => s + (Number(r.amount_cents) > 0 ? Number(r.amount_cents) : 0), 0);
    const net = flat.reduce((s, r) => s + Number(r.amount_cents || 0), 0);

    // группируем: если есть subtitle — показываем товар отдельно; иначе по title
    const map = new Map();
    for (const r of flat) {
      const key = (r.subtitle ? `товар||${r.subtitle}` : `тип||${r.title}`);
      const cur = map.get(key) || { name: r.subtitle ? `Товар: ${r.subtitle}` : String(r.title || "Операция"), amount_cents: 0 };
      cur.amount_cents += Number(r.amount_cents || 0);
      map.set(key, cur);
    }

    let details = Array.from(map.values());

    // сортировка: сначала + (товары), потом минусы (услуги)
    details.sort((a, b) => Number(b.amount_cents) - Number(a.amount_cents));

    // добавим проценты где уместно
    details = details.map(d => {
      const pct = gross > 0 ? Math.round((Math.abs(Number(d.amount_cents || 0)) / gross) * 1000) / 10 : null;
      return { ...d, percent: pct };
    });

    return res.json({
      date: dateStr,
      tz: SALES_TZ,
      posting_number: posting,
      gross_cents: gross,
      net_cents: net,
      details,
    });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
});


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
