import express from "express";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { DateTime } from "luxon";
import { fileURLToPath } from "url";
import xlsx from "xlsx"; // Не забудьте: npm install xlsx

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ==========================================
// КОНФИГУРАЦИЯ
// ==========================================
const PORT = process.env.PORT || 8080;
const BOT_TOKEN = process.env.BOT_TOKEN; // Ваш токен от BotFather
const ENCRYPTION_KEY_B64 = process.env.ENCRYPTION_KEY_B64; // Ключ шифрования (из .env)
const OZON_API_BASE = process.env.OZON_API_BASE || "https://api-seller.ozon.ru";
const BASE_URL = process.env.BASE_URL; // Ваш домен (https://...)

// Проверка наличия ключей
if (!BOT_TOKEN) console.warn("⚠️ Warning: BOT_TOKEN is missing in .env");
if (!ENCRYPTION_KEY_B64) console.warn("⚠️ Warning: ENCRYPTION_KEY_B64 is missing in .env");

const app = express();
app.use(express.json());

// ====== СТАТИКА (Front-end) ======
app.use("/public", express.static(path.join(__dirname, "Public")));

// Редирект с "кривых" ссылок
app.get(/^\/https?:\/\//, (req, res) => res.redirect(302, "/"));

// Главная страница (Дашборд)
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "Public", "index.html"));
});
app.get("/index.html", (req, res) => {
  res.sendFile(path.join(__dirname, "Public", "index.html"));
});

// Страница Калькулятора (новая)
app.get("/calculator", (req, res) => {
  res.sendFile(path.join(__dirname, "Public", "calculator.html"));
});

app.get("/health", (req, res) => res.status(200).json({ status: "ok" }));

// ==========================================
// 1. ЛОГИКА КАЛЬКУЛЯТОРА И ЗАГРУЗКА EXCEL
// ==========================================

let commissionsCache = [];

function loadCommissions() {
  try {
    const filePath = path.join(__dirname, "comissions.xlsx - commissions.csv");
    if (!fs.existsSync(filePath)) {
        console.error("❌ Файл с комиссиями не найден:", filePath);
        return;
    }

    const workbook = xlsx.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const rawData = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName]);

    // НОРМАЛИЗАЦИЯ ДАННЫХ (чистим заголовки от \n и пробелов)
    commissionsCache = rawData.map(row => {
      const newRow = {};
      for (let key in row) {
        // Убираем переносы строк и лишние пробелы, приводим к нижнему регистру
        let cleanKey = key.replace(/(\r\n|\n|\r)/gm, " ").trim().toLowerCase();
        
        // Маппинг сложных названий из Excel в простые ключи кода
        if (cleanKey.includes("fbo") && cleanKey.includes("до 100")) cleanKey = "fbo_0_100";
        else if (cleanKey.includes("fbo") && cleanKey.includes("свыше 100") && cleanKey.includes("до 300")) cleanKey = "fbo_100_300";
        else if (cleanKey.includes("fbo") && cleanKey.includes("свыше 300") && cleanKey.includes("до 500")) cleanKey = "fbo_300_500";
        else if (cleanKey.includes("fbo") && cleanKey.includes("свыше 500") && cleanKey.includes("до 1500")) cleanKey = "fbo_500_1500";
        else if (cleanKey.includes("fbo") && cleanKey.includes("свыше") && cleanKey.includes("1500")) cleanKey = "fbo_1500_plus";
        else if (cleanKey.includes("fbo") && cleanKey.includes("fresh")) cleanKey = "fbo_fresh";
        
        else if (cleanKey.includes("fbs") && cleanKey.includes("до 100")) cleanKey = "fbs_0_100";
        else if (cleanKey.includes("fbs") && cleanKey.includes("свыше 100") && cleanKey.includes("до 300")) cleanKey = "fbs_100_300";
        else if (cleanKey.includes("fbs") && cleanKey.includes("свыше") && cleanKey.includes("300")) cleanKey = "fbs_300_plus";
        
        else if (cleanKey.includes("rfbs")) cleanKey = "rfbs";
        
        else if (cleanKey.includes("категория")) cleanKey = "category";
        else if (cleanKey.includes("тип товара")) cleanKey = "item_type";

        newRow[cleanKey] = row[key];
      }
      return newRow;
    });

    console.log(`✅ Комиссии загружены: ${commissionsCache.length} позиций.`);
  } catch (e) {
    console.error("❌ Ошибка загрузки commissions.csv:", e.message);
  }
}

