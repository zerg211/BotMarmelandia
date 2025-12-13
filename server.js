import express from "express";
import bodyParser from "body-parser";
import { Telegraf, Markup } from "telegraf";
import path from "path";
import { fileURLToPath } from "url";

// ===== ENV =====
const BOT_TOKEN = process.env.BOT_TOKEN;
const BASE_URL = (process.env.BASE_URL || "").replace(/\/$/, "");
const PORT = process.env.PORT || 8080;

if (!BOT_TOKEN) throw new Error("BOT_TOKEN is not set");
if (!BASE_URL) throw new Error("BASE_URL is not set");

// ===== APP =====
const app = express();
app.use(bodyParser.json());

// healthcheck
app.get("/", (req, res) => res.send("OK"));
app.get("/health", (req, res) => res.json({ status: "ok" }));

// ===== STATIC (Mini App) =====
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use("/app", express.static(path.join(__dirname, "public")));

// ===== API ДЛЯ MINI APP (ПОКА ЗАГЛУШКА) =====
app.get("/api/today-sales", (req, res) => {
  // ПОКА ЗАГЛУШКА — потом подключим Ozon
  res.json({
    count: 23,
    date: new Date().toISOString().slice(0, 10),
  });
});

// ===== TELEGRAM =====
const bot = new Telegraf(BOT_TOKEN);

bot.start((ctx) => {
  ctx.reply(
    "Открой продажи за сегодня:",
    Markup.inlineKeyboard([
      Markup.button.webApp(
        "📊 Продажи за сегодня",
        `${BASE_URL}/app/index.html`
      ),
    ])
  );
});

// webhook
const WEBHOOK_PATH = "/telegram-webhook";
app.post(WEBHOOK_PATH, (req, res) => {
  bot.handleUpdate(req.body);
  res.sendStatus(200);
});

// ===== START =====
app.listen(PORT, async () => {
  console.log(`Server started on :${PORT}`);
  await bot.telegram.setWebhook(`${BASE_URL}${WEBHOOK_PATH}`);
});
