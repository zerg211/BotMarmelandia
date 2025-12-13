import express from "express";
import crypto from "crypto";
import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
app.use(express.json({ limit: "256kb" }));

/* ================== CONFIG ================== */
const BOT_TOKEN =
  process.env.BOT_TOKEN ||
  process.env.TELEGRAM_BOT_TOKEN ||
  "";

if (!BOT_TOKEN) {
  console.warn("⚠️ BOT_TOKEN is not set");
}

const PORT = process.env.PORT || 3000;

/* ================== PATHS ================== */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* ================== DB ================== */
const db = new Database(process.env.SQLITE_PATH || "data.sqlite");
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS ozon_creds (
    tg_user_id INTEGER PRIMARY KEY,
    client_id TEXT NOT NULL,
    api_key TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

/* ================== TELEGRAM AUTH ================== */
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

  const entries = Object.entries(data)
    .filter(([k]) => k !== "hash")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`);

  const dataCheckString = entries.join("\n");

  const secret = crypto
    .createHash("sha256")
    .update(BOT_TOKEN)
    .digest();

  const hmac = crypto
    .createHmac("sha256", secret)
    .update(dataCheckString)
    .digest("hex");

  if (hmac !== hash) return null;

  try {
    const user = JSON.parse(data.user || "{}");
    if (!user.id) return null;
    return { id: user.id };
  } catch {
    return null;
  }
}

function getInitData(req) {
  return (
    req.headers["x-telegram-init-data"] ||
    req.headers["x-tg-init-data"] ||
    req.headers["x-telegram-webapp-init-data"] ||
    ""
  );
}

function requireTgUser(req, res, next) {
  const initData = getInitData(req);
  const tg = verifyTelegramInitData(initData);
  if (!tg) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  req.tgUserId = tg.id;
  next();
}

/* ================== KEYS API ================== */
/* 🔑 ВВОД КЛЮЧЕЙ В WEBAPP — КАК БЫЛО РАНЬШЕ */

app.get("/api/keys", requireTgUser, (req, res) => {
  const row = db
    .prepare("SELECT client_id FROM ozon_creds WHERE tg_user_id = ?")
    .get(req.tgUserId);

  if (!row) {
    return res.status(404).json({ ok: false, error: "keys_not_found" });
  }

  res.json({ ok: true, clientId: row.client_id });
});

app.post("/api/keys", requireTgUser, (req, res) => {
  const clientId = String(req.body?.clientId || "").trim();
  const apiKey = String(req.body?.apiKey || "").trim();

  if (!clientId || !apiKey) {
    return res.status(400).json({ ok: false, error: "missing_fields" });
  }

  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO ozon_creds (tg_user_id, client_id, api_key, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(tg_user_id)
    DO UPDATE SET
      client_id = excluded.client_id,
      api_key = excluded.api_key,
      updated_at = excluded.updated_at
  `).run(req.tgUserId, clientId, apiKey, now);

  res.json({ ok: true });
});

app.delete("/api/keys", requireTgUser, (req, res) => {
  db.prepare("DELETE FROM ozon_creds WHERE tg_user_id = ?")
    .run(req.tgUserId);
  res.json({ ok: true });
});

/* ================== DASHBOARD ================== */
/* 📊 ТОТ ЖЕ ЭНДПОИНТ, ЧТО У ТЕБЯ УЖЕ РАБОТАЛ */

app.get("/api/dashboard/today", requireTgUser, async (req, res) => {
  const creds = db
    .prepare("SELECT client_id, api_key FROM ozon_creds WHERE tg_user_id = ?")
    .get(req.tgUserId);

  if (!creds) {
    return res.json({ ok: false, error: "no_creds" });
  }

  try {
    // ⬇️⬇️⬇️
    // СЮДА ВСТАВЬ СВОЮ СУЩЕСТВУЮЩУЮ ЛОГИКУ OZON API
    // (ту, которая у тебя УЖЕ работала раньше)
    // ⬆️⬆️⬆️

    return res.json({
      ok: true,
      title: "FBO · Сегодня · Europe/Moscow",
      orders: 0,
      orders_sum: 0,    // в копейках
      cancels: 0,
      cancels_sum: 0,   // в копейках
      updated_at: new Date().toISOString(),
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

/* ================== STATIC WEBAPP ================== */
/* ⚠️ WebApp должен открываться С ЭТОГО ЖЕ ДОМЕНА */

app.use(express.static(path.join(__dirname, "public")));
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

/* ================== START ================== */
app.listen(PORT, () => {
  console.log("✅ Server started on port", PORT);
});
