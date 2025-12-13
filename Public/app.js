const tg = window.Telegram?.WebApp;
if (tg) {
  tg.ready();
  tg.expand();
}

const $ = (id) => document.getElementById(id);

const datePill = $("datePill");
const countEl = $("count");
const sumEl = $("sum");
const hintEl = $("hint");

const refreshBtn = $("refreshBtn");
const keysBtn = $("keysBtn");

const modal = $("modal");
const closeModal = $("closeModal");
const clientIdInp = $("clientId");
const apiKeyInp = $("apiKey");
const saveKeysBtn = $("saveKeys");
const deleteKeysBtn = $("deleteKeys");
const keysStatus = $("keysStatus");

function initDataHeader() {
  const initData = tg?.initData || "";
  return initData ? { "x-telegram-init-data": initData } : {};
}

function showHint(msg) {
  hintEl.textContent = msg || "";
}

function openModal() {
  modal.hidden = false;
  showHint("");
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

refreshBtn.addEventListener("click", () => refresh().catch(() => {}));

saveKeysBtn.addEventListener("click", async () => {
  keysStatus.textContent = "";
  try {
    const clientId = clientIdInp.value.trim();
    const apiKey = apiKeyInp.value.trim();
    if (!clientId || !apiKey) {
      keysStatus.textContent = "Заполните Client ID и API Key";
      return;
    }
    const r = await fetch("/api/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...initDataHeader() },
      body: JSON.stringify({ clientId, apiKey }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw new Error(j.error || "Ошибка сохранения");
    keysStatus.textContent = "Сохранено ✅";
    close();
    await refresh();
  } catch (e) {
    keysStatus.textContent = String(e.message || e);
  }
});

deleteKeysBtn.addEventListener("click", async () => {
  keysStatus.textContent = "";
  try {
    const r = await fetch("/api/keys", { method: "DELETE", headers: initDataHeader() });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw new Error(j.error || "Ошибка удаления");
    clientIdInp.value = "";
    apiKeyInp.value = "";
    keysStatus.textContent = "Удалено ✅";
    await refresh();
  } catch (e) {
    keysStatus.textContent = String(e.message || e);
  }
});

async function loadKeys() {
  keysStatus.textContent = "";
  const r = await fetch("/api/keys", { headers: initDataHeader() });
  const j = await r.json().catch(() => ({}));

  if (r.status === 401) {
    keysStatus.textContent = "Откройте приложение внутри Telegram (не в обычном браузере).";
    return;
  }
  if (!r.ok) {
    keysStatus.textContent = "Ключи не найдены. Введите Client ID / API Key.";
    return;
  }
  keysStatus.textContent = "Ключи найдены ✅";
  clientIdInp.value = j.clientId || "";
  apiKeyInp.value = ""; // never show real key back
}

async function refresh() {
  showHint("");
  countEl.textContent = "—";
  sumEl.textContent = "";
  datePill.textContent = "…";

  const r = await fetch("/api/today", { headers: initDataHeader() });
  const j = await r.json().catch(() => ({}));

  if (r.status === 401) {
    showHint("Откройте приложение внутри Telegram.");
    return;
  }
  if (r.status === 404 && j.error === "keys_not_found") {
    showHint("Ключи не найдены. Нажмите «Ключи» и введите Client ID / API Key.");
    return;
  }
  if (!r.ok || !j.ok) {
    showHint(j.error || "Ошибка получения данных");
    return;
  }

  datePill.textContent = j.date || "Сегодня";
  countEl.textContent = String(j.count ?? 0);

  if (Number.isFinite(j.sum) && j.sum > 0) {
    sumEl.textContent = `Сумма: ${Math.round(j.sum).toLocaleString("ru-RU")} ₽`;
  } else {
    sumEl.textContent = "";
  }
}

refresh().catch(() => {});
