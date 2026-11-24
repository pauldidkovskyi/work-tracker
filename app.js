const SUPABASE_URL = 'https://pygpljyngiyprjsxwqbv.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_ypyFRd7r4Lh0aDOe6TdWtA_SgCZQ7lT';

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

const state = {
  mode: 'admin', // 'admin' | 'accountant'
  isAuthenticated: false,
  reportKey: null,
  shifts: [],
  openShift: null,
  selectedId: null,
  timerInterval: null,
  pendingConfirmAction: null
};

const $ = (id) => document.getElementById(id);

function toISODate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatTime(isoStr) {
  if (!isoStr) return '—';
  return new Date(isoStr).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
}

function formatInputTime(isoStr) {
  if (!isoStr) return '';
  const d = new Date(isoStr);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function formatDateUA(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('uk-UA', { weekday: 'short', day: '2-digit', month: '2-digit' });
}

function calcMinutes(shift) {
  if (!shift.check_in || !shift.check_out) return 0;
  return Math.max(0, Math.round((new Date(shift.check_out) - new Date(shift.check_in)) / 60000));
}

function calcElapsedMinutes(checkInIso) {
  return Math.max(0, Math.round((Date.now() - new Date(checkInIso)) / 60000));
}

function formatHM(totalMins) {
  const h = Math.floor(totalMins / 60);
  const m = totalMins % 60;
  return `${h}г ${String(m).padStart(2, '0')}хв`;
}

function formatDecimalUA(totalMins) {
  return (totalMins / 60).toFixed(2).replace('.', ',');
}

function pluralRecords(n) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} запис`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${n} записи`;
  return `${n} записів`;
}

function escapeHtml(str = '') {
  return str.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function showToast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add('hidden'), 2600);
}

// --- Універсальне вікно NFC / підтвердження ---
function showDialog({ icon, tone = 'green', title, subtitle, confirmText = null, closeText = 'Продовжити', onConfirm = null }) {
  const tones = {
    green: { color: 'var(--green)', bg: 'rgba(52, 199, 89, 0.16)' },
    red: { color: 'var(--red)', bg: 'rgba(255, 59, 48, 0.16)' },
    orange: { color: '#ff9500', bg: 'rgba(255, 149, 0, 0.16)' }
  };
  const palette = tones[tone] || tones.green;

  const iconEl = $('nfc-icon');
  iconEl.textContent = icon;
  iconEl.style.color = palette.color;
  iconEl.style.background = palette.bg;

  $('nfc-title').textContent = title;
  $('nfc-subtitle').textContent = subtitle;

  const confirmBtn = $('nfc-confirm-btn');
  const closeBtn = $('nfc-close-btn');

  if (onConfirm) {
    state.pendingConfirmAction = onConfirm;
    confirmBtn.textContent = confirmText || 'Підтвердити';
    confirmBtn.disabled = false;
    confirmBtn.classList.remove('hidden');
    closeBtn.textContent = closeText;
    closeBtn.className = 'btn btn-secondary';
  } else {
    state.pendingConfirmAction = null;
    confirmBtn.classList.add('hidden');
    closeBtn.textContent = closeText;
    closeBtn.className = 'btn btn-primary';
  }

  $('nfc-banner').classList.remove('hidden');
}

function closeDialog() {
  state.pendingConfirmAction = null;
  $('nfc-banner').classList.add('hidden');
}

// --- Періоди ---
function applyPreset(preset) {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  let start, end;

  if (preset === 'first-half') {
    start = new Date(y, m, 1);
    end = new Date(y, m, 15);
  } else if (preset === 'second-half') {
    start = new Date(y, m, 16);
    end = new Date(y, m + 1, 0);
  } else if (preset === 'full-month') {
    start = new Date(y, m, 1);
    end = new Date(y, m + 1, 0);
  } else if (preset === 'prev-month') {
    start = new Date(y, m - 1, 1);
    end = new Date(y, m, 0);
  }

  $('date-start').value = toISODate(start);
  $('date-end').value = toISODate(end);
  document.querySelectorAll('.chip').forEach((c) => {
    c.classList.toggle('active', c.dataset.preset === preset);
  });

  loadShifts();
}

