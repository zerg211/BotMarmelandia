import express from "express";
import https from "https";

const app = express();

// Telegram/Railway присылают JSON
app.use(express.json());

// --- Health routes (чтобы не было 404 на / и /index.html) ---
app.get("/", (req, res) => res.status(200).send("OK"));
app.get("/index.html", (req, res) => res.status(200).send("OK"));
app.get("/health", (req, res) => res.status(200).json({ status: "ok" }));

// --- ENV ---
const PORT = process.env.PORT || 8080;
const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL; // https://xxx.up.railway.app/telegram-webhook

// --- Telegram webhook endpoint ---
app.post("/telegram-webhook", async (req, res) => {
  try {
    const update = req.body;

    // временно, чтобы убедиться что апдейты реально приходят
    console.log("TG update:", JSON.stringify(update));

    // TODO: твоя логика обработки update
    return res.sendStatus(200);
  } catch (err) {
    console.error("Webhook handler error:", err);
    return res.sendStatus(200);
  }
});

// --- Set webhook on boot ---
function setTelegramWebhook() {
  if (!BOT_TOKEN || !WEBHOOK_URL) {
    console.warn("⚠️ BOT_TOKEN or WEBHOOK_URL is not set. Skip setWebhook.");
    return;
  }

  const url = `https://api.telegram.org/bot${BOT_TOKEN}/setWebhook?url=${encodeURIComponent(
    WEBHOOK_URL
  )}`;

  https
    .get(url, (r) => {
      let data = "";
      r.on("data", (chunk) => (data += chunk));
      r.on("end", () => {
        console.log("✅ Telegram webhook set:", WEBHOOK_URL);
        // console.log("setWebhook response:", data); // если нужно посмотреть ответ
      });
    })
    .on("error", (e) => console.error("setWebhook error:", e));
}

app.listen(PORT, () => {
  console.log(`✅ Server started on :${PORT}`);
  setTelegramWebhook();
});
