import express from "express";
import bodyParser from "body-parser";
import { Telegraf } from "telegraf";

/* =========================
   ENV
========================= */
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  throw new Error("BOT_TOKEN is not set");
}

const PORT = process.env.PORT || 8080;
const BASE_URL = (process.env.BASE_URL || "").replace(/\/$/, "");

if (!BASE_URL) {
  throw new Error("BASE_URL is not set");
}

/* =========================
   APP
========================= */
const app = express();
app.use(bodyParser.json());

/* =========================
   HEALTH & ROOT — ОБЯЗАТЕЛЬНО
========================= */
app.get("/", (req, res) => {
  res.status(200).send("OK");
});

app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok" });
});

/* =========================
   TELEGRAM BOT
========================= */
const bot = new Telegraf(BOT_TOKEN);

/* простой тестовый хэндлер */
bot.start((ctx) => ctx.reply("Бот работает ✅"));
bot.on("text", (ctx) => ctx.reply("Сообщение получено 👍"));

/* =========================
   WEBHOOK
========================= */
const WEBHOOK_PATH = "/telegram-webhook";

app.post(WEBHOOK_PATH, (req, res) => {
  bot.handleUpdate(req.body, res);
});

/* =========================
   START SERVER
========================= */
app.listen(PORT, async () => {
  console.log(`✅ Server started on :${PORT}`);

  await bot.telegram.setWebhook(`${BASE_URL}${WEBHOOK_PATH}`);
  console.log(
    `✅ Telegram webhook set: ${BASE_URL}${WEBHOOK_PATH}`
  );
});