// --- Ініціалізація ---
async function init() {
  const params = new URLSearchParams(window.location.search);
  const nfcToken = params.get('nfc');
  const reportKey = params.get('report');

  if (nfcToken) {
    window.history.replaceState({}, '', window.location.pathname);
    await handleNfcPunch(nfcToken, false);
  }

  if (reportKey) {
    state.mode = 'accountant';
    state.reportKey = reportKey;
    enterAppUI();
    return;
  }

  const { data: { session } } = await sb.auth.getSession();
  if (session) {
    state.mode = 'admin';
    state.isAuthenticated = true;
    enterAppUI();
  } else {
    $('login-view').classList.remove('hidden');
  }
}

async function handleNfcPunch(token, confirmClose = false) {
  const { data, error } = await sb.rpc('nfc_punch', {
    p_token: token,
    p_confirm_close: confirmClose
  });

  if (error) {
    showDialog({
      icon: '!',
      tone: 'red',
      title: 'Помилка NFC',
      subtitle: 'Невірний ключ мітки або помилка з’єднання.'
    });
    return;
  }

  if (data.action === 'confirm_close') {
    const mins = calcElapsedMinutes(data.shift.check_in);
    showDialog({
      icon: '?',
      tone: 'orange',
      title: 'Закрити зміну?',
      subtitle: `Зміна відкрита о ${formatTime(data.shift.check_in)} • Пройшло ${formatHM(mins)}`,
      confirmText: 'Так, закрити зміну',
      closeText: 'Ні, продовжити роботу',
      onConfirm: async () => {
        await handleNfcPunch(token, true);
        if (state.isAuthenticated && state.mode === 'admin') {
          await checkOpenShift();
          await loadShifts();
        }
      }
    });
    return;
  }

  if (data.action === 'check_in') {
    showDialog({
      icon: '✓',
      tone: 'green',
      title: 'Зміну відкрито',
      subtitle: `Прихід зафіксовано о ${formatTime(data.shift.check_in)}`
    });
  } else {
    const mins = calcMinutes(data.shift);
    showDialog({
      icon: '🏁',
      tone: 'green',
      title: 'Зміну закрито',
      subtitle: `Вихід о ${formatTime(data.shift.check_out)} • Відпрацьовано ${formatHM(mins)}`
    });
  }
}

async function enterAppUI() {
  $('login-view').classList.add('hidden');
  $('app-view').classList.remove('hidden');

  const isAdmin = state.mode === 'admin';
  $('app-view').classList.toggle('accountant-mode', !isAdmin);
  $('role-badge').classList.toggle('hidden', isAdmin);
  $('punch-btn').classList.toggle('hidden', !isAdmin);
  $('links-btn').classList.toggle('hidden', !isAdmin);
  $('logout-btn').classList.toggle('hidden', !isAdmin);
  $('add-shift-btn').classList.toggle('hidden', !isAdmin);

  if (isAdmin) await checkOpenShift();

  const today = new Date().getDate();
  applyPreset(today <= 15 ? 'first-half' : 'second-half');
}

// --- Завантаження змін ---
async function loadShifts() {
  const start = $('date-start').value;
  const end = $('date-end').value;
  if (!start || !end) return;

  $('table-wrap').classList.add('loading');

  let res;
  if (state.mode === 'accountant') {
    res = await sb.rpc('get_accountant_shifts', {
      p_key: state.reportKey,
      p_start: start,
      p_end: end
    });
  } else {
    res = await sb
      .from('shifts')
      .select('*')
      .gte('work_date', start)
      .lte('work_date', end)
      .order('work_date', { ascending: false })
      .order('check_in', { ascending: false });
  }

  $('table-wrap').classList.remove('loading');

  if (res.error) {
    $('shifts-tbody').innerHTML = `<tr><td colspan="5" class="empty-cell">Помилка доступу: ${escapeHtml(res.error.message)}</td></tr>`;
    syncEditorVisibility();
    return;
  }

  state.shifts = res.data || [];

  if (state.mode === 'admin' && state.shifts.length) {
    const stillExists = state.shifts.find((s) => s.id === state.selectedId);
    state.selectedId = stillExists ? stillExists.id : state.shifts[0].id;
  } else {
    state.selectedId = null;
  }

  renderTable();
  function renderStats() {
    const closed = state.shifts.filter((s) => s.check_out);
    const totalMins = closed.reduce((acc, s) => acc + calcMinutes(s), 0);
    const uniqueDays = new Set(state.shifts.map((s) => s.work_date)).size;
    const fullShifts = (totalMins / 480).toFixed(2).replace('.', ',');

    $('stat-hours').textContent = `${formatDecimalUA(totalMins)} год`;
    $('stat-hm').textContent = formatHM(totalMins);
    $('stat-days').textContent = uniqueDays;
    $('stat-shifts-count').textContent = pluralRecords(state.shifts.length);
    $('stat-avg').textContent = fullShifts;
    $('stat-period-label').textContent = `${$('date-start').value} — ${$('date-end').value}`;
  }
  syncEditorVisibility();
}

