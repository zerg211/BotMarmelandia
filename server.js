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

// Метод отправки сообщений
async function tgSendMessage(chatId, text, opts = {}) {
  if (!BOT_TOKEN) return;
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

    if (!text) return;

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
