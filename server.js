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
const OZON_CATEGORY_TREE_PATH = process.env.OZON_CATEGORY_TREE_PATH || "/v1/description-category/tree";
const OZON_COMMISSION_PATH = process.env.OZON_COMMISSION_PATH || "/v1/product/calc/commission";
const OZON_LOGISTICS_PATH = process.env.OZON_LOGISTICS_PATH || "/v1/product/calc/fbs";
const OZON_DEFAULT_CLIENT_ID = process.env.OZON_DEFAULT_CLIENT_ID || process.env.OZON_CLIENT_ID;
const OZON_DEFAULT_API_KEY = process.env.OZON_DEFAULT_API_KEY || process.env.OZON_API_KEY;

// “Сегодня” считаем по МСК (или поменяй через ENV SALES_TZ)
const SALES_TZ = process.env.SALES_TZ || "Europe/Moscow";

const DATA_DIR = process.env.DATA_DIR || ".";
const STORE_PATH = path.join(DATA_DIR, "store.json");
const CATEGORY_CACHE_PATH = path.join(DATA_DIR, "category-cache.json");
const OZON_FALLBACK_CATEGORIES_PATH = path.join(__dirname, "ozon-category-fallback.json");
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

function flattenCategoryTree(tree, acc = []) {
  if (!tree) return acc;
  if (Array.isArray(tree)) {
    tree.forEach((node) => flattenCategoryTree(node, acc));
    return acc;
  }

  const current = {
    category_id: tree.category_id || tree.id,
    name: tree.title || tree.name,
    path: tree.path || tree.path_name,
    children: tree.children || tree.childrens || [],
  };

  if (current.category_id && current.name) {
    acc.push(current);
  }

  flattenCategoryTree(current.children, acc);
  return acc;
}

function normalize(str) {
  return String(str || "").toLowerCase().trim();
}

function scoreCategory(cat, qTokens) {
  const haystack = [cat.name, cat.path, ...(cat.keywords || [])].map(normalize).filter(Boolean);
  if (!haystack.length) return 0;
  let score = 0;
  const joined = qTokens.join(" ");
  haystack.forEach((h) => {
    if (h === joined) score = Math.max(score, 140);
    else if (h.startsWith(joined)) score = Math.max(score, 120);
    else if (h.includes(joined)) score = Math.max(score, 100);
    qTokens.forEach((t) => {
      if (t.length > 2 && h.includes(t)) score = Math.max(score, 80);
    });
  });
  return score;
}

const CATEGORY_CACHE_TTL_MS = 1000 * 60 * 60 * 6; // 6 часов

async function ensureCategoryCache({ clientId, apiKey, source }) {
  loadCategoryCacheFromDisk();

  const cacheIsFallback = categoryCache.source === "fallback";
  const cacheIsStale = categoryCache.updatedAt && Date.now() - categoryCache.updatedAt > CATEGORY_CACHE_TTL_MS;

  // Если уже есть кэш и он не фолбэк/не протух — возвращаем, иначе попробуем обновить по API
  if (categoryCache.list.length && !cacheIsFallback && !cacheIsStale) return categoryCache;

  // Если кэш есть, но он из фолбэка или устарел — продолжаем и перезапишем его при наличии ключей
  if (!clientId || !apiKey) throw new Error("no_creds");

  const body = { language: "RU" };
  const data = await ozonPost(OZON_CATEGORY_TREE_PATH, { clientId, apiKey, body });
  const tree = data?.result?.categories || data?.result?.items || data?.result || data;
  const flat = flattenCategoryTree(tree, []).map((c) => ({
    category_id: c.category_id,
    name: c.name,
    path: c.path || c.name,
    keywords: (c.path || c.name || "").split(/[>/]/).map((p) => p.trim()).filter(Boolean),
  }));

  categoryCache.list = flat;
  categoryCache.source = source || OZON_CATEGORY_TREE_PATH;
  categoryCache.updatedAt = Date.now();
  saveCategoryCacheToDisk();
  return categoryCache;
}