function syncEditorVisibility() {
  const isAdmin = state.mode === 'admin';
  const activeShift = isAdmin ? state.shifts.find((s) => s.id === state.selectedId) : null;

  if (activeShift) {
    $('workspace').classList.remove('single-col');
    $('editor-panel').classList.remove('hidden');
    renderEditor(activeShift);
  } else {
    $('workspace').classList.add('single-col');
    $('editor-panel').classList.add('hidden');
  }
}

async function checkOpenShift() {
  const { data } = await sb
    .from('shifts')
    .select('*')
    .is('check_out', null)
    .order('check_in', { ascending: false })
    .limit(1);

  state.openShift = data && data.length ? data[0] : null;
  updateLiveTimerUI();
}

function updateLiveTimerUI() {
  clearInterval(state.timerInterval);
  const pill = $('live-status');
  const btn = $('punch-btn');

  if (!state.openShift) {
    pill.classList.add('hidden');
    btn.textContent = 'Прийшов на роботу';
    btn.className = 'btn btn-green';
    return;
  }

  pill.classList.remove('hidden');
  btn.textContent = 'Закрити зміну';
  btn.className = 'btn btn-red';

  const tick = () => {
    const sec = Math.max(0, Math.floor((Date.now() - new Date(state.openShift.check_in)) / 1000));
    const h = String(Math.floor(sec / 3600)).padStart(2, '0');
    const m = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
    const s = String(sec % 60).padStart(2, '0');
    $('live-timer').textContent = `${h}:${m}:${s}`;
  };
  tick();
  state.timerInterval = setInterval(tick, 1000);
}

// --- Рендер ---
function renderTable() {
  const tbody = $('shifts-tbody');
  const isAdmin = state.mode === 'admin';

  if (!state.shifts.length) {
    tbody.innerHTML = `<tr><td colspan="${isAdmin ? 5 : 4}" class="empty-cell">За цей період змін ще немає</td></tr>`;
    return;
  }

  tbody.innerHTML = state.shifts.map((s) => {
    const isOpen = !s.check_out;
    const mins = calcMinutes(s);
    const durHtml = isOpen
      ? '<span class="status-open">На зміні</span>'
      : `<strong>${formatHM(mins)}</strong>`;
    const notePreview = s.notes ? escapeHtml(s.notes.split('\n')[0]) : '—';
    const selectedClass = isAdmin && s.id === state.selectedId ? 'selected' : '';

    return `
      <tr data-id="${s.id}" class="${selectedClass}">
        <td><strong>${formatDateUA(s.work_date)}</strong></td>
        <td>${formatTime(s.check_in)}</td>
        <td>${formatTime(s.check_out)}</td>
        <td>${durHtml}</td>
        <td class="note-preview col-notes">${notePreview}</td>
      </tr>
    `;
  }).join('');

  if (isAdmin) {
    tbody.querySelectorAll('tr[data-id]').forEach((row) => {
      row.addEventListener('click', () => {
        state.selectedId = row.dataset.id;
        renderTable();
        syncEditorVisibility();
      });
    });
  }
}

function renderStats() {
  const closed = state.shifts.filter((s) => s.check_out);
  const totalMins = closed.reduce((acc, s) => acc + calcMinutes(s), 0);
  const uniqueDays = new Set(state.shifts.map((s) => s.work_date)).size;
  const avgMins = closed.length ? Math.round(totalMins / closed.length) : 0;

  $('stat-hours').textContent = `${formatDecimalUA(totalMins)} год`;
  $('stat-hm').textContent = formatHM(totalMins);
  $('stat-days').textContent = uniqueDays;
  $('stat-shifts-count').textContent = pluralRecords(state.shifts.length);
  $('stat-avg').textContent = formatHM(avgMins);
  $('stat-period-label').textContent = `${$('date-start').value} — ${$('date-end').value}`;
}

