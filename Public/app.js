// 1) Anti "white screen": покажем ошибку текстом
window.addEventListener("error", (e) => {
  const msg = (e && e.message) ? e.message : "JS error";
  document.body.innerHTML = `<pre style="white-space:pre-wrap;padding:16px;color:#fff;background:#000;">${msg}</pre>`;
});
window.addEventListener("unhandledrejection", (e) => {
  const msg = (e && e.reason) ? String(e.reason) : "Unhandled promise rejection";
  document.body.innerHTML = `<pre style="white-space:pre-wrap;padding:16px;color:#fff;background:#000;">${msg}</pre>`;
});

// 2) Telegram WebApp init + fullscreen
const tg = window.Telegram?.WebApp;

function applyFullscreen() {
  if (!tg) return;
  tg.ready();
  tg.expand();
  tg.disableVerticalSwipes?.();
  tg.requestFullscreen?.(); // если доступно в клиенте
}

applyFullscreen();

// Telegram иногда меняет высоту в рантайме
try {
  tg?.onEvent?.("viewportChanged", applyFullscreen);
} catch (_) {}

const $ = (id) => document.getElementById(id);

// UI
const statusEl = $("status");
const hintEl = $("hint");
const updatedAtEl = $("updatedAt");
const refreshBtn = $("refreshBtn");
const refreshIcon = $("refreshIcon");

const subtitleEl = $("subtitle");
const ordersEl = $("orders");
const ordersSumEl = $("ordersSum");
const cancelsEl = $("cancels");
const cancelsSumEl = $("cancelsSum");

// Keys modal
const keysBtn = $("keysBtn");
const modal = $("modal");
const closeModal = $("closeModal");
const clientIdInp = $("clientId");
const apiKeyInp = $("apiKey");
const saveKeysBtn = $("saveKeys");
const deleteKeysBtn = $("deleteKeys");
const keysStatus = $("keysStatus");

function setStatus(text, danger = false) {
  statusEl.textContent = text;
  statusEl.className = "badge" + (danger ? " danger" : "");
}

function showHint(text) {
  hintEl.textContent = text || "";
  hintEl.style.display = text ? "block" : "none";
}

function setLastUpdated(iso) {
  const d = iso ? new Date(iso) : new Date();
  updatedAtEl.textContent = "Последнее обновление: " + d.toLocaleString("ru-RU");
}

function fmtMoneyFromCents(cents) {
  if (cents === null || cents === undefined) return "—";
  const rub = Number(cents) / 100;
  return new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(rub);
}

function tgHeader() {
  const initData = tg?.initData || "";
  // ВАЖНО: backend может ждать конкретный заголовок — оставляем оба варианта
  return initData
    ? { "X-Tg-Init-Data": initData, "x-telegram-init-data": initData }
    : {};
}

// ---- Keys modal logic (ввод ключей в кабинете)
function openModal() {
  modal.hidden = false;
  keysStatus.textContent = "";
  loadKeys().catch(() => {});
}
function close() {
  modal.hidden = true;
}

keysBtn.addEventListener("click", openModal);
closeModal.addEventListener("click", close);
modal.addEventListener("click", (e) => {
  if (e.target === modal) close();
});

saveKeysBtn.addEventListener("click", async () => {
  keysStatus.textContent = "";
  try {
    const clientId = clientIdInp.value.trim();
    const apiKey = apiKeyInp.value.trim();
    if (!clientId || !apiKey) {
      keysStatus.textContent = "Заполни Client ID и API Key";
      return;
    }

    const r = await fetch("/api/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...tgHeader() },
      body: JSON.stringify({ clientId, apiKey }),
    });

    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw new Error(j.error || "Ошибка сохранения ключей");

    keysStatus.textContent = "Сохранено ✅";
    close();
    await loadDashboard();
  } catch (e) {
    keysStatus.textContent = String(e?.message || e);
  }
});