function searchCategories(query, { limit = 20 } = {}) {
  const q = normalize(query);
  if (!q || q.length < 2 || !categoryCache.list.length) return [];
  const qTokens = q.split(/\s+/).filter(Boolean);
  return categoryCache.list
    .map((cat) => ({ cat, score: scoreCategory(cat, qTokens) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.cat);
}

// Cache of categories fetched from Ozon to allow repeated lookups and search.
const categoryCache = {
  list: [],
  source: null,
  updatedAt: 0,
};

function loadCategoryCacheFromDisk() {
  if (categoryCache.list.length) return;
  try {
    if (!fs.existsSync(CATEGORY_CACHE_PATH)) return;
    const data = JSON.parse(fs.readFileSync(CATEGORY_CACHE_PATH, "utf-8"));
    if (Array.isArray(data?.list)) {
      categoryCache.list = data.list;
      categoryCache.source = data.source || "disk";
      categoryCache.updatedAt = data.updatedAt || Date.now();
    }
  } catch (_) {}
}

function saveCategoryCacheToDisk() {
  try {
    const payload = {
      list: categoryCache.list,
      source: categoryCache.source,
      updatedAt: categoryCache.updatedAt || Date.now(),
    };
    fs.writeFileSync(CATEGORY_CACHE_PATH, JSON.stringify(payload, null, 2), "utf-8");
  } catch (_) {}
}

function seedCategoryCacheFromFallback() {
  if (categoryCache.list.length) return false;
  try {
    if (!fs.existsSync(OZON_FALLBACK_CATEGORIES_PATH)) return false;
    const data = JSON.parse(fs.readFileSync(OZON_FALLBACK_CATEGORIES_PATH, "utf-8"));
    if (!Array.isArray(data)) return false;
    categoryCache.list = data.map((c) => ({
      category_id: c.category_id,
      name: c.name,
      path: c.path || c.name,
      keywords: (c.keywords || c.path || c.name || "")
        .toString()
        .split(/[>/]/)
        .map((p) => p.trim())
        .filter(Boolean),
      commission: c.commission || {},
    }));
    categoryCache.source = "fallback";
    categoryCache.updatedAt = Date.now();
    return categoryCache.list.length > 0;
  } catch (_) {
    return false;
  }
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
  let s = String(val).trim().replace(",", ".");
  if (!s) return 0;

  let sign = 1;
  if (s.startsWith("-")) {
    sign = -1;
    s = s.slice(1);
  } else if (s.startsWith("+")) {
    s = s.slice(1);
  }

  const parts = s.split(".");
  const rub = parseInt(parts[0] || "0", 10) || 0;
  const kop = parseInt((parts[1] || "0").padEnd(2, "0").slice(0, 2), 10) || 0;
  return sign * (rub * 100 + kop);
}
function rubToCents(val) {
  return toCents(val);
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

  // 4) Фолбэк на переменные окружения
  if (OZON_DEFAULT_CLIENT_ID && OZON_DEFAULT_API_KEY) {
    return { clientId: OZON_DEFAULT_CLIENT_ID, apiKey: OZON_DEFAULT_API_KEY, source: "env" };
  }

  return null;
}

app.post("/api/ozon/categories", async (req, res) => {
  try {
    loadCategoryCacheFromDisk();
    seedCategoryCacheFromFallback();
    const fromBody = { clientId: req.body?.clientId || req.query.clientId, apiKey: req.body?.apiKey || req.query.apiKey };
    const resolved = fromBody.clientId && fromBody.apiKey ? { ...fromBody, source: "body" } : resolveCredsFromRequest(req);

    if (!resolved?.clientId || !resolved?.apiKey) {
      if (categoryCache.list.length) {
        return res.json({
          source: categoryCache.source || "cache",
          total: categoryCache.list.length,
          categories: categoryCache.list,
          cached: true,
        });
      }
      return res.status(400).json({ error: "no_creds" });
    }

    await ensureCategoryCache(resolved);

    return res.json({
      source: categoryCache.source,
      total: categoryCache.list.length,
      categories: categoryCache.list,
    });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
});

app.post("/api/ozon/categories/search", async (req, res) => {
  try {
    loadCategoryCacheFromDisk();
    const query = req.body?.query || req.query.q || "";
    const limit = Number(req.body?.limit || req.query.limit || 20) || 20;

    const fromBody = { clientId: req.body?.clientId || req.query.clientId, apiKey: req.body?.apiKey || req.query.apiKey };
    const resolved = fromBody.clientId && fromBody.apiKey ? { ...fromBody, source: "body" } : resolveCredsFromRequest(req);

    if (!categoryCache.list.length) {
      if (!resolved?.clientId || !resolved?.apiKey) {
        if (!seedCategoryCacheFromFallback()) return res.status(400).json({ error: "no_creds" });
      } else {
        await ensureCategoryCache(resolved);
      }
    } else if (resolved?.clientId && resolved?.apiKey) {
      // Если данные есть, но они из фолбэка или устарели — обновим при наличии ключей
      await ensureCategoryCache(resolved);
    }

    const matches = searchCategories(query, { limit });
    return res.json({
      source: categoryCache.source,
      total: categoryCache.list.length,
      categories: matches,
    });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
});

app.post("/api/ozon/commission", async (req, res) => {
  try {
    const fromBody = { clientId: req.body?.clientId || req.query.clientId, apiKey: req.body?.apiKey || req.query.apiKey };
    const resolved = fromBody.clientId && fromBody.apiKey ? { ...fromBody, source: "body" } : resolveCredsFromRequest(req);
    if (!resolved?.clientId || !resolved?.apiKey) return res.status(400).json({ error: "no_creds" });
    const payload = req.body?.payload;
    if (!payload) return res.status(400).json({ error: "no_payload" });

    const data = await ozonPost(OZON_COMMISSION_PATH, { clientId: resolved.clientId, apiKey: resolved.apiKey, body: payload });
    return res.json({ source: resolved.source || OZON_COMMISSION_PATH, result: data?.result || data });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
});

app.post("/api/ozon/logistics", async (req, res) => {
  try {
    const fromBody = { clientId: req.body?.clientId || req.query.clientId, apiKey: req.body?.apiKey || req.query.apiKey };
    const resolved = fromBody.clientId && fromBody.apiKey ? { ...fromBody, source: "body" } : resolveCredsFromRequest(req);
    if (!resolved?.clientId || !resolved?.apiKey) return res.status(400).json({ error: "no_creds" });
    const payload = req.body?.payload;
    if (!payload) return res.status(400).json({ error: "no_payload" });

    const data = await ozonPost(OZON_LOGISTICS_PATH, { clientId: resolved.clientId, apiKey: resolved.apiKey, body: payload });
    return res.json({ source: resolved.source || OZON_LOGISTICS_PATH, result: data?.result || data });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
});

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

function serviceTitle(rawKey) {
  const map = {
    marketplace_service_item_fulfillment: "Логистика",
    marketplace_service_item_pickup: "Логистика",
    marketplace_service_item_dropoff_pvz: "Логистика",
    marketplace_service_item_dropoff_ff: "Логистика",
    marketplace_service_item_direct_flow_trans: "Логистика",
    marketplace_service_item_deliv_to_customer: "Логистика",
    marketplace_service_payment_processing: "Эквайринг",
    marketplace_service_item_return_flow: "Возврат",
    marketplace_service_item_return_after_deliv_to_customer: "Возврат после доставки",
    marketplace_service_item_dropoff_sc: "Доставка на сортировочный центр",
    marketplace_service_item_customer_pickup: "Самовывоз покупателем",
    marketplace_service_item_defect_commission: "Комиссия за брак",
    marketplace_service_item_return_not_deliv_to_customer: "Невыкуп",
  };

  if (map[rawKey]) return map[rawKey];
  const cleaned = String(rawKey || "").replace(/marketplace_service_/g, "").replace(/item_/g, "");
  return cleaned ? cleaned.replace(/_/g, " ").trim() : "Услуга";
}

function extractServiceAmount(val) {
  if (val === null || val === undefined) return 0;
  if (typeof val === "number" || typeof val === "string") return normalizeAmountToCents(val);
  if (Array.isArray(val)) return val.reduce((s, v) => s + extractServiceAmount(v), 0);

  if (typeof val === "object") {
    const preferred = ["total", "price", "amount", "value", "payout"];
    for (const key of preferred) {
      if (key in val) {
        const v = extractServiceAmount(val[key]);
        if (v) return v;
      }
    }

    if (Array.isArray(val.items)) {
      const itemsSum = val.items.reduce((s, v) => s + extractServiceAmount(v), 0);
      if (itemsSum) return itemsSum;
    }

    // попытка извлечь из вложенных полей, если нет явных ключей
    let nestedSum = 0;
    for (const v of Object.values(val)) nestedSum += extractServiceAmount(v);
    return nestedSum;
  }

  return 0;
}

async function fetchFinanceTransactions({ clientId, apiKey, fromUtcIso, toUtcIso, postingNumber = "" }) {
  // Вытягиваем ВСЕ транзакции за период (постранично), чтобы список операций был полным.
  const bodyBase = {
    filter: {
      date: { from: fromUtcIso, to: toUtcIso },
      operation_type: [],
      posting_number: postingNumber || "",
      transaction_type: "all",
    },
    page: 1,
    page_size: 500,
  };

  let page = 1;
  let pageCount = 1;
  const all = [];

  while (page <= pageCount) {
    const body = { ...bodyBase, page };
    const data = await ozonPost("/v3/finance/transaction/list", { clientId, apiKey, body });

    const items = extractTransactionsList(data);
    if (Array.isArray(items) && items.length) all.push(...items);

    const pc = data?.result?.page_count ?? data?.page_count ?? data?.result?.pages ?? null;
    if (typeof pc === "number" && pc > 0) pageCount = pc;

    // если page_count не отдали — выходим по факту пустой страницы
    if ((!pc || pc < 1) && (!items || items.length === 0)) break;

    page += 1;
    if (page > 200) break; // защита
  }

  return all;
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

    // posting_number иногда приходит объектом
    let postingVal =
      t?.posting_number ||
      t?.posting?.posting_number ||
      t?.posting;

    if (postingVal && typeof postingVal === "object") {
      postingVal = postingVal.posting_number || postingVal.postingNumber || postingVal.number || null;
    }

    const amountCents = normalizeAmountToCents(
      t?.amount ?? t?.accrual ?? t?.price ?? t?.sum ?? t?.total ?? t?.value ?? t?.payout
    );

    // время операции (если Ozon отдал)
    const occurredAt = (()=>{
      const cands = [
        t?.operation_date_time,
        t?.operation_datetime,
        t?.occurred_at,
        t?.created_at,
        t?.moment,
        t?.operation_date,
        t?.date,
      ].filter(Boolean).map(v=>String(v));

      // сначала ищем ISO со временем (есть 'T')
      for (const s of cands) if (s.includes("T")) return s;

      // иначе возвращаем хоть дату (будет 00:00)
      return cands[0] || null;
    })();

    // сортируем по времени операции, но на фронт отдаём уже в МСК
    let ts = 0;
    let occurred_at_msk = null;
    if (occurredAt) {
      const dt = DateTime.fromISO(String(occurredAt), { setZone: true });
      if (dt.isValid) {
        ts = dt.toMillis();
        occurred_at_msk = dt.setZone(SALES_TZ).toISO();
      }
    }

    // если нет валидного времени — хотя бы сортируем по id транзакции
    if (!ts) {
      const fallback = Number(t?.operation_id || t?.transaction_id || t?.id || 0);
      if (Number.isFinite(fallback)) ts = fallback;
    }

    const titleLc = String(title).toLowerCase();
    const isSaleDelivery = titleLc.includes("доставка покупателю");

    rows.push({
      id: String(t?.operation_id || t?.transaction_id || t?.id || crypto.randomUUID()),
      title: String(title),
      subtitle: "",
      posting_number: postingVal ? String(postingVal) : null,
      offer_id: null,
      amount_cents: amountCents,
      occurred_at: occurred_at_msk,
      ts,
      is_sale_delivery: isSaleDelivery,
    });
  }

  const cleaned = rows.filter(r => Number(r.amount_cents || 0) !== 0);

  // сортировка: сначала самые свежие
  cleaned.sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0));

  return cleaned; // все операции (без лимита)
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

app.get("/api/balance/sale/detail", async (req, res) => {
  try {
    const resolved = resolveCredsFromRequest(req);
    if (!resolved) return res.status(400).json({ error: "no_creds" });

    const posting = String(req.query.posting_number || "").trim();
    if (!posting) return res.status(400).json({ error: "no_posting_number" });

    // 1) Берем постинг: получаем "полную сумму продажи" (gross) по товарам
    const pg = await ozonPost("/v2/posting/fbo/get", {
      clientId: resolved.clientId,
      apiKey: resolved.apiKey,
      body: {
        posting_number: posting,
        translit: true,
        with: { analytics_data: true, financial_data: true, legal_info: false },
      },
    });

    const pRes = pg?.result || pg;
    const products = Array.isArray(pRes?.products) ? pRes.products : [];
    const items = products.map((p) => {
      const qty = Number(p?.quantity || 0) || 0;
      const price = Number(p?.price || 0) || 0;
      return {
        offer_id: p?.offer_id || null,
        name: p?.name || null,
        qty,
        price_cents: rubToCents(price),
        total_cents: rubToCents(price) * (qty || 1),
      };
    });

    const gross = items.reduce((s, it) => s + Number(it.total_cents || 0), 0);

    // 2) Тянем транзакции по этому отправлению и собираем услуги/расходы
    // Отталкиваемся от даты доставки/создания конкретного постинга и берём узкое окно,
    // чтобы не тащить все транзакции за месяц и не упираться в лимиты API.
    const deliveredIso = pickDeliveredIso(pRes);
    const createdIso = pRes?.created_at || pRes?.in_process_at || null;
    const anchorIso = deliveredIso || createdIso || todayDateStr();

    let anchor = DateTime.fromISO(anchorIso, { setZone: true });
    if (!anchor.isValid) anchor = DateTime.fromFormat(todayDateStr(), "yyyy-LL-dd", { zone: SALES_TZ });

    // берём 15 дней до и после якорной даты
    const fromLocal = anchor.minus({ days: 15 }).startOf("day");
    const toLocal = anchor.plus({ days: 15 }).endOf("day");
    const since = fromLocal.toUTC().toISO({ suppressMilliseconds: false });
    const to = toLocal.toUTC().toISO({ suppressMilliseconds: false });

    // Постранично (на всякий случай)
    const allTx = await fetchFinanceTransactions({
      clientId: resolved.clientId,
      apiKey: resolved.apiKey,
      fromUtcIso: since,
      toUtcIso: to,
      postingNumber: posting,
    });

    // фильтруем по posting_number
    const tx = allTx.filter((t) => {
      const pn =
        t?.posting_number ||
        t?.posting?.posting_number ||
        t?.posting;
      if (!pn) return false;
      if (typeof pn === "object") return String(pn.posting_number || "") === posting;
      return String(pn) === posting;
    });

    // группируем расходы/услуги по названию операции
    let netFromSaleCents = null;
    const group = new Map(); // name -> cents
    for (const t of tx) {
      const name =
        t?.operation_type_name ||
        t?.operation_type ||
        t?.type_name ||
        t?.type ||
        t?.name ||
        "Операция";
      const cents = normalizeAmountToCents(
        t?.amount ?? t?.accrual ?? t?.price ?? t?.sum ?? t?.total ?? t?.value ?? t?.payout
      );
      if (!cents) continue;

      const nameLc = String(name).toLowerCase();

      // сохраняем сумму чистого начисления по доставке (net)
      if (nameLc.includes("доставка покупателю")) {
        if (netFromSaleCents === null) netFromSaleCents = cents;
        continue; // в детализации показываем разложение без самого начисления
      }

      group.set(String(name), (group.get(String(name)) || 0) + cents);
    }

    // Комиссия из financial_data постинга (если вдруг нет в транзакциях)
    const finData = pRes?.financial_data || {};
    const finProds = Array.isArray(finData?.products) ? finData.products : [];
    const commissionFromPosting = finProds.reduce((s, fp) => s + (normalizeAmountToCents(fp?.commission_amount) || 0), 0);
    if (commissionFromPosting && ![...group.keys()].some(k => k.toLowerCase().includes("комис"))) {
      group.set("Комиссия", (group.get("Комиссия") || 0) + commissionFromPosting);
    }

    // Услуги/удержания из financial_data (логистика, эквайринг и т.п.)
    const serviceBuckets = [finData?.services, finData?.posting_services, finData?.additional_services];
    for (const bucket of serviceBuckets) {
      if (!bucket || typeof bucket !== "object") continue;
      for (const [rawKey, svc] of Object.entries(bucket)) {
        const keyLc = String(rawKey || "").toLowerCase();

        // Пытаемся забрать net по доставке из payout/amount, но в расходы не кладём
        if (keyLc.includes("marketplace_service_item_deliv_to_customer")) {
          const payoutFromSvc = normalizeAmountToCents(
            svc?.payout ?? svc?.total ?? svc?.amount ?? svc?.value ?? svc
          );
          if (netFromSaleCents === null && payoutFromSvc) netFromSaleCents = payoutFromSvc;
          continue;
        }

        const title = serviceTitle(rawKey);
        const amount = extractServiceAmount(svc);
        if (!amount) continue;
        group.set(title, (group.get(title) || 0) + amount);
      }
    }

    // если не нашли net в транзакциях — возьмём из payout услуги доставки
    if (netFromSaleCents === null) {
      const deliverySvc =
        finData?.posting_services?.marketplace_service_item_deliv_to_customer ||
        finData?.services?.marketplace_service_item_deliv_to_customer ||
        null;
      if (deliverySvc) {
        const payoutFromSvc = normalizeAmountToCents(
          deliverySvc?.payout ?? deliverySvc?.total ?? deliverySvc?.amount ?? deliverySvc?.value ?? deliverySvc
        );
        if (payoutFromSvc) netFromSaleCents = payoutFromSvc;
      }
    }

    // собираем строки
    const lines = [];

    // верхняя строка: gross продажа (полная)
    lines.push({
      title: "Продажа",
      amount_cents: gross,
      percent: gross > 0 ? 100 : null,
      kind: "gross",
    });

    // услуги/расходы
    const feeLines = Array.from(group.entries())
      .map(([title, amount_cents]) => {
        const pct = gross ? Math.round((Math.abs(amount_cents) / gross) * 1000) / 10 : null;
        return { title, amount_cents, percent: pct, kind: "fee" };
      })
      .filter(l => Number(l.amount_cents || 0) !== 0)
      .sort((a, b) => Math.abs(Number(b.amount_cents)) - Math.abs(Number(a.amount_cents)));

    lines.push(...feeLines);

    // если сумма по "Доставка покупателю" не совпадает с gross + услуги, добавляем остаток как прочие удержания
    if (netFromSaleCents !== null) {
      const feesTotal = feeLines.reduce((s, f) => s + Number(f.amount_cents || 0), 0);
      const residual = netFromSaleCents - gross - feesTotal;
      if (Math.abs(residual) > 0) {
        const pct = gross ? Math.round((Math.abs(residual) / gross) * 1000) / 10 : null;
        lines.push({ title: "Прочие удержания", amount_cents: residual, percent: pct, kind: "residual" });
      }
    }

    // отдельная подсказка "Оплата за заказ"
    const payForOrderLine = feeLines.find(l => String(l.title).toLowerCase().includes("оплата за заказ"));
    const note = payForOrderLine
      ? {
          title: "Данный заказ был продан по оплате за заказ",
          amount_cents: payForOrderLine.amount_cents,
          percent: payForOrderLine.percent,
          kind: "note",
        }
      : null;

    res.json({
      posting_number: posting,
      items,
      gross_cents: gross,
      lines,
      note,
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
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
