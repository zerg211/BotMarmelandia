import express from "express";
import crypto from "crypto";
import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
app.use(express.json({ limit: "256kb" }));

// ====== CONFIG ======
const BOT_TOKEN = process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || "";
if (!BOT_TOKEN) {
  console.error("❌ BOT_TOKEN/TELEGRAM_BOT_TOKEN is not set");
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ====== DB ======
const db = new Database(process.env.SQLITE_PATH || "data.sqlite");
db.pragma("journal_mode = WAL");

// Таблица для ключей (один набор на одного tg_user_id)
db.exec(`
  CREATE TABLE IF NOT EXISTS ozon_creds (
    tg_user_id INTEGER PRIMARY KEY,
    client_id TEXT NOT NULL,
    api_key TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

// ====== Telegram initData verification ======
function parseInitData(initData) {
  const params = new URLSearchParams(initData);
  const obj = {};
  for (const [k, v] of params.entries()) obj[k] = v;
  return obj;
}

function verifyTelegramInitData(initData) {
  if (!initData || !BOT_TOKEN) return null;

  const data = parseInitData(initData);
  const hash = data.hash;
  if (!hash) return null;

  // Build data_check_string
  const entries = Object.entries(data)
    .filter(([k]) => k !== "hash")
    .sort(([a], [b]) => (a > b ? 1 : a < b ? -1 : 0))
    .map(([k, v]) => `${k}=${v}`);

  const dataCheckString = entries.join("\n");

  // secret_key = HMAC_SHA256("WebAppData", bot_token)  (в spec: key = sha256(bot_token), msg="WebAppData")
  // На практике используют: secret = sha256(bot_token), then hmac(dataCheckString, secret)
  // Делаем совместимую реализацию:
  const secret = crypto.createHash("sha256").update(BOT_TOKEN).digest();
  const hmac = crypto.createHmac("sha256", secret).update(dataCheckString).digest("hex");

  if (hmac !== hash) return null;

  // user (json string)
  let user = null;
  try {
    if (data.user) user = JSON.parse(data.user);
  } catch (_) {}

  if (!user?.id) return null;
  return { id: user.id, user };
}

function getInitDataFromReq(req) {
  return (
    req.headers["x-tg-init-data"] ||
    req.headers["x-telegram-init-data"] ||
    req.headers["x-telegram-webapp-init-data"] ||
    ""
  );
}

function requireTgUser(req, res, next) {
  const initData = getInitDataFromReq(req);
  const tg = verifyTelegramInitData(initData);
  if (!tg?.id) return res.status(401).json({ ok: false, error: "unauthorized" });
  req.tgUserId = tg.id;
  next();
}

// ====== API: keys (возвращаем “старую” логику — ввод в приложении) ======
app.get("/api/keys", requireTgUser, (req, res) => {
  const row = db
    .prepare("SELECT client_id, updated_at FROM ozon_creds WHERE tg_user_id = ?")
    .get(req.tgUserId);

  if (!row) return res.status(404).json({ ok: false, error: "keys_not_found" });
  res.json({ ok: true, clientId: row.client_id, updated_at: row.updated_at });
});

app.post("/api/keys", requireTgUser, (req, res) => {
  const clientId = String(req.body?.clientId || "").trim();
  const apiKey = String(req.body?.apiKey || "").trim();
  if (!clientId || !apiKey) return res.status(400).json({ ok: false, error: "missing_fields" });

  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO ozon_creds (tg_user_id, client_id, api_key, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(tg_user_id) DO UPDATE SET
      client_id=excluded.client_id,
      api_key=excluded.api_key,
      updated_at=excluded.updated_at
  `).run(req.tgUserId, clientId, apiKey, now);

  res.json({ ok: true });
});

app.delete("/api/keys", requireTgUser, (req, res) => {
  db.prepare("DELETE FROM ozon_creds WHERE tg_user_id = ?").run(req.tgUserId);
  res.json({ ok: true });
});

// ====== API: dashboard today ======
// ВАЖНО: тут я оставил заглушку “где получать данные у Ozon”.
// ТВОЙ текущий код получения заказов/отмен — вставь внутрь try блока.
app.get("/api/dashboard/today", requireTgUser, async (req, res) => {
  const creds = db
    .prepare("SELECT client_id, api_key FROM ozon_creds WHERE tg_user_id = ?")
    .get(req.tgUserId);

  if (!creds) return res.json({ ok: false, error: "no_creds" });

  try {
    // ====== ВСТАВЬ СЮДА ТВОЮ ТЕКУЩУЮ ЛОГИКУ OZON SELLER API ======
    // Я возвращаю формат, который ждёт твой фронт
    // Пример заглушки:
    const result = {
      ok: true,
      title: "FBO · Сегодня · Europe/Moscow",
      orders: 0,
      orders_sum: 0,   // в копейках
      cancels: 0,
      cancels_sum: 0,  // в копейках
      updated_at: new Date().toISOString(),
    };

    return res.json(result);
  } catch (e) {
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

// ====== Static WebApp (ВАЖНО: держим WebApp на том же домене Railway) ======
app.use(express.static(path.join(__dirname, "public")));
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("✅ Server listening on", port));