function renderEditor(shift) {
  $('editor-date-title').textContent = formatDateUA(shift.work_date);
  $('editor-duration-badge').textContent = shift.check_out
    ? `Тривалість: ${formatHM(calcMinutes(shift))} (${formatDecimalUA(calcMinutes(shift))} год)`
    : 'Зміна ще триває';

  $('edit-date').value = shift.work_date;
  $('edit-in').value = formatInputTime(shift.check_in);
  $('edit-out').value = formatInputTime(shift.check_out);
  $('edit-notes').value = shift.notes || '';
  $('save-status').textContent = '';

  // Показуємо «Продовжити зміну», якщо ця зміна закрита і немає іншої активної
  const canResume = Boolean(shift.check_out) && !state.openShift;
  $('resume-shift-btn').classList.toggle('hidden', !canResume);
}

// --- Дії адміна ---
async function closeOpenShift() {
  if (!state.openShift) return;
  const { error } = await sb
    .from('shifts')
    .update({ check_out: new Date().toISOString() })
    .eq('id', state.openShift.id);

  closeDialog();
  if (error) return showToast('Помилка: ' + error.message);

  showToast('Зміну закрито');
  await checkOpenShift();
  await loadShifts();
}

async function togglePunch() {
  if (state.openShift) {
    const mins = calcElapsedMinutes(state.openShift.check_in);
    showDialog({
      icon: '?',
      tone: 'orange',
      title: 'Закрити зміну?',
      subtitle: `Зміна відкрита о ${formatTime(state.openShift.check_in)} • Пройшло ${formatHM(mins)}`,
      confirmText: 'Так, закрити зміну',
      closeText: 'Ні, продовжити роботу',
      onConfirm: closeOpenShift
    });
    return;
  }

  const { data, error } = await sb
    .from('shifts')
    .insert({ work_date: toISODate(new Date()), check_in: new Date().toISOString() })
    .select()
    .single();

  if (error) return showToast('Помилка: ' + error.message);
  state.selectedId = data.id;
  showToast('Зміну відкрито');

  await checkOpenShift();
  await loadShifts();
}

async function resumeCurrentShift() {
  if (!state.selectedId) return;
  if (state.openShift) return showToast('Вже є інша відкрита зміна');

  const { error } = await sb
    .from('shifts')
    .update({ check_out: null })
    .eq('id', state.selectedId);

  if (error) return showToast('Помилка: ' + error.message);

  showToast('Зміну продовжено — таймер знову працює');
  await checkOpenShift();
  await loadShifts();
}

async function addManualShift() {
  const today = toISODate(new Date());
  const checkIn = new Date(`${today}T09:00:00`).toISOString();
  const checkOut = new Date(`${today}T18:00:00`).toISOString();

  const { data, error } = await sb
    .from('shifts')
    .insert({ work_date: today, check_in: checkIn, check_out: checkOut, notes: '' })
    .select()
    .single();

  if (error) return showToast('Помилка: ' + error.message);

  state.selectedId = data.id;
  await loadShifts();
  showToast('Додано зміну');
}

async function saveCurrentShift() {
  if (!state.selectedId) return;
  const dateVal = $('edit-date').value;
  const inVal = $('edit-in').value;
  const outVal = $('edit-out').value;
  const notesVal = $('edit-notes').value;

  if (!dateVal || !inVal) return showToast('Вкажи дату та час приходу');

  const checkInDate = new Date(`${dateVal}T${inVal}:00`);
  let checkOutISO = null;
  if (outVal) {
    const checkOutDate = new Date(`${dateVal}T${outVal}:00`);
    if (checkOutDate < checkInDate) checkOutDate.setDate(checkOutDate.getDate() + 1);
    checkOutISO = checkOutDate.toISOString();
  }

  $('save-status').textContent = 'Збереження...';
  const { error } = await sb
    .from('shifts')
    .update({
      work_date: dateVal,
      check_in: checkInDate.toISOString(),
      check_out: checkOutISO,
      notes: notesVal
    })
    .eq('id', state.selectedId);

  if (error) {
    $('save-status').textContent = 'Помилка';
    return showToast(error.message);
  }

  $('save-status').textContent = 'Збережено ✓';
  await checkOpenShift();
  await loadShifts();
}

async function deleteCurrentShift() {
  if (!state.selectedId) return;
  if (!confirm('Видалити цю зміну безповоротно?')) return;

  const { error } = await sb.from('shifts').delete().eq('id', state.selectedId);
  if (error) return showToast(error.message);

  state.selectedId = null;
  await checkOpenShift();
  await loadShifts();
  showToast('Зміну видалено');
}

