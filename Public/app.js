// fullscreen + стабильная высота Telegram
const tg = window.Telegram?.WebApp;
if (tg) {
  tg.ready();
  tg.expand();
  tg.disableVerticalSwipes?.();
  tg.requestFullscreen?.();
  try { tg.onEvent?.("viewportChanged", () => { tg.expand(); tg.requestFullscreen?.(); }); } catch (_) {}
}

const $ = (id) => document.getElementById(id);

const datePill = $("datePill");
const countEl = $("count");
const sumEl = $("sum");
const hintEl = $("hint");
const statusPill = $("statusPill");

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
  // оставляем оба варианта, чтобы совпасть с backend в любой версии
  return initData ? { "x-telegram-init-data": initData, "X-Tg-Init-Data": initData } : {};
}

function showHint(msg) {
  hintEl.textContent = msg || "";
  hintEl.style.display = msg ? "block" : "none";
}

function setStatus(text, danger = false) {
  statusPill.textContent = text;
  statusPill.className = danger ? "badge danger" : "badge";
}

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
modal.addEventListener("click", (e) => { if (e.target === modal) close(); });

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
    if (!r.ok || !j.ok) throw new Error(j.error || ("HTTP " + r.status));

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
    if (!r.ok || !j.ok) throw new Error(j.error || ("HTTP " + r.status));

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
    keysStatus.textContent = "Откройте приложение внутри Telegram (не в браузере).";
    return;
  }
  if (r.status === 404) {
    keysStatus.textContent = "Ключи не найдены. Введите Client ID / API Key.";
    return;
  }
  if (!r.ok || !j.ok) {
    keysStatus.textContent = j.error || ("HTTP " + r.status);
    return;
  }

  keysStatus.textContent = "Ключи найдены ✅";
  clientIdInp.value = j.clientId || "";
  apiKeyInp.value = "";
}

async function refresh() {
  showHint("");
  setStatus("обновление…");
  countEl.textContent = "—";
  sumEl.textContent = "";
  datePill.textContent = "…";

  // 1) сначала пробуем старый эндпоинт
  let r = await fetch("/api/today", { headers: initDataHeader() });
  let j = await r.json().catch(() => ({}));

  // 2) если его нет — пробуем текущий рабочий у тебя (/api/dashboard/today)
  if (r.status === 404) {
    r = await fetch("/api/dashboard/today", { headers: initDataHeader() });
    j = await r.json().catch(() => ({}));
  }

  if (r.status === 401) {
    setStatus("нет доступа", true);
    showHint("Откройте приложение внутри Telegram.");
    return;
  }

  if ((r.status === 404 && j.error === "keys_not_found") || j.error === "no_creds") {
    setStatus("нужны ключи", true);
    showHint("Нажмите «Ключи» и введите Client ID / API Key.");
    return;
  }

  if (!r.ok || j.ok === false) {
    setStatus("ошибка", true);
    showHint(j.error || ("HTTP " + r.status));
    return;
  }

  // поддерживаем оба формата ответов
  const count = j.count ?? j.orders ?? j.ordersCount ?? 0;
  const sum = j.sum ?? j.orders_sum ?? j.ordersAmount;

  datePill.textContent = j.date || "Сегодня";
  countEl.textContent = String(count);

  if (Number.isFinite(sum) && sum > 0) {
    // если пришло в копейках
    const rub = (sum > 100000 ? sum / 100 : sum);
    sumEl.textContent = `Сумма: ${Math.round(rub).toLocaleString("ru-RU")} ₽`;
  } else {
    sumEl.textContent = "";
  }

  setStatus("готово");
}

refresh().catch(() => {});
