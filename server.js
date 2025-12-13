import express from "express";

const app = express();
app.use(express.json());

// Health routes (браузер будет видеть OK — это нормально)
app.get("/", (req, res) => res.status(200).send("OK"));
app.get("/index.html", (req, res) => res.status(200).send("OK"));
app.get("/health", (req, res) => res.status(200).json({ status: "ok" }));

const PORT = process.env.PORT || 8080;
const BOT_TOKEN = process.env.BOT_TOKEN;

if (!BOT_TOKEN) {
  console.warn("⚠️ BOT_TOKEN is not set");
}

// Функция отправки сообщения в Telegram (без лишних библиотек)
async function tgSendMessage(chatId, text) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });

  const data = await resp.json();
  if (!data?.ok) {
    console.error("❌ sendMessage failed:", data);
  }
  return data;
}

// Webhook
app.post("/telegram-webhook", async (req, res) => {
  try {
    const update = req.body;
    console.log("TG update:", JSON.stringify(update));

    const msg = update?.message;
    const chatId = msg?.chat?.id;
    const text = msg?.text;

    // Telegram должен быстро получить 200
    res.sendStatus(200);

    if (!chatId || !text) return;
    if (!BOT_TOKEN) return;

    if (text === "/start") {
      await tgSendMessage(
        chatId,
        "Привет! Я онлайн ✅\n\nНапиши мне любое сообщение — я отвечу."
      );
      return;
    }

    // Эхо (потом заменим на твою бизнес-логику)
    await tgSendMessage(chatId, `Ты написал: <b>${text}</b>`);
  } catch (err) {
    console.error("Webhook handler error:", err);
    // даже при ошибке лучше 200, чтобы Telegram не долбил ретраями
    res.sendStatus(200);
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server started on :${PORT}`);
});