// --- Експорт ---
function buildExportRows() {
  const isAdmin = state.mode === 'admin';
  const sorted = [...state.shifts].sort((a, b) => a.work_date.localeCompare(b.work_date));
  const header = isAdmin
    ? ['Дата', 'Прихід', 'Вихід', 'Тривалість', 'Години', 'Нотатки']
    : ['Дата', 'Прихід', 'Вихід', 'Тривалість', 'Години'];
  let totalMins = 0;

  const rows = sorted.map((s) => {
    const mins = calcMinutes(s);
    totalMins += mins;
    const base = [
      s.work_date,
      formatTime(s.check_in),
      formatTime(s.check_out),
      s.check_out ? formatHM(mins) : 'В процесі',
      s.check_out ? formatDecimalUA(mins) : '0,00'
    ];
    if (isAdmin) base.push((s.notes || '').replace(/\r?\n/g, ' | ').replace(/\t/g, ' '));
    return base;
  });

  const totalRow = isAdmin
    ? ['РАЗОМ', '', '', formatHM(totalMins), formatDecimalUA(totalMins), '']
    : ['РАЗОМ', '', '', formatHM(totalMins), formatDecimalUA(totalMins)];
  rows.push(totalRow);

  return [header, ...rows];
}

async function copyForSheets() {
  if (!state.shifts.length) return showToast('Немає даних для копіювання');
  const tsv = buildExportRows().map((r) => r.join('\t')).join('\n');
  await navigator.clipboard.writeText(tsv);
  showToast('Скопійовано! Вставляй у Excel або Google Sheets');
}

function exportCsv() {
  if (!state.shifts.length) return showToast('Немає даних для експорту');
  const csv = '\uFEFF' + buildExportRows()
    .map((r) => r.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(';'))
    .join('\n');

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `worklog_${$('date-start').value}_${$('date-end').value}.csv`;
  a.click();
}

// --- Модалка посилань ---
async function openLinksModal() {
  const { data, error } = await sb.from('app_settings').select('key, value');
  if (error) return showToast('Не вдалося завантажити ключі');

  const map = Object.fromEntries(data.map((r) => [r.key, r.value]));
  const baseUrl = window.location.origin + window.location.pathname;

  $('nfc-url-input').value = `${baseUrl}?nfc=${map.nfc_token || ''}`;
  $('report-url-input').value = `${baseUrl}?report=${map.accountant_key || ''}`;
  $('links-modal').classList.remove('hidden');
}

// --- Події ---
$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('login-error').classList.add('hidden');
  const { error } = await sb.auth.signInWithPassword({
    email: $('login-email').value.trim(),
    password: $('login-password').value
  });

  if (error) {
    $('login-error').textContent = 'Невірний email або пароль';
    $('login-error').classList.remove('hidden');
    return;
  }
  state.mode = 'admin';
  state.isAuthenticated = true;
  enterAppUI();
});

$('logout-btn').addEventListener('click', async () => {
  await sb.auth.signOut();
  window.location.reload();
});

$('punch-btn').addEventListener('click', togglePunch);
$('resume-shift-btn').addEventListener('click', resumeCurrentShift);
$('add-shift-btn').addEventListener('click', addManualShift);
$('save-shift-btn').addEventListener('click', saveCurrentShift);
$('delete-shift-btn').addEventListener('click', deleteCurrentShift);
$('copy-tsv-btn').addEventListener('click', copyForSheets);
$('export-csv-btn').addEventListener('click', exportCsv);
$('links-btn').addEventListener('click', openLinksModal);
$('close-modal-btn').addEventListener('click', () => $('links-modal').classList.add('hidden'));
$('nfc-close-btn').addEventListener('click', closeDialog);

$('nfc-confirm-btn').addEventListener('click', async () => {
  if (!state.pendingConfirmAction) return;
  const action = state.pendingConfirmAction;
  $('nfc-confirm-btn').disabled = true;
  await action();
});

document.querySelectorAll('.chip').forEach((btn) => {
  btn.addEventListener('click', () => applyPreset(btn.dataset.preset));
});

['date-start', 'date-end'].forEach((id) => {
  $(id).addEventListener('change', () => {
    document.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
    loadShifts();
  });
});

document.querySelectorAll('[data-copy-target]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    await navigator.clipboard.writeText($(btn.dataset.copyTarget).value);
    showToast('Посилання скопійовано');
  });
});

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's' && state.mode === 'admin' && state.selectedId) {
    e.preventDefault();
    saveCurrentShift();
  }
});

init();
