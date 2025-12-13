import express from 'express';
app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));


// --- ENV ---
const PORT = process.env.PORT || 8080;
const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL; // например: https://xxx.up.railway.app/telegram-webhook


if (!BOT_TOKEN) {
console.warn('⚠️ BOT_TOKEN is not set (Railway Variables). Webhook will not be set.');
}


// --- Telegram webhook endpoint ---
app.post('/telegram-webhook', async (req, res) => {
try {
const update = req.body;


// Временно, чтобы видеть, что Telegram реально шлёт апдейты:
console.log('TG update:', JSON.stringify(update));


// TODO: тут твоя логика обработки апдейтов
// Например, если это сообщение:
// const chatId = update?.message?.chat?.id;
// const text = update?.message?.text;


return res.sendStatus(200);
} catch (err) {
console.error('Webhook handler error:', err);
// Telegram лучше всегда 200, чтобы не было ретраев/ддоса логов
return res.sendStatus(200);
}
});


// --- Set Telegram webhook on boot (если заданы переменные) ---
function setTelegramWebhook() {
if (!BOT_TOKEN || !WEBHOOK_URL) return;


const url = `https://api.telegram.org/bot${BOT_TOKEN}/setWebhook?url=${encodeURIComponent(WEBHOOK_URL)}`;


https
.get(url, (r) => {
let data = '';
r.on('data', (chunk) => (data += chunk));
r.on('end', () => {
console.log('✅ Telegram webhook set:', WEBHOOK_URL);
// Если хочешь — раскомментируй, чтобы видеть ответ Telegram:
// console.log('setWebhook response:', data);
});
})
.on('error', (e) => console.error('setWebhook error:', e));
}


app.listen(PORT, () => {
console.log(`✅ Server started on :${PORT}`);
setTelegramWebhook();
});
