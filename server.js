// server.js — Railway + Telegram WebApp + Ozon Seller API (без SQLite)
// Ввод ключей делаем в Mini App и храним в localStorage на телефоне.
// Сервер НЕ хранит ключи, чтобы не требовать БД.

import express from "express";
import bodyParser from "body-parser";
import path from "path";
import { fileURLToPath } from "url";
import { Telegraf, Markup } from "telegraf";

const BOT_TOKEN = process.env.BOT_TOKEN;
const BASE_URL = (process.env.BASE_URL || "").replace(/\/$/, "");
const PORT = process.env.PORT || 8080;

if (!BOT_TOKEN) throw new Error("BOT_TOKEN is not set");
if (!BASE_URL) throw new Error("BASE_URL is not set");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(bodyParser.json());

// Отдаём Mini App со статики
app.use(express.static(path.join(__dirname, "public")));

// Railway healthcheck
app.get("/health", (req, res) => res.status(200).json({ status: "ok" }));

// API: получить продажи за сегодня (FBO = "со склада Ozon")
app.post("/api/today-sales", async (req, res) => {
  try {
    const { client_id, api_key } = req.body || {};
    if (!client_id || !api_key) {
      return res.status(400).json({ error: "Нет Client ID или API Key" });
    }

    // Сегодня по UTC
    const now = new Date();
    const yyyy = now.getUTCFullYear();
    const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(now.getUTCDate()).padStart(2, "0");
    const day = `${yyyy}-${mm}-${dd}`;

    const url = "https://api-seller.ozon.ru/v2/posting/fbo/list";

    let offset = 0;
    const limit = 1000;
    let total = 0;

    while (true) {
      const r = await fetch(url, {
        method: "POST",
        headers: {
          "Client-Id": String(client_id),
          "Api-Key": String(api_key),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          dir: "asc",
          filter: {
            since: `${day}T00:00:00Z`,
            to: `${day}T23:59:59Z`,
          },
          limit,
          offset,
        }),
      });

      const data = await r.json().catch(() => ({}));

      if (!r.ok) {
        return res.status(400).json({
          error: data?.message || data?.error || "Ozon API вернул ошибку",
          details: data,
        });
      }

      const items = data?.result || [];
      total += items.length;

      if (items.length < limit) break;
      offset += limit;
      if (offset > 20000) break; // защита от бесконечного цикла
    }

    return res.json({ count: total, day });
  } catch (e) {
    return res.status(500).json({ error: "Серверная ошибка", details: String(e) });
  }
});

// Telegram webhook (без polling)
const bot = new Telegraf(BOT_TOKEN);

bot.start((ctx) => {
  ctx.reply(
    "Открыть виджет продаж:",
    Markup.inlineKeyboard([
      Markup.button.webApp("📊 Продажи за сегодня", `${BASE_URL}/index.html`),
    ])
  );
});

const WEBHOOK_PATH = "/telegram-webhook";
app.post(WEBHOOK_PATH, (req, res) => {
  bot.handleUpdate(req.body);
  res.sendStatus(200);
});

app.listen(PORT, async () => {
  console.log(`✅ Server started on :${PORT}`);
  await bot.telegram.setWebhook(`${BASE_URL}${WEBHOOK_PATH}`);
  console.log(`✅ Telegram webhook set: ${BASE_URL}${WEBHOOK_PATH}`);
});
