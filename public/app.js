/* global Telegram */
const tg = window.Telegram?.WebApp;
try { tg?.ready?.(); } catch {}

const $ = (id) => document.getElementById(id);
const salesCountEl = $('salesCount');
const salesSumEl = $('salesSum');
const hintEl = $('hint');
const statusEl = $('status');
const todayPill = $('todayPill');

const modal = $('modal');
const closeModalBtn = $('closeModal');
const keysBtn = $('keysBtn');
const refreshBtn = $('refreshBtn');
const saveKeysBtn = $('saveKeys');
const disconnectBtn = $('disconnect');
const clientIdInp = $('clientId');
const apiKeyInp = $('apiKey');
const modalError = $('modalError');

function initDataHeader() {
  const initData = tg?.initData || '';
  return initData ? { 'x-telegram-init-data': initData } : {};
}

function setHint(text, kind) {
  hintEl.textContent = text || '';
  hintEl.className = 'hint' + (kind ? ` hint--${kind}` : '');
}

function setStatus(text) {
  statusEl.textContent = text || '';
}

function formatMoneyRub(n) {
  if (typeof n !== 'number') return '';
  return n.toLocaleString('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 0 });
}

function openModal() {
  modalError.textContent = '';
  modal.hidden = false;
}

function closeModal() {
  modal.hidden = true;
}

async function api(path, options = {}) {
  const headers = {
    'content-type': 'application/json',
    ...initDataHeader(),
    ...(options.headers || {}),
  };
  const res = await fetch(path, { ...options, headers });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* ignore */ }
  if (!res.ok) {
    const msg = json?.error || json?.details || text || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return json;
}

async function loadMe() {
  // date label
  const now = new Date();
  todayPill.textContent = `Сегодня • ${String(now.getDate()).padStart(2,'0')}.${String(now.getMonth()+1).padStart(2,'0')}`;

  // If opened outside Telegram — show warning, but keep UI usable.
  if (!tg?.initData) {
    setHint('Открой мини‑приложение внутри Telegram, иначе ключи не привяжутся к аккаунту.', 'danger');
    setStatus('initData нет (не Telegram WebApp)');
    return;
  }

  const me = await api('/api/me');
  if (me.connected) {
    setHint('Ключи подключены. Нажми «Обновить».', 'ok');
    setStatus(`user: ${me.tgUserId}`);
  } else {
    setHint('Ключи не найдены. Нажми «Ключи» и введи Client‑Id / Api‑Key.', 'danger');
    setStatus(`user: ${me.tgUserId}`);
  }
}

async function refreshSales() {
  try {
    setHint('Обновляю…');
    const data = await api('/api/today');
    salesCountEl.textContent = String(data.orders_count ?? '—');
    salesSumEl.textContent = typeof data.orders_sum === 'number' ? `Сумма: ${formatMoneyRub(data.orders_sum)}` : '';
    setHint('Данные обновлены.', 'ok');
  } catch (e) {
    salesCountEl.textContent = '—';
    salesSumEl.textContent = '—';
    setHint(`Ошибка: ${e.message}`, 'danger');
  }
}

keysBtn.addEventListener('click', async () => {
  openModal();
  // Try to prefill with existing values
  try {
    const me = await api('/api/me');
    clientIdInp.value = me.clientId || '';
  } catch {}
});

closeModalBtn.addEventListener('click', closeModal);
modal.addEventListener('click', (e) => {
  if (e.target === modal) closeModal();
});

saveKeysBtn.addEventListener('click', async () => {
  modalError.textContent = '';
  const clientId = clientIdInp.value.trim();
  const apiKey = apiKeyInp.value.trim();
  if (!clientId || !apiKey) {
    modalError.textContent = 'Заполни оба поля.';
    return;
  }
  try {
    await api('/api/connect', {
      method: 'POST',
      body: JSON.stringify({ clientId, apiKey })
    });
    closeModal();
    await loadMe();
    await refreshSales();
  } catch (e) {
    modalError.textContent = `Ошибка: ${e.message}`;
  }
});

disconnectBtn.addEventListener('click', async () => {
  modalError.textContent = '';
  try {
    await api('/api/disconnect', { method: 'POST' });
    clientIdInp.value = '';
    apiKeyInp.value = '';
    closeModal();
    await loadMe();
    salesCountEl.textContent = '—';
    salesSumEl.textContent = '—';
  } catch (e) {
    modalError.textContent = `Ошибка: ${e.message}`;
  }
});

refreshBtn.addEventListener('click', refreshSales);

(async () => {
  await loadMe();
  // if connected - auto refresh once
  try {
    const me = await api('/api/me');
    if (me.connected) await refreshSales();
  } catch {}
})();
