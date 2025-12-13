// server.js — рабочая версия для Railway (502 FIX)
// Делает ДВЕ вещи правильно:
// 1) Отвечает 200 OK на / и /health (Railway перестаёт отдавать 502)
// 2) Работает с Telegram ТОЛЬКО через webhook (никакого polling)

import express from "express";
import bodyParser from "body-parser";
import { Telegraf } from "telegraf";

// ================= ENV =================
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) throw new Error("BOT_TOKEN is not set");

const PORT = process.env.PORT || 8080; // Railway всегда проксирует сюда

const BASE_URL = (process.env.BASE_URL || "").replace(/\/$/, "");
if (!BASE_URL) throw new Error("BASE_URL is not set");

// ================= APP =================
const app = express();
app.use(bodyParser.json());

// ОБЯЗАТЕЛЬНО: Railway healthcheck
app.get("/", (req, res) => res.status(200).send("OK"));
app.get("/health", (req, res) => res.status(200).json({ status: "ok" }));

// ================= TELEGRAM =================
const bot = new Telegraf(BOT_TOKEN);

bot.start((ctx) => ctx.reply("Бот работает"));
bot.command("ping", (ctx) => ctx.reply("pong"));

// webhook endpoint
const WEBHOOK_PATH = "/telegram-webhook";
app.post(WEBHOOK_PATH, (req, res) => {
  bot.handleUpdate(req.body);
  res.sendStatus(200);
});

// ================= START =================
app.listen(PORT, async () => {
  console.log(`Server started on :${PORT}`);

  await bot.telegram.setWebhook(`${BASE_URL}${WEBHOOK_PATH}`);
  console.log(`Telegram webhook set: ${BASE_URL}${WEBHOOK_PATH}`);
});