deleteKeysBtn.addEventListener("click", async () => {
  keysStatus.textContent = "";
  try {
    const r = await fetch("/api/keys", { method: "DELETE", headers: tgHeader() });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw new Error(j.error || "Ошибка удаления ключей");

    clientIdInp.value = "";
    apiKeyInp.value = "";
    keysStatus.textContent = "Удалено ✅";
    await loadDashboard();
  } catch (e) {
    keysStatus.textContent = String(e?.message || e);
  }
});

async function loadKeys() {
  keysStatus.textContent = "";

  const r = await fetch("/api/keys", { headers: tgHeader() });
  const j = await r.json().catch(() => ({}));

  // Если initData не пришёл (часто через “Открыть”) — backend может отдать 401
  if (r.status === 401) {
    keysStatus.textContent = "Telegram не передал данные (initData). Попробуй нажать «Обновить» или открыть через кнопку у бота.";
    return;
  }

  if (!r.ok) {
    keysStatus.textContent = "Ключи не найдены. Введи Client ID / API Key.";
    return;
  }

  keysStatus.textContent = "Ключи найдены ✅";
  clientIdInp.value = j.clientId || "";
  apiKeyInp.value = "";
}

// ---- Dashboard logic
async function loadDashboard() {
  // UI reset
  showHint("");
  setStatus("обновление…");
  ordersEl.textContent = "—";
  ordersSumEl.textContent = "—";
  cancelsEl.textContent = "—";
  cancelsSumEl.textContent = "—";

  // ВАЖНО: при “Открыть” initData может быть пустой — НЕ делаем белый экран
  if (!tg?.initData) {
    showHint("Нажми «Обновить» 2–3 раза. При открытии через «Открыть» Telegram иногда не отдаёт данные сразу.");
  }

  const r = await fetch("/api/dashboard/today", { headers: tgHeader() });
  const data = await r.json().catch(() => ({}));

  if (r.status === 401) {
    setStatus("нет доступа", true);
    showHint("Telegram не передал данные авторизации. Открой через кнопку WebApp у бота или нажми «Обновить».");
    return;
  }

  if (!r.ok || data.error) {
    if (data.error === "no_creds" || data.error === "keys_not_found") {
      setStatus("нужны ключи", true);
      showHint("Нажми «Ключи» и введи Client ID / API Key.");
      return;
    }
    setStatus("ошибка", true);
    showHint(data.error || ("HTTP " + r.status));
    return;
  }

  if (data.title) subtitleEl.textContent = data.title;

  ordersEl.textContent = data.orders ?? data.ordersCount ?? "—";
  ordersSumEl.textContent = fmtMoneyFromCents(data.orders_sum ?? data.ordersAmount);
  cancelsEl.textContent = data.cancels ?? data.cancelsCount ?? "—";
  cancelsSumEl.textContent = fmtMoneyFromCents(data.cancels_sum ?? data.cancelsAmount);

  setLastUpdated(data.updated_at);
  setStatus("актуально");
}

refreshBtn.addEventListener("click", () => bootLoad(true));

function setLoading(loading) {
  refreshBtn.disabled = loading;
  if (loading) refreshIcon.classList.add("spin");
  else refreshIcon.classList.remove("spin");
}

// Автоповтор, чтобы пережить сценарий “Открыть” (initData может появиться позже)
let tries = 0;
async function bootLoad(force = false) {
  try {
    if (force) tries = 0;
    setLoading(true);
    await loadDashboard();
  } finally {
    setLoading(false);
  }

  // Если initData пустой — пробуем ещё несколько раз
  const initData = tg?.initData || "";
  if (!initData && tries < 6) {
    tries += 1;
    setTimeout(() => {
      applyFullscreen();
      bootLoad(false);
    }, 350);
  }
}

// Доп. шанс: когда окно стало активным (часто после “Открыть”)
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    applyFullscreen();
    bootLoad(false);
  }
});

bootLoad(true);