// Загружаем комиссии при старте
loadCommissions();

// API Endpoint для калькулятора
app.get("/api/calculator/commission", (req, res) => {
  try {
    const { categoryName, price, schema } = req.query;

    if (!categoryName || !price || !schema) {
      return res.status(400).json({ error: "Не заполнены поля" });
    }

    const numPrice = parseFloat(price);
    const searchStr = categoryName.toLowerCase().trim();
    const schemaKey = schema.toLowerCase(); 

    // Поиск товара (точное совпадение или вхождение)
    const item = commissionsCache.find(row => {
      const type = (row["item_type"] || "").toLowerCase();
      const cat = (row["category"] || "").toLowerCase();
      return type === searchStr || cat === searchStr || type.includes(searchStr);
    });

    if (!item) {
      return res.json({ found: false, message: "Категория не найдена в тарифах." });
    }

    // Выбор ключа по цене
    let key = "";
    if (schemaKey === "fbo") {
      if (numPrice <= 100) key = "fbo_0_100";
      else if (numPrice <= 300) key = "fbo_100_300";
      else if (numPrice <= 500) key = "fbo_300_500";
      else if (numPrice <= 1500) key = "fbo_500_1500";
      else key = "fbo_1500_plus";
    } else if (schemaKey === "fbs") {
      if (numPrice <= 100) key = "fbs_0_100";
      else if (numPrice <= 300) key = "fbs_100_300";
      else key = "fbs_300_plus";
    } else if (schemaKey === "rfbs") {
      key = "rfbs";
    }

    let commissionValue = item[key];
    if (commissionValue === undefined) {
      return res.json({ found: true, category: item["item_type"], error: `Тариф не найден для этой цены.` });
    }

    let percent = parseFloat(commissionValue);
    if (percent < 1.0) percent = percent * 100; // 0.14 -> 14%
    percent = Math.round(percent * 100) / 100;

    return res.json({
      found: true,
      category: item["item_type"],
      root_category: item["category"],
      commissionPercent: percent,
      schema: schemaKey
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});


// ==========================================
// 2. БАЗА ДАННЫХ ПОЛЬЗОВАТЕЛЕЙ (Bot Logic)
// ==========================================
const USERS_FILE = path.join(__dirname, "data", "users.json");
// Создаем папку data если нет
if (!fs.existsSync(path.join(__dirname, "data"))) {
  fs.mkdirSync(path.join(__dirname, "data"));
}

function getUserCreds(userId) {
  try {
    if (!fs.existsSync(USERS_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
    return data[String(userId)] || null;
  } catch (e) { return null; }
}

function setUserCreds(userId, creds) {
  let data = {};
  try {
    if (fs.existsSync(USERS_FILE)) data = JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
  } catch (e) {}
  data[String(userId)] = creds;
  fs.writeFileSync(USERS_FILE, JSON.stringify(data, null, 2));
}

function deleteUserCreds(userId) {
  let data = {};
  try {
    if (fs.existsSync(USERS_FILE)) data = JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
  } catch (e) {}
  delete data[String(userId)];
  fs.writeFileSync(USERS_FILE, JSON.stringify(data, null, 2));
}

// ==========================================
// 3. ШИФРОВАНИЕ (AES-256-CBC)
// ==========================================
function getCipherKey() {
  if (!ENCRYPTION_KEY_B64) throw new Error("No ENCRYPTION_KEY_B64");
  return Buffer.from(ENCRYPTION_KEY_B64, "base64");
}
function encrypt(text) {
  if (!text) return "";
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-cbc", getCipherKey(), iv);
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  return iv.toString("hex") + ":" + encrypted;
}
function decrypt(text) {
  if (!text) return "";
  const parts = text.split(":");
  if (parts.length !== 2) return text; 
  const iv = Buffer.from(parts[0], "hex");
  const encryptedText = parts[1];
  const decipher = crypto.createDecipheriv("aes-256-cbc", getCipherKey(), iv);
  let decrypted = decipher.update(encryptedText, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

// ==========================================
// 4. API DASHBOARD (Для Mini App)
// ==========================================
app.get("/api/dashboard/today", async (req, res) => {
  try {
    let { clientId, apiKey } = req.query;
    if (!clientId || !apiKey) return res.status(401).json({ error: "No credentials" });

    // Если ключи зашифрованы (пришли из localStorage как есть, но мы их расшифруем если надо)
    // В данном случае предполагаем, что MiniApp шлет raw, или мы их расшифровываем на клиенте?
    // Обычно MiniApp шлет то, что сохранил. Если сохранил зашифрованное - надо декрипт.
    // Но проще считать, что MiniApp шлет "как есть". 
    // Если в базе лежит зашифрованное, то бот сохранил зашифрованное.
    // В этом эндпоинте мы ожидаем ClientID и ApiKey в открытом виде или расшифровываем?
    // В коде бота ниже мы шифруем перед сохранением. Значит MiniApp должен получить расшифрованное?
    // Или MiniApp просто дергает API?
    // Давайте предположим, что передаются чистые ключи для запроса к озону.
    
    // Попробуем расшифровать, если похоже на шифр (содержит :)
    if (apiKey.includes(":")) {
        try { apiKey = decrypt(apiKey); } catch(e){}
    }

    const today = DateTime.now().setZone("Europe/Moscow").toFormat("yyyy-MM-dd");
    const dateFrom = today + "T00:00:00.000Z";
    const dateTo = today + "T23:59:59.999Z";

    // Запрос FBO
    const fboData = await ozonGetFboStats(clientId, apiKey, dateFrom, dateTo);
    
    // Ответ
    res.json({
      title: "Статистика за сегодня",
      updated_at: DateTime.now().toFormat("HH:mm:ss"),
      orders: fboData.orders,
      orders_sum: fboData.ordersSum,
      cancels: fboData.cancels,
      cancels_sum: fboData.cancelsSum
    });

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Хелпер для Ozon API (FBO)
async function ozonGetFboStats(clientId, apiKey, dateFrom, dateTo) {
  // Реализация запроса к /v2/posting/fbo/list
  // Упрощенная логика суммирования
  const url = `${OZON_API_BASE}/v2/posting/fbo/list`;
  const body = {
    dir: "ASC",
    filter: { since: dateFrom, to: dateTo },
    limit: 1000,
    with: { financial_data: true }
  };
  
  const json = await ozonFetch(url, clientId, apiKey, body);
  const list = json.result || [];

  let orders = 0; let ordersSum = 0;
  let cancels = 0; let cancelsSum = 0;

  for (const p of list) {
    // Статусы: awaiting_packaging, awaiting_deliver, delivering, delivered
    // Отмены: cancelled
    const price = p.financial_data?.products?.[0]?.price || 0; // упрощенно
    if (p.status === "cancelled") {
      cancels++;
      cancelsSum += parseFloat(price);
    } else {
      orders++;
      ordersSum += parseFloat(price);
    }
  }

  // Переводим в копейки или оставляем как есть? В html используется fmtMoneyFromCents.
  // Предположим Ozon отдает рубли. Умножим на 100 для совместимости с фронтом
  return {
    orders,
    ordersSum: ordersSum * 100, 
    cancels,
    cancelsSum: cancelsSum * 100
  };
}

async function ozonFetch(url, clientId, apiKey, body) {
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Client-Id": clientId,
      "Api-Key": apiKey,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Ozon API Error ${resp.status}: ${txt}`);
  }
  return await resp.json();
}


// ==========================================
// 5. TELEGRAM BOT (Webhook)
// ==========================================

// In-memory состояние диалога (шаги ввода ключей)
const pending = new Map();

<<<<<<< HEAD
// ---------------- local commission + categories (Excel) ----------------
const commissionXlsxCache = { mtimeMs: 0, byId: new Map(), byName: new Map(), categories: [] };

function parseRateFromRow(row) {
  const numericKeys = [
    "rate",
    "percent",
    "value",
    "commission",
    "Commission",
    "Commission (%)",
    "commission_percent",
    "FBO до 100 руб.",
    "FBO свыше 100 до 300 руб.",
    "FBO свыше 300 до 500 руб.",
    "FBO свыше 500 до 1500 руб.",
    "FBO свыше 1500 руб.",
    "FBO Fresh",
    "FBS до 100 руб.",
    "FBS свыше 100 до 300 руб.",
    "FBS свыше 300 руб.",
    "RFBS",
  ];
  for (const key of numericKeys) {
    if (row[key] === undefined || row[key] === null) continue;
    const clean = String(row[key]).replace("%", "").replace(",", ".").trim();
    const num = Number(clean);
    if (Number.isFinite(num) && num > 0) return num;
  }

  // если ключ не найден — ищем первое число в значениях
  for (const val of Object.values(row || {})) {
    const clean = String(val ?? "").replace("%", "").replace(",", ".").trim();
    const num = Number(clean);
    if (Number.isFinite(num) && num > 0) return num;
  }
  return NaN;
}

function loadCommissionMapFromXlsx() {
  try {
    if (!fs.existsSync(COMMISSION_XLSX_PATH)) return commissionXlsxCache;
    const stat = fs.statSync(COMMISSION_XLSX_PATH);
    if (commissionXlsxCache.mtimeMs === stat.mtimeMs && commissionXlsxCache.byId.size) return commissionXlsxCache;

    const wb = xlsx.readFile(COMMISSION_XLSX_PATH);
    const sheetName = wb.SheetNames[0];
    if (!sheetName) return commissionXlsxCache;
    const sheet = wb.Sheets[sheetName];
    const rows = xlsx.utils.sheet_to_json(sheet, { defval: null });

    const byId = new Map();
    const byName = new Map();
    const categories = [];

    const rateColumns = [
      { schema: "fbo", max: 100, names: ["FBO до 100 руб."] },
      { schema: "fbo", max: 300, names: ["FBO свыше 100 до 300 руб."] },
      { schema: "fbo", max: 500, names: ["FBO свыше 300 до 500 руб."] },
      { schema: "fbo", max: 1500, names: ["FBO свыше 500 до 1500 руб."] },
      { schema: "fbo", max: null, names: ["FBO свыше 1500 руб."] },
      { schema: "fbo_fresh", max: null, names: ["FBO Fresh"] },
      { schema: "fbs", max: 100, names: ["FBS до 100 руб."] },
      { schema: "fbs", max: 300, names: ["FBS свыше 100 до 300 руб."] },
      { schema: "fbs", max: null, names: ["FBS свыше 300 руб."] },
      { schema: "rfbs", max: null, names: ["RFBS"] },
    ];

    for (const row of rows) {
      const id =
        row.category_id ??
        row.id ??
        row.categoryId ??
        row.type_id ??
        row.typeId ??
        row["ID"] ??
        row["Category ID"] ??
        row["category"];
      const name = row["Категория"] ?? row["category_name"] ?? row["Category"] ?? row["Name"] ?? row["name"] ?? row["category"];
      const path = row["Тип товара"] ?? row["type_name"] ?? row["Type"] ?? row["type"] ?? name;

      const idStr = id === 0 ? "0" : String(id || "").trim();
      const schemaRates = {};

      for (const col of rateColumns) {
        for (const colName of col.names) {
          if (row[colName] === undefined || row[colName] === null) continue;
          const rate = parseRateFromRow({ [colName]: row[colName] });
          if (!Number.isFinite(rate) || rate <= 0) continue;
          const list = schemaRates[col.schema] || [];
          list.push({ max: col.max, rate, label: colName });
          schemaRates[col.schema] = list;
          break;
        }
      }

      const normalizedName = name ? String(name).trim() : "";
      const key = normalizedName.toLowerCase();

      if (Object.keys(schemaRates).length) {
        const entry = { name: normalizedName || idStr || key || "Категория", path: path ? String(path).trim() : normalizedName, schemaRates };
        if (idStr) byId.set(idStr, entry);
        if (key) byName.set(key, entry);
        categories.push({
          category_id: idStr || key,
          name: entry.name,
          path: entry.path || entry.name,
          keywords: [entry.name, entry.path].filter(Boolean),
          commission: { rates: schemaRates },
        });
      }
    }

    commissionXlsxCache.mtimeMs = stat.mtimeMs;
    commissionXlsxCache.byId = byId;
    commissionXlsxCache.byName = byName;
    commissionXlsxCache.categories = categories;
    return commissionXlsxCache;
  } catch (err) {
    console.error("LOCAL COMMISSION XLSX LOAD ERROR", err);
    return commissionXlsxCache;
  }
}

function pickTierRate(schemaRates, schema, price) {
  const list = schemaRates?.[schema];
  if (!Array.isArray(list) || !list.length) return null;
  const normalized = [...list].sort((a, b) => {
    const ma = a.max === null || a.max === undefined ? Infinity : a.max;
    const mb = b.max === null || b.max === undefined ? Infinity : b.max;
    return ma - mb;
  });
  if (!Number.isFinite(price) || price <= 0) return normalized[normalized.length - 1]?.rate ?? null;
  for (const tier of normalized) {
    const max = Number.isFinite(tier.max) ? tier.max : Infinity;
    if (price <= max) return tier.rate;
  }
  return normalized[normalized.length - 1]?.rate ?? null;
}

function findLocalCommission(categoryId, name, price, schema) {
  const { byId, byName } = loadCommissionMapFromXlsx();
  let entry = null;
  if (categoryId !== undefined && categoryId !== null) {
    entry = byId.get(String(categoryId)) || null;
  }
  if (!entry && name) {
    const key = String(name).trim().toLowerCase();
    entry = byName.get(key) || null;
  }
  if (!entry) return null;
  const rate = pickTierRate(entry.schemaRates, schema, price);
  if (!Number.isFinite(rate) || rate <= 0) return null;
  return rate;
}

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
    category_id: tree.category_id || tree.id || tree.type_id,
    name: tree.title || tree.name || tree.type_name,
    path: tree.path || tree.path_name || tree.type_path || tree.type_name,
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
  const localExcel = loadCommissionMapFromXlsx();

  const cacheIsFallback = categoryCache.source === "fallback";
  const cacheIsStale = categoryCache.updatedAt && Date.now() - categoryCache.updatedAt > CATEGORY_CACHE_TTL_MS;

  // Если уже есть кэш и он не фолбэк/не протух — возвращаем, иначе попробуем обновить по API
  if (categoryCache.list.length && !cacheIsFallback && !cacheIsStale) return categoryCache;

  // Если кэш есть, но он из фолбэка или устарел — продолжаем и перезапишем его при наличии ключей
  if (!clientId || !apiKey) throw new Error("no_creds");

  const tryPaths = Array.from(new Set([OZON_CATEGORY_TREE_PATH, OZON_CATEGORY_TREE_ALT_PATH].filter(Boolean)));
  const body = { language: "RU" };

  let tree = null;
  let usedPath = null;
  const treeInfos = [];

  for (const p of tryPaths) {
    try {
      const data = await ozonPost(p, { clientId, apiKey, body });
      const candidate = data?.result?.categories || data?.result?.items || data?.result || data;

      const info = Array.isArray(candidate)
        ? { path: p, type: "array", length: candidate.length }
        : candidate && typeof candidate === "object"
          ? { path: p, type: "object", keys: Object.keys(candidate).slice(0, 12) }
          : { path: p, type: typeof candidate };
      treeInfos.push(info);

      const flatCandidate = flattenCategoryTree(candidate, []);
      if (flatCandidate.length) {
        tree = candidate;
        usedPath = p;
        break;
      }
    } catch (err) {
      treeInfos.push({ path: p, error: String(err.message || err) });
      continue;
    }
  }

  if (!tree) {
    console.error("OZON CATEGORY TREE EMPTY", { treeInfos });

    // Попробуем вернуться к локальному fallback, если он есть
    seedCategoryCacheFromFallback();
    if (!categoryCache.list.length && localExcel?.categories?.length) {
      categoryCache.list = localExcel.categories;
      categoryCache.source = "excel_fallback";
      categoryCache.updatedAt = Date.now();
      saveCategoryCacheToDisk();
      return categoryCache;
    }
    if (!categoryCache.list.length) {
      const err = new Error("categories_empty_api");
      err.code = "categories_empty_api";
      err.treeInfos = treeInfos;
      err.hint = "Ozon API вернул пустой список категорий. Проверьте права ключа: нужен доступ к каталогу и описанию категорий.";
      throw err;
    }
    categoryCache.source = "fallback_after_empty";
    categoryCache.updatedAt = Date.now();
    saveCategoryCacheToDisk();
    return categoryCache;
  }

  // попробуем подмешать "стандартные" комиссии из fallback-файла (если он есть)
// чтобы комиссия работала даже при обновлении дерева категорий через API
  let commissionById = new Map();
  try{
    if (fs.existsSync(OZON_FALLBACK_CATEGORIES_PATH)){
      const fb = JSON.parse(fs.readFileSync(OZON_FALLBACK_CATEGORIES_PATH, "utf-8"));
      if (Array.isArray(fb)){
        commissionById = new Map(
          fb
            .filter(x => x && (x.category_id || x.id))
            .map(x => [String(x.category_id || x.id), x.commission || {}])
        );
      }
    }
  } catch (_) {}

  const flat = flattenCategoryTree(tree, []).map((c) => ({
    category_id: c.category_id,
    name: c.name,
    path: c.path || c.name,
    keywords: (c.path || c.name || "").split(/[>/]/).map((p) => p.trim()).filter(Boolean),
    commission: commissionById.get(String(c.category_id)) || {},
  }));

  categoryCache.list = flat;
  if (localExcel?.categories?.length) {
    const seen = new Set(categoryCache.list.map((c) => (normalize(c.name) + "|" + (c.category_id || ""))));
    for (const c of localExcel.categories) {
      const key = normalize(c.name) + "|" + (c.category_id || "");
      if (!seen.has(key)) categoryCache.list.push(c);
    }
  }
  categoryCache.source = source || usedPath || OZON_CATEGORY_TREE_PATH;
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
=======
// Метод отправки сообщений
async function tgSendMessage(chatId, text, opts = {}) {
  if (!BOT_TOKEN) return;
>>>>>>> a416ba205706c6cc6d6599531f3caecd5f8c80ae
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", ...opts })
    });
  } catch (e) {
    console.error("TG Send Error:", e);
  }
}

// Webhook endpoint
app.post(`/bot${BOT_TOKEN}`, async (req, res) => {
  res.sendStatus(200); // Сразу отвечаем OK
  try {
    const body = req.body;
    if (!body || !body.message) return;
    const msg = body.message;
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const text = msg.text?.trim();

<<<<<<< HEAD
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

    let matches = searchCategories(query, { limit });

    if ((!matches || !matches.length) && resolved?.clientId && resolved?.apiKey) {
      // Попробуем принудительно обновить дерево категорий (например, если кэш пустой или устаревший)
      const cache = await ensureCategoryCache(resolved);
      matches = searchCategories(query, { limit });
      if (!matches?.length && !cache?.list?.length) {
        console.error("OZON CATEGORIES SEARCH EMPTY AFTER REFRESH", { source: cache?.source, updatedAt: cache?.updatedAt, query, treeInfos: cache?.treeInfos });
        return res.status(502).json({
          error: "categories_empty",
          code: "categories_empty",
          source: cache?.source || "unknown",
          query,
          total: cache?.list?.length || 0,
          treeInfos: cache?.treeInfos,
        });
      }
    }
    return res.json({
      source: categoryCache.source,
      total: categoryCache.list.length,
      updatedAt: categoryCache.updatedAt,
      categories: matches,
    });
  } catch (e) {
    console.error("OZON CATEGORIES SEARCH ERROR:", e);
    const code = e?.code || "error";
    const status = code === "categories_empty_api" ? 502 : 500;
    return res.status(status).json({
      error: String(e.message || e),
      code,
      hint: e?.hint,
      treeInfos: e?.treeInfos,
    });
  }
});

app.post("/api/ozon/commission", async (req, res) => {
  try {
    loadCategoryCacheFromDisk();

    const payload = req.body?.payload || req.body || {};
    const item = Array.isArray(payload?.items) ? payload.items[0] : (payload?.item || payload || null);

    const categoryIdRaw = item?.category_id ?? item?.categoryId ?? payload?.category_id ?? payload?.categoryId;
    if (!categoryIdRaw) return res.status(400).json({ error: "missing_category_id" });

    const schemaRaw =
      item?.delivery_schema ??
      payload?.delivery_schema ??
      req.body?.delivery_schema ??
      req.query?.delivery_schema ??
      "fbo";
    const schemaStr = String(schemaRaw || "").toLowerCase();
    const schema = schemaStr.includes("fbs") ? "fbs" : schemaStr.includes("rfbs") ? "rfbs" : "fbo";

    const fromBody = { clientId: req.body?.clientId || req.query.clientId, apiKey: req.body?.apiKey || req.query.apiKey };
    const resolved = fromBody.clientId && fromBody.apiKey ? { ...fromBody, source: "body" } : resolveCredsFromRequest(req);
    if (!resolved?.clientId || !resolved?.apiKey) return res.status(400).json({ error: "no_creds" });

    const price = Number(payload?.price ?? req.body?.price ?? item?.price ?? req.query?.price);
    if (!Number.isFinite(price) || price <= 0) {
      return res.status(400).json({ error: "invalid_price", hint: "Укажите цену товара (number > 0)" });
    }

    // 1) пробуем локальный Excel (если есть)
    const localRate = findLocalCommission(categoryIdRaw, item?.name || item?.category_name || payload?.category_name, price, schema);
    if (Number.isFinite(localRate) && localRate > 0) {
      return res.json({
        source: "local_excel",
        category_id: String(categoryIdRaw),
        category_name: item?.name || item?.category_name || payload?.category_name,
        schema,
        rate: Number(localRate),
        price,
      });
    }

    // 2) если в Excel нет — больше не зовём Ozon API, сразу ошибка
    return res.status(404).json({
      error: "commission_not_found",
      category_id: String(categoryIdRaw),
      category_name: item?.name || item?.category_name || payload?.category_name,
      schema,
      price,
      hint: "Ставка не найдена в commissions.xlsx. Добавьте категорию и повторите.",
    });
  } catch (e) {
    console.error("OZON COMMISSION ERROR", e);
    return res.status(500).json({
      error: String(e.message || e),
      code: e?.code,
      hint: "Проверьте наличие категории в commissions.xlsx",
    });
  }
});

app.post("/api/ozon/logistics", async (req, res) => {
  try {
    const fromBody = { clientId: req.body?.clientId || req.query.clientId, apiKey: req.body?.apiKey || req.query.apiKey };
    const resolved = fromBody.clientId && fromBody.apiKey ? { ...fromBody, source: "body" } : resolveCredsFromRequest(req);
    if (!resolved?.clientId || !resolved?.apiKey) return res.status(400).json({ error: "no_creds" });
    const payload = req.body?.payload;
    if (!payload) return res.status(400).json({ error: "no_payload" });

    const price = Number(payload?.price);
    const weight = Number(payload?.weight);
    const volume = Number(payload?.volume);
    const schema = String(payload?.delivery_schema || "");
    const deliveryTime = Number(payload?.delivery_time);
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(weight) || weight <= 0 || !Number.isFinite(volume) || volume <= 0 || !schema) {
      return res.status(400).json({
        error: "invalid_input",
        details: {
          price: payload?.price,
          weight: payload?.weight,
          volume: payload?.volume,
          delivery_schema: payload?.delivery_schema,
          delivery_time: payload?.delivery_time,
        },
      });
    }

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
=======
    if (!text) return;
>>>>>>> a416ba205706c6cc6d6599531f3caecd5f8c80ae

    // --- Команда /start ---
    if (text === "/start") {
      const creds = getUserCreds(userId);
      if (creds?.clientId && creds?.apiKey) {
        await tgSendMessage(chatId, "✅ Ключи уже сохранены. Нажми кнопку ниже, чтобы открыть аналитику.", {
            reply_markup: {
                inline_keyboard: [[{ text: "📊 Открыть аналитику", web_app: { url: BASE_URL } }]]
            }
        });
        return;
      }
      pending.set(userId, { step: "clientId" });
      await tgSendMessage(chatId, "Привет! Для работы мне нужны твои ключи Ozon API (Read only).\n\nОтправь мне <b>Client ID</b>:");
      return;
    }

    // --- Команда /reset ---
    if (text === "/reset") {
      deleteUserCreds(userId);
      pending.set(userId, { step: "clientId" });
      await tgSendMessage(chatId, "🗑 Ключи удалены. Давай настроим заново.\n\nОтправь <b>Client ID</b>:");
      return;
    }

    // --- Обработка шагов (State Machine) ---
    const st = pending.get(userId);
    
    if (st?.step === "clientId") {
      // Простая валидация (только цифры)
      if (!/^\d+$/.test(text)) {
        await tgSendMessage(chatId, "⚠️ Client ID должен состоять только из цифр. Попробуй еще раз:");
        return;
      }
      pending.set(userId, { step: "apiKey", clientId: text });
      await tgSendMessage(chatId, "Принято. Теперь отправь <b>API Key</b> (тип Admin или Statistics):");
      return;
    }

    if (st?.step === "apiKey") {
      // Сохраняем (шифруем API Key)
      const encryptedKey = encrypt(text);
      setUserCreds(userId, { 
        clientId: st.clientId, 
        apiKey: encryptedKey, 
        savedAt: Date.now() 
      });
      pending.delete(userId);
      
      await tgSendMessage(chatId, "✅ Отлично! Ключи сохранены и зашифрованы.", {
        reply_markup: {
            inline_keyboard: [[{ text: "📊 Открыть аналитику", web_app: { url: BASE_URL } }]]
        }
      });
      return;
    }

    // Если ничего не подошло
    await tgSendMessage(chatId, "Я не понимаю эту команду. Нажми /start или /reset.");

  } catch (e) {
    console.error("Webhook Error:", e);
  }
});

// Запуск
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  console.log(`Webhook URL: ${BASE_URL}/bot${BOT_TOKEN}`);
});
