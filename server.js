// Telegraf + Express + sqlite3 + axios
// Установите зависимости: npm i telegraf express sqlite3 axios body-parser cors
const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const bodyParser = require('body-parser');
const sqlite3 = require('sqlite3').verbose();
const axios = require('axios');
const cors = require('cors');
const path = require('path');

const BOT_TOKEN = process.env.TELEGRAM_TOKEN;
const WEBAPP_URL = process.env.WEBAPP_URL; // например https://your-app.up.railway.app/widget
const PORT = process.env.PORT || 3000;
const OZON_SALES_ENDPOINT = process.env.OZON_SALES_ENDPOINT || ''; // необязательно

if (!BOT_TOKEN) {
  console.error("Ошибка: TELEGRAM_TOKEN не задан. Установите переменную окружения TELEGRAM_TOKEN.");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
const app = express();
app.use(bodyParser.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// sqlite
const DB_FILE = path.join(__dirname, 'cred.db');
const db = new sqlite3.Database(DB_FILE, (err) => {
  if (err) console.error("Ошибка открытия БД:", err);
  else console.log("SQLite БД открыта:", DB_FILE);
});
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS cred (
    user_id INTEGER PRIMARY KEY,
    seller TEXT,
    api_key TEXT
  )`);
});

// Простая FSM в памяти
const pending = new Map(); // user_id -> { step: 'seller'|'api', seller?: string }

bot.start((ctx) => {
  const userId = ctx.from.id;
  pending.set(userId, { step: 'seller' });
  ctx.reply("Привет! Введите ваш seller_id (ID продавца Ozon):");
});

bot.on('text', (ctx) => {
  const userId = ctx.from.id;
  const p = pending.get(userId);
  if (!p) {
    ctx.reply("Чтобы начать настройку, отправьте /start.");
    return;
  }

  if (p.step === 'seller') {
    p.seller = ctx.message.text.trim();
    p.step = 'api';
    pending.set(userId, p);
    ctx.reply("Хорошо. Теперь введите Api-Key (ключ API) от Ozon:");
    return;
  }

  if (p.step === 'api') {
    const apiKey = ctx.message.text.trim();
    const seller = p.seller || '';
    const stmt = db.prepare("REPLACE INTO cred (user_id, seller, api_key) VALUES (?, ?, ?)");
    stmt.run(userId, seller, apiKey, (err) => {
      if (err) {
        console.error("Ошибка сохранения в БД:", err);
        ctx.reply("Произошла ошибка при сохранении данных. Попробуйте позже.");
        return;
      }
      pending.delete(userId);

      if (!WEBAPP_URL) {
        ctx.reply("Данные сохранены. WEBAPP_URL не настроен на сервере, поэтому открыть виджет нельзя. Установите WEBAPP_URL в переменных окружения Railway.");
        return;
      }
      const kb = Markup.inlineKeyboard([
        Markup.button.webApp('Открыть дашборд продаж', WEBAPP_URL)
      ]);
      ctx.reply("Данные сохранены. Нажмите кнопку, чтобы открыть виджет и посмотреть продажи за день.", kb);
    });
    stmt.finalize();
    return;
  }

  ctx.reply("Неизвестный шаг. Отправьте /start чтобы начать заново.");
});

// Запускаем бота (polling)
bot.launch().then(() => {
  console.log("Бот запущен (polling).");
}).catch(err => {
  console.error("Ошибка запуска бота:", err);
});

// Endpoint для WebApp: /api/sales?user_id=123
app.get('/api/sales', async (req, res) => {
  try {
    const user_id = parseInt(req.query.user_id, 10);
    if (!user_id) return res.status(400).json({ error: 'user_id required' });

    db.get("SELECT seller, api_key FROM cred WHERE user_id = ?", [user_id], async (err, row) => {
      if (err) {
        console.error("DB error:", err);
        return res.status(500).json({ error: 'db_error' });
      }
      if (!row) return res.status(404).json({ error: 'credentials_not_found' });

      if (!OZON_SALES_ENDPOINT) {
        // Заглушка для теста
        return res.json({
          ok: true,
          note: 'OZON_SALES_ENDPOINT не задан, возвращена тестовая заглушка',
          data: {
            seller: row.seller,
            date: new Date().toISOString().split('T')[0],
            sales_total: 0,
            orders: []
          }
        });
      }

      // Подготовка дат (за сегодня)
      const dateTo = new Date();
      const dateFrom = new Date(dateTo);
      const isoFrom = dateFrom.toISOString().split('T')[0];
      const isoTo = dateTo.toISOString().split('T')[0];

      try {
        const resp = await axios.get(OZON_SALES_ENDPOINT, {
          headers: {
            'Client-Id': row.seller,
            'Api-Key': row.api_key,
            'Content-Type': 'application/json'
          },
          params: {
            date_from: isoFrom,
            date_to: isoTo
          },
          timeout: 10000
        });
        return res.json({ ok: true, data: resp.data });
      } catch (ozErr) {
        console.error("Ozon API error:", ozErr.response ? ozErr.response.data : ozErr.message);
        return res.status(502).json({ error: 'ozon_api_error', details: ozErr.response ? ozErr.response.data : ozErr.message });
      }
    });
  } catch (e) {
    console.error("Internal error in /api/sales:", e);
    res.status(500).json({ error: 'internal' });
  }
});

// Статика виджета доступна по /widget
app.get('/widget', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'widget.html'));
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

// Graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
