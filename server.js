// server.js — Railway + Telegram Webhook + Ozon Seller API

import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import Database from "better-sqlite3";
import { Telegraf } from "telegraf";
import path from "path";
import { fileURLToPath } from "url";

// ================= ENV =================
const BOT_TOKEN = process.env.BOT_TOKEN;
const BASE_URL = (process.env.BASE_URL || "").replace(/\/$/, "");
const PORT = process.env.PORT || 8080;

if (!BOT_TOKEN) throw new Error("BOT_TOKEN is not set");
if (!BASE_URL) throw new Error("BASE_URL is not set");

// ================= PATHS =================
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ================= DB =================
const db = new Database("data.db");
db.exec(`
  CREATE TABLE IF NOT EXISTS credentials (
    telegram_id TEXT PRIMARY KEY,
    client_id TEXT,
    api_key TEXT
  );
`);

// ================= APP =================
const app = express();
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

// healthcheck
app.get("/", (_, res) => res.send("OK"));
app.get("/health", (_, res) => res.json({ status: "ok" }));

// ================= TELEGRAM =================
const bot = new Telegraf(BOT_TOKEN);

bot.start((ctx) => {
  ctx.reply("Открой приложение 👇", {
    reply_markup: {
      inline_keyboard: [[
        {
          text: "📊 Продажи за сегодня",
          web_app: { url: BASE_URL }
        }
      ]]
    }
  });
});

// webhook
const WEBHOOK_PATH = "/telegram-webhook";
app.post(WEBHOOK_PATH, (req, res) => {
  bot.handleUpdate(req.body);
  res.sendStatus(200);
});

// ================= API =================

// сохранить ключи
app.post("/api/save-credentials", (req, res) => {
  const { telegram_id, client_id, api_key } = req.body;
  if (!telegram_id || !client_id || !api_key) {
    return res.status(400).json({ error: "Missing data" });
  }

  db.prepare(`
    INSERT OR REPLACE INTO credentials
    (telegram_id, client_id, api_key)
    VALUES (?, ?, ?)
  `).run(telegram_id, client_id, api_key);

  res.json({ ok: true });
});

// получить продажи за сегодня
app.get("/api/today-sales", async (req, res) => {
  const telegram_id = req.query.telegram_id;
  if (!telegram_id) return res.status(400).json({ error: "No telegram_id" });

  const row = db.prepare(
    "SELECT client_id, api_key FROM credentials WHERE telegram_id = ?"
  ).get(telegram_id);

  if (!row) return res.status(404).json({ error: "No credentials" });

  const today = new Date().toISOString().slice(0, 10);

  const response = await fetch("https://api-seller.ozon.ru/v3/posting/fbs/list", {
    method: "POST",
    headers: {
      "Client-Id": row.client_id,
      "Api-Key": row.api_key,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      filter: {
        since: `${today}T00:00:00Z`,
        to: `${today}T23:59:59Z`
      },
      limit: 1000
    })
  });

  const data = await response.json();
  const count = data?.result?.postings?.length || 0;

  res.json({ count });
});

// ================= START =================
app.listen(PORT, async () => {
  console.log(`Server started on :${PORT}`);
  await bot.telegram.setWebhook(`${BASE_URL}${WEBHOOK_PATH}`);
  console.log(`Webhook set: ${BASE_URL}${WEBHOOK_PATH}`);
});
