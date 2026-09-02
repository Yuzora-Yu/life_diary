'use strict';

const APP_VERSION = '1.2.3';
const SCHEMA_VERSION = 2;
const DB_NAME = 'komorebi-record-db';
const DB_VERSION = 1;
const STORE_NAME = 'kv';
const STATE_KEY = 'state';
const SHADOW_KEY = 'komorebi-record-shadow-v1';
const MAX_SNAPSHOTS = 8;
const AUTO_SNAPSHOT_INTERVAL = 6 * 60 * 60 * 1000;
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

let state;
let db = null;
let currentView = 'calendar';
let currentWeekDate = startOfWeek(new Date());
let currentCalendarMonth = startOfMonth(new Date());
let selectedCalendarDate = toDateKey(new Date());
let saveTimer = null;
let savePromise = Promise.resolve();
let toastTimer = null;
let primaryStorageOkay = true;
let shadowStorageOkay = true;
let serviceWorkerReloading = false;

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function defaultState() {
  const now = new Date().toISOString();
  return {
    schemaVersion: SCHEMA_VERSION,
    appVersion: APP_VERSION,
    records: {},
    weekGoals: {},
    settings: { weekStartsOn: 1 },
    meta: {
      createdAt: now,
      updatedAt: now,
      lastSnapshotAt: null,
      lastBackupAt: null
    }
  };
}

function defaultRecord() {
  return {
    amActivity: '', amMood: '', pmActivity: '', pmMood: '', reflection: '',
    goal1Result: '', goal2Result: '', updatedAt: null
  };
}

function deepClone(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function isValidState(value) {
  if (!value || typeof value !== 'object' || !value.records || typeof value.records !== 'object') return false;
  const version = Number(value.schemaVersion);
  if (version === 1) return !!value.monthGoals && typeof value.monthGoals === 'object';
  if (version === 2) return !!value.weekGoals && typeof value.weekGoals === 'object';
  return false;
}

function migrateLegacyMonthGoals(monthGoals, weekStartsOn) {
  const legacy = monthGoals && typeof monthGoals === 'object' ? monthGoals : {};
  const candidates = new Set();
  for (const monthKey of Object.keys(legacy)) {
    const match = /^(\d{4})-(\d{2})$/.exec(monthKey);
    if (!match) continue;
    const year = Number(match[1]);
    const monthIndex = Number(match[2]) - 1;
    const daysInMonth = new Date(year, monthIndex + 1, 0, 12).getDate();
    for (let day = 1; day <= daysInMonth; day++) {
      candidates.add(toDateKey(startOfWeek(new Date(year, monthIndex, day, 12), weekStartsOn)));
    }
  }

  const migrated = {};
  for (const weekKey of candidates) {
    const weekStart = parseDateKey(weekKey);
    const midpointMonthKey = toMonthKey(addDays(weekStart, 3));
    let source = legacy[midpointMonthKey];

    // If the midpoint month had no goal, use the goal-bearing month with the most days in this week.
    // This keeps edge-of-month goals from disappearing when only one adjacent month had goals.
    if (!source || (!source.goal1 && !source.goal2)) {
      const overlapCounts = {};
      for (let i = 0; i < 7; i++) {
        const key = toMonthKey(addDays(weekStart, i));
        const candidate = legacy[key];
        if (!candidate || (!candidate.goal1 && !candidate.goal2)) continue;
        overlapCounts[key] = (overlapCounts[key] || 0) + 1;
      }
      const fallbackKey = Object.entries(overlapCounts).sort((a, b) => b[1] - a[1])[0]?.[0];
      source = fallbackKey ? legacy[fallbackKey] : null;
    }

    if (!source) continue;
    migrated[weekKey] = {
      goal1: source.goal1 || '',
      goal2: source.goal2 || '',
      updatedAt: source.updatedAt || null
    };
  }
  return migrated;
}

function normalizeState(input) {
  const base = defaultState();
  if (!isValidState(input)) return base;
  const settings = { ...base.settings, ...(input.settings || {}) };
  settings.weekStartsOn = normalizeWeekStartsOn(settings.weekStartsOn);
  const weekGoals = Number(input.schemaVersion) === 1
    ? migrateLegacyMonthGoals(input.monthGoals, settings.weekStartsOn)
    : deepClone(input.weekGoals || {});
  return {
    schemaVersion: SCHEMA_VERSION,
    appVersion: APP_VERSION,
    records: deepClone(input.records || {}),
    weekGoals,
    settings,
    meta: { ...base.meta, ...(input.meta || {}) }
  };
}

function updatedMs(s) {
  const t = Date.parse(s?.meta?.updatedAt || '');
  return Number.isFinite(t) ? t : 0;
}

function openDatabase() {
  return new Promise((resolve) => {
    if (!('indexedDB' in window)) return resolve(null);
    let request;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      return resolve(null);
    }
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

function dbGet(key) {
  return new Promise((resolve, reject) => {
    if (!db) return resolve(undefined);
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dbPut(key, value) {
  return new Promise((resolve, reject) => {
    if (!db) return reject(new Error('IndexedDB unavailable'));
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('IndexedDB write failed'));
    tx.onabort = () => reject(tx.error || new Error('IndexedDB write aborted'));
  });
}

function dbDelete(key) {
  return new Promise((resolve, reject) => {
    if (!db) return resolve();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function dbKeys() {
  return new Promise((resolve, reject) => {
    if (!db) return resolve([]);
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    if (store.getAllKeys) {
      const req = store.getAllKeys();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
      return;
    }
    const keys = [];
    const req = store.openKeyCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return resolve(keys);
      keys.push(cursor.key); cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

function readShadow() {
  try {
    const raw = localStorage.getItem(SHADOW_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return isValidState(parsed) ? normalizeState(parsed) : null;
  } catch {
    shadowStorageOkay = false;
    return null;
  }
}

function writeShadow(value) {
  try {
    localStorage.setItem(SHADOW_KEY, JSON.stringify(value));
    shadowStorageOkay = true;
    return true;
  } catch {
    shadowStorageOkay = false;
    return false;
  }
}

async function loadState() {
  db = await openDatabase();
  primaryStorageOkay = !!db;
  let primary = null;
  let primarySchemaVersion = null;
  if (db) {
    try {
      const candidate = await dbGet(STATE_KEY);
      if (isValidState(candidate)) {
        primarySchemaVersion = Number(candidate.schemaVersion);
        primary = normalizeState(candidate);
      }
    } catch {
      primaryStorageOkay = false;
    }
  }
  const shadow = readShadow();
  const chosen = primary && shadow ? (updatedMs(shadow) > updatedMs(primary) ? shadow : primary) : (primary || shadow || defaultState());
  state = normalizeState(chosen);

  // Repair whichever local copy is missing/stale, and persist schema migrations.
  if (db && (!primary || primarySchemaVersion !== SCHEMA_VERSION || updatedMs(state) > updatedMs(primary))) {
    try { await dbPut(STATE_KEY, deepClone(state)); primaryStorageOkay = true; } catch { primaryStorageOkay = false; }
  }
  writeShadow(state);
}

function setSaveIndicator(mode, text) {
  const el = $('#saveIndicator');
  el.classList.toggle('is-saving', mode === 'saving');
  el.classList.toggle('is-error', mode === 'error');
  $('#saveText').textContent = text;
}

function scheduleSave() {
  setSaveIndicator('saving', '保存中…');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    savePromise = savePromise.then(persistState).catch(() => {});
  }, 450);
}

async function flushSave() {
  clearTimeout(saveTimer);
  saveTimer = null;
  savePromise = savePromise.then(persistState).catch(() => {});
  return savePromise;
}

async function persistState() {
  const now = new Date();
  const nowIso = now.toISOString();
  state.meta.updatedAt = nowIso;
  state.appVersion = APP_VERSION;

  const lastSnapshot = Date.parse(state.meta.lastSnapshotAt || '');
  const snapshotDue = !Number.isFinite(lastSnapshot) || now.getTime() - lastSnapshot >= AUTO_SNAPSHOT_INTERVAL;
  if (snapshotDue) state.meta.lastSnapshotAt = nowIso;

  let primarySaved = false;
  let shadowSaved = false;
  if (db) {
    try {
      await dbPut(STATE_KEY, deepClone(state));
      primaryStorageOkay = true;
      primarySaved = true;
      if (snapshotDue) {
        await dbPut(`snapshot:${nowIso}`, { createdAt: nowIso, reason: '自動', state: deepClone(state) });
        await pruneSnapshots();
      }
    } catch (err) {
      console.error(err);
      primaryStorageOkay = false;
    }
  }
  shadowSaved = writeShadow(state);

  updateStorageUi();
  if (primarySaved && shadowSaved) setSaveIndicator('saved', '保存済み（2重保存）');
  else if (primarySaved || shadowSaved) setSaveIndicator('saved', '保存済み（予備経路）');
  else setSaveIndicator('error', '保存できません');
}

async function createSnapshotInternal(reason = '手動') {
  if (!db) throw new Error('IndexedDB unavailable');
  const nowIso = new Date().toISOString();
  await dbPut(`snapshot:${nowIso}`, { createdAt: nowIso, reason, state: deepClone(state) });
  state.meta.lastSnapshotAt = nowIso;
  await pruneSnapshots();
  return nowIso;
}

async function pruneSnapshots() {
  if (!db) return;
  const keys = (await dbKeys()).filter(k => String(k).startsWith('snapshot:')).sort().reverse();
  for (const key of keys.slice(MAX_SNAPSHOTS)) await dbDelete(key);
}

async function getSnapshots() {
  if (!db) return [];
  const keys = (await dbKeys()).filter(k => String(k).startsWith('snapshot:')).sort().reverse();
  const values = [];
  for (const key of keys.slice(0, MAX_SNAPSHOTS)) {
    try {
      const item = await dbGet(key);
      if (item?.state) values.push({ key, ...item });
    } catch {}
  }
  return values;
}

function toDateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
}
function toMonthKey(date) { return toDateKey(date).slice(0,7); }
function parseDateKey(key) {
  const [y,m,d] = key.split('-').map(Number);
  return new Date(y, m-1, d, 12, 0, 0, 0);
}
function addDays(date, days) { const d = new Date(date); d.setDate(d.getDate()+days); return d; }
function normalizeWeekStartsOn(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= 6 ? n : 1;
}
function getWeekStartsOn() { return normalizeWeekStartsOn(state?.settings?.weekStartsOn ?? 1); }
function startOfWeek(date, weekStartsOn = getWeekStartsOn()) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12);
  const offset = (d.getDay() - normalizeWeekStartsOn(weekStartsOn) + 7) % 7;
  d.setDate(d.getDate() - offset);
  return d;
}
function startOfMonth(date) { return new Date(date.getFullYear(), date.getMonth(), 1, 12); }
function addMonths(date, amount) { return new Date(date.getFullYear(), date.getMonth()+amount, 1, 12); }
function sameDay(a, b) { return toDateKey(a) === toDateKey(b); }
function sameMonth(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth(); }
function monthLabel(date) { return `${date.getFullYear()}年${date.getMonth()+1}月`; }
function dateFullLabel(date) { return `${date.getFullYear()}年${date.getMonth()+1}月${date.getDate()}日（${WEEKDAYS[date.getDay()]}）`; }
function displayDateShort(date) { return `${date.getMonth()+1}/${date.getDate()}`; }
function weekKeyForDate(dateOrKey, weekStartsOn = getWeekStartsOn()) {
  const date = typeof dateOrKey === 'string' ? parseDateKey(dateOrKey) : dateOrKey;
  return toDateKey(startOfWeek(date, weekStartsOn));
}
function weekRangeLabel(start) {
  const end = addDays(start, 6);
  const startText = `${start.getMonth()+1}/${start.getDate()}（${WEEKDAYS[start.getDay()]}）`;
  const endText = `${end.getMonth()+1}/${end.getDate()}（${WEEKDAYS[end.getDay()]}）`;
  return start.getFullYear() === end.getFullYear()
    ? `${start.getFullYear()}年 ${startText} 〜 ${endText}`
    : `${start.getFullYear()}年 ${startText} 〜 ${end.getFullYear()}年 ${endText}`;
}
function htmlEscape(value) {
  return String(value ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
}

function getRecord(dateKey) {
  return { ...defaultRecord(), ...(state.records[dateKey] || {}) };
}
function getOrCreateRecord(dateKey) {
  if (!state.records[dateKey]) state.records[dateKey] = defaultRecord();
  return state.records[dateKey];
}
function getWeekGoals(weekKey) {
  return { goal1: '', goal2: '', updatedAt: null, ...(state.weekGoals[weekKey] || {}) };
}
function getWeekGoalsForDate(dateOrKey) { return getWeekGoals(weekKeyForDate(dateOrKey)); }
function ensureWeekGoals(weekKey) {
  if (!state.weekGoals[weekKey]) state.weekGoals[weekKey] = { goal1:'', goal2:'', updatedAt:null };
  return state.weekGoals[weekKey];
}
function hasRecordContent(record) {
  if (!record) return false;
  return ['amActivity','amMood','pmActivity','pmMood','reflection','goal1Result','goal2Result'].some(k => String(record[k] ?? '').trim() !== '');
}
function averageMood(record) {
  const vals = [record?.amMood, record?.pmMood]
    .filter(v => String(v ?? '').trim() !== '')
    .map(Number)
    .filter(Number.isFinite);
  return vals.length ? Math.round(vals.reduce((a,b)=>a+b,0)/vals.length) : null;
}


function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('is-showing');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('is-showing'), 2800);
}

function navigate(view) {
  currentView = view;
  $$('.view').forEach(el => el.classList.toggle('is-visible', el.id === `view-${view}`));
  $$('.nav-btn').forEach(btn => btn.classList.toggle('is-active', btn.dataset.nav === view));
  renderView(view);
  window.scrollTo({ top: 0, behavior: 'instant' });
}
function renderView(view) {
  if (view === 'week') renderWeek();
  if (view === 'calendar') renderCalendar();
  if (view === 'list') renderList();
  if (view === 'settings') renderSettings();
}

function cloneDailyFields(dateKey) {
  const frag = $('#dailyFieldsTemplate').content.cloneNode(true);
  const root = $('.daily-fields', frag);
  hydrateDailyFields(root, dateKey);
  bindDailyFields(root, dateKey);
  return frag;
}

function hydrateDailyFields(root, dateKey) {
  const record = getRecord(dateKey);
  for (const el of $$('[data-field]', root)) {
    const field = el.dataset.field;
    if (field === 'amMoodNumber') el.value = record.amMood;
    else if (field === 'pmMoodNumber') el.value = record.pmMood;
    else if (field === 'amMood' || field === 'pmMood') el.value = record[field] === '' ? 50 : record[field];
    else el.value = record[field] ?? '';
  }
  const goals = getWeekGoalsForDate(dateKey);
  const g1 = $('[data-goal-label="1"]', root);
  const g2 = $('[data-goal-label="2"]', root);
  if (g1) g1.textContent = `① ${goals.goal1 ? goals.goal1 : '目標1の結果'}`;
  if (g2) g2.textContent = `② ${goals.goal2 ? goals.goal2 : '目標2の結果'}`;
}

function bindDailyFields(root, dateKey) {
  const rangePairs = [
    { range: $('[data-field="amMood"]', root), number: $('[data-field="amMoodNumber"]', root), field: 'amMood' },
    { range: $('[data-field="pmMood"]', root), number: $('[data-field="pmMoodNumber"]', root), field: 'pmMood' }
  ];

  for (const {range, number, field} of rangePairs) {
    range.addEventListener('input', () => {
      number.value = range.value;
      updateRecordField(dateKey, field, range.value);
    });
    number.addEventListener('input', () => {
      const raw = number.value;
      if (raw === '') {
        updateRecordField(dateKey, field, '');
        return;
      }
      const clamped = Math.max(0, Math.min(100, Number(raw)));
      range.value = Number.isFinite(clamped) ? clamped : 50;
      updateRecordField(dateKey, field, Number.isFinite(clamped) ? String(clamped) : '');
    });
  }

  for (const el of $$('[data-field]', root)) {
    const field = el.dataset.field;
    if (['amMood','pmMood','amMoodNumber','pmMoodNumber'].includes(field)) continue;
    el.addEventListener('input', () => updateRecordField(dateKey, field, el.value));
  }
}

function updateRecordField(dateKey, field, value) {
  const rec = getOrCreateRecord(dateKey);
  rec[field] = value;
  rec.updatedAt = new Date().toISOString();
  if (!hasRecordContent(rec)) delete state.records[dateKey];
  scheduleSave();
  if (currentView === 'calendar') refreshCalendarCell(dateKey);
}

function renderWeek() {
  const start = startOfWeek(currentWeekDate);
  currentWeekDate = start;
  const end = addDays(start, 6);
  $('#weekLabel').textContent = `${displayDateShort(start)} 〜 ${displayDateShort(end)}`;

  const goals = getWeekGoals(toDateKey(start));
  const goalRange = $('#weekGoalRange');
  const goalEnd = addDays(start, 6);
  goalRange.innerHTML = `<span class="week-goal-range-start">${start.getFullYear()}年 ${start.getMonth()+1}/${start.getDate()}（${WEEKDAYS[start.getDay()]}）〜</span><span class="week-goal-range-end">${goalEnd.getMonth()+1}/${goalEnd.getDate()}（${WEEKDAYS[goalEnd.getDay()]}）の目標</span>`;
  $('#weekGoal1').textContent = goals.goal1 || '未設定';
  $('#weekGoal2').textContent = goals.goal2 || '未設定';

  const grid = $('#weekGrid');
  grid.innerHTML = '';
  const today = new Date();
  for (let i=0; i<7; i++) {
    const date = addDays(start, i);
    const key = toDateKey(date);
    const card = document.createElement('article');
    card.className = `day-card${sameDay(date,today) ? ' is-today' : ''}`;
    card.dataset.date = key;
    card.innerHTML = `<div class="day-card-head"><div><span class="day-date">${date.getMonth()+1}/${date.getDate()}</span> <span class="day-weekday">（${WEEKDAYS[date.getDay()]}）</span></div>${sameDay(date,today) ? '<span class="today-badge">今日</span>' : ''}</div><div class="day-wave" aria-hidden="true"></div>`;
    card.appendChild(cloneDailyFields(key));
    grid.appendChild(card);
  }
}

function renderCalendar() {
  $('#monthLabel').textContent = monthLabel(currentCalendarMonth);

  const selectedDate = parseDateKey(selectedCalendarDate);
  if (!sameMonth(selectedDate, currentCalendarMonth)) selectedCalendarDate = toDateKey(currentCalendarMonth);

  const selectedWeekStart = startOfWeek(parseDateKey(selectedCalendarDate));
  const goals = getWeekGoals(toDateKey(selectedWeekStart));
  $('#weekGoalInput1').value = goals.goal1;
  $('#weekGoalInput2').value = goals.goal2;
  $('#calendarGoalWeekLabel').textContent = weekRangeLabel(selectedWeekStart);
  renderCalendarWeekdayHeader();

  const first = startOfMonth(currentCalendarMonth);
  const firstDayOffset = (first.getDay() - getWeekStartsOn() + 7) % 7;
  const gridStart = addDays(first, -firstDayOffset);
  const grid = $('#calendarGrid');
  grid.innerHTML = '';
  for (let i=0; i<42; i++) {
    const date = addDays(gridStart, i);
    grid.appendChild(buildCalendarCell(date));
  }
  renderCalendarDayPanel();
}

function renderCalendarWeekdayHeader() {
  const row = $('#calendarWeekdays');
  if (!row) return;
  const start = getWeekStartsOn();
  row.innerHTML = '';
  for (let i = 0; i < 7; i++) {
    const day = (start + i) % 7;
    const span = document.createElement('span');
    span.textContent = WEEKDAYS[day];
    if (day === 6) span.classList.add('sat');
    if (day === 0) span.classList.add('sun');
    row.appendChild(span);
  }
}

function buildCalendarCell(date) {
  const key = toDateKey(date);
  const rec = state.records[key];
  const has = hasRecordContent(rec);
  const mood = averageMood(rec);
  const summary = rec?.reflection || rec?.pmActivity || rec?.amActivity || rec?.goal1Result || rec?.goal2Result || '';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'calendar-cell';
  if (!sameMonth(date,currentCalendarMonth)) btn.classList.add('is-other-month');
  if (key === selectedCalendarDate) btn.classList.add('is-selected');
  if (sameDay(date,new Date())) btn.classList.add('is-today');
  btn.dataset.date = key;
  btn.setAttribute('aria-label', `${dateFullLabel(date)}${has ? '、記録あり' : ''}`);
  btn.innerHTML = `<span class="calendar-number">${date.getDate()}</span>${has ? '<span class="record-dot" aria-hidden="true"></span>' : ''}<span class="calendar-summary">${htmlEscape(summary).replace(/\n/g,' ')}</span>${mood !== null ? `<span class="mood-chip"><span class="mood-prefix">気分 </span>${mood}</span>` : ''}`;
  btn.addEventListener('click', () => {
    selectedCalendarDate = key;
    if (!sameMonth(date, currentCalendarMonth)) currentCalendarMonth = startOfMonth(date);
    renderCalendar();
    if (window.matchMedia('(max-width: 720px)').matches) {
      requestAnimationFrame(() => $('#calendarDayPanel')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    }
  });
  return btn;
}

function refreshCalendarCell(dateKey) {
  const old = $(`.calendar-cell[data-date="${dateKey}"]`);
  if (!old) return;
  const date = parseDateKey(dateKey);
  const next = buildCalendarCell(date);
  old.replaceWith(next);
}

function changeSelectedCalendarDate(days) {
  const nextDate = addDays(parseDateKey(selectedCalendarDate), days);
  selectedCalendarDate = toDateKey(nextDate);
  currentCalendarMonth = startOfMonth(nextDate);
  renderCalendar();
}

function bindCalendarDaySwipe(panel) {
  // renderCalendarDayPanel() reuses the same panel element. Bind only once so a
  // single swipe can never accumulate multiple date-change handlers.
  if (panel.dataset.daySwipeBound === 'true') return;
  panel.dataset.daySwipeBound = 'true';

  let startX = 0;
  let startY = 0;
  let pointerId = null;
  let tracking = false;

  const resetSwipe = () => {
    startX = 0;
    startY = 0;
    pointerId = null;
    tracking = false;
  };

  panel.addEventListener('pointerdown', event => {
    if (!event.isPrimary || !['touch', 'pen'].includes(event.pointerType)) return;
    if (event.target.closest('input, textarea, select, button, [contenteditable="true"]')) {
      resetSwipe();
      return;
    }
    startX = event.clientX;
    startY = event.clientY;
    pointerId = event.pointerId;
    tracking = true;
  }, { passive: true });

  panel.addEventListener('pointerup', event => {
    if (!tracking || event.pointerId !== pointerId) return;
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;
    const isHorizontalSwipe = Math.abs(dx) >= 48 && Math.abs(dx) >= Math.abs(dy) * 1.25;
    resetSwipe();
    if (!isHorizontalSwipe) return;

    // Distance / flick speed never changes the amount: exactly one day per gesture.
    changeSelectedCalendarDate(dx < 0 ? 1 : -1);
  }, { passive: true });

  panel.addEventListener('pointercancel', resetSwipe, { passive: true });
}

function renderCalendarDayPanel() {
  const panel = $('#calendarDayPanel');
  const date = parseDateKey(selectedCalendarDate);
  panel.innerHTML = `<div class="editor-head"><div class="editor-head-top"><p>SELECTED DAY</p><div class="editor-day-nav"><button type="button" data-day-shift="-1" aria-label="前日の記録">‹</button><button type="button" data-day-shift="1" aria-label="翌日の記録">›</button></div></div><h2>${dateFullLabel(date)}</h2><p class="swipe-hint">← 横フリックで前日・翌日 →</p></div>`;
  panel.appendChild(cloneDailyFields(selectedCalendarDate));
  $$('[data-day-shift]', panel).forEach(btn => btn.addEventListener('click', () => changeSelectedCalendarDate(Number(btn.dataset.dayShift))));
  bindCalendarDaySwipe(panel);
}

function updateSelectedPanelGoalLabels() {
  if (currentView !== 'calendar') return;
  const panel = $('#calendarDayPanel');
  if (!panel) return;
  const goals = getWeekGoalsForDate(selectedCalendarDate);
  const g1 = $('[data-goal-label="1"]', panel);
  const g2 = $('[data-goal-label="2"]', panel);
  if (g1) g1.textContent = `① ${goals.goal1 || '目標1の結果'}`;
  if (g2) g2.textContent = `② ${goals.goal2 || '目標2の結果'}`;
}

function updateWeekGoal(field, value) {
  const weekKey = weekKeyForDate(selectedCalendarDate);
  const goals = ensureWeekGoals(weekKey);
  goals[field] = value;
  goals.updatedAt = new Date().toISOString();
  if (!goals.goal1 && !goals.goal2) delete state.weekGoals[weekKey];
  scheduleSave();
  updateSelectedPanelGoalLabels();
}

function availableMonths() {
  const keys = new Set(Object.keys(state.records).map(k=>k.slice(0,7)));
  Object.keys(state.weekGoals).forEach(k=>keys.add(k.slice(0,7)));
  keys.add(toMonthKey(new Date()));
  return [...keys].sort().reverse();
}

function renderList() {
  const select = $('#listMonthFilter');
  const prior = select.value || 'all';
  select.innerHTML = '<option value="all">すべて</option>' + availableMonths().map(k => {
    const [y,m] = k.split('-').map(Number);
    return `<option value="${k}">${y}年${m}月</option>`;
  }).join('');
  if ([...select.options].some(o=>o.value===prior)) select.value = prior;
  renderRecordListItems();
}

function renderRecordListItems() {
  const month = $('#listMonthFilter').value || 'all';
  const query = ($('#listSearch').value || '').trim().toLowerCase();
  let entries = Object.entries(state.records).filter(([,rec])=>hasRecordContent(rec));
  entries.sort((a,b)=>b[0].localeCompare(a[0]));
  if (month !== 'all') entries = entries.filter(([key])=>key.startsWith(month));
  if (query) entries = entries.filter(([key,rec]) => {
    const goals = getWeekGoalsForDate(key);
    return [key,rec.amActivity,rec.pmActivity,rec.reflection,rec.goal1Result,rec.goal2Result,goals.goal1,goals.goal2].join(' ').toLowerCase().includes(query);
  });

  const list = $('#recordList');
  if (!entries.length) {
    list.innerHTML = '<div class="empty-state"><strong>該当する記録はまだありません</strong>週記録またはカレンダーから入力すると、ここに表示されます。</div>';
    return;
  }
  list.innerHTML = entries.map(([key,rec]) => {
    const date = parseDateKey(key);
    const goals = getWeekGoalsForDate(key);
    const am = [rec.amActivity, rec.amMood !== '' ? `気分 ${rec.amMood}` : ''].filter(Boolean).join(' / ');
    const pm = [rec.pmActivity, rec.pmMood !== '' ? `気分 ${rec.pmMood}` : ''].filter(Boolean).join(' / ');
    const results = [goals.goal1 ? `① ${goals.goal1}\n→ ${rec.goal1Result || '—'}` : (rec.goal1Result ? `① ${rec.goal1Result}` : ''), goals.goal2 ? `② ${goals.goal2}\n→ ${rec.goal2Result || '—'}` : (rec.goal2Result ? `② ${rec.goal2Result}` : '')].filter(Boolean).join('\n');
    return `<article class="record-item"><div class="record-date"><strong>${date.getMonth()+1}/${date.getDate()}（${WEEKDAYS[date.getDay()]}）</strong><span>${date.getFullYear()}年</span></div><div class="record-section"><strong>AM / PM</strong><p>${htmlEscape(am || '—')}\n${htmlEscape(pm || '—')}</p></div><div class="record-section"><strong>1日のふりかえり</strong><p>${htmlEscape(rec.reflection || '—')}</p></div><div class="record-section"><strong>目標の結果</strong><p>${htmlEscape(results || '—')}</p></div><button type="button" class="open-day-btn" data-open-date="${key}">この日を開く</button></article>`;
  }).join('');
  $$('[data-open-date]', list).forEach(btn => btn.addEventListener('click', () => openCalendarDate(btn.dataset.openDate)));
}

function openCalendarDate(key) {
  selectedCalendarDate = key;
  currentCalendarMonth = startOfMonth(parseDateKey(key));
  navigate('calendar');
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024*1024) return `${(bytes/1024).toFixed(1)} KB`;
  return `${(bytes/1024/1024).toFixed(1)} MB`;
}
function formatDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getFullYear()}/${d.getMonth()+1}/${d.getDate()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

async function updateStorageUi() {
  const primary = $('#primaryStorageStatus');
  if (!primary) return;
  primary.textContent = primaryStorageOkay ? 'IndexedDB：正常' : 'IndexedDB：利用不可';
  $('#shadowStorageStatus').textContent = shadowStorageOkay ? 'localStorage：正常' : 'localStorage：利用不可';
  $('#lastSavedStatus').textContent = formatDateTime(state?.meta?.updatedAt);
  let summary = '端末内へ2重保存しています。';
  if (!(primaryStorageOkay && shadowStorageOkay)) summary = '保存経路の一部が利用できません。バックアップ出力をおすすめします。';
  if (navigator.storage?.estimate) {
    try {
      const est = await navigator.storage.estimate();
      summary += ` 使用量 ${formatBytes(est.usage)} / 上限目安 ${formatBytes(est.quota)}。`;
    } catch {}
  }
  if (navigator.storage?.persisted) {
    try { summary += (await navigator.storage.persisted()) ? ' 永続ストレージ：許可済み。' : ' 永続ストレージ：未許可。'; } catch {}
  }
  $('#storageSummary').textContent = summary;
  $('#lastBackupText').textContent = `バックアップ出力履歴：${state?.meta?.lastBackupAt ? formatDateTime(state.meta.lastBackupAt) : 'まだありません'}`;
}

async function renderSettings() {
  await updateStorageUi();
  const appUpdateStatus = $('#appUpdateStatus');
  if (appUpdateStatus) appUpdateStatus.textContent = `現在のバージョン：v${APP_VERSION}。記録データは更新時も保持されます。`;
  const weekStartSelect = $('#weekStartSelect');
  if (weekStartSelect) weekStartSelect.value = String(getWeekStartsOn());
  const list = $('#snapshotList');
  if (!db) {
    list.innerHTML = '<div class="empty-state">このブラウザでは端末内復元ポイントを利用できません。</div>';
    return;
  }
  let snapshots = [];
  try { snapshots = await getSnapshots(); } catch {}
  if (!snapshots.length) {
    list.innerHTML = '<div class="empty-state">復元ポイントはまだありません。</div>';
    return;
  }
  list.innerHTML = snapshots.map(s => `<div class="snapshot-item"><span>${htmlEscape(s.reason || '保存')}・${formatDateTime(s.createdAt)}</span><button type="button" data-restore-snapshot="${htmlEscape(s.key)}">復元</button></div>`).join('');
  $$('[data-restore-snapshot]', list).forEach(btn => btn.addEventListener('click', () => restoreSnapshot(btn.dataset.restoreSnapshot)));
}

function downloadFile(filename, content, type) {
  const blob = content instanceof Blob ? content : new Blob([content], {type});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url), 1000);
}

async function exportBackup() {
  state.meta.lastBackupAt = new Date().toISOString();
  await flushSave();
  const payload = {
    format: 'komorebi-record-backup', schemaVersion: SCHEMA_VERSION, appVersion: APP_VERSION,
    exportedAt: new Date().toISOString(), data: state
  };
  const date = toDateKey(new Date()).replaceAll('-','');
  downloadFile(`komorebi-backup-${date}.json`, JSON.stringify(payload, null, 2), 'application/json;charset=utf-8');
  updateStorageUi();
  showToast('バックアップを書き出しました');
}

function csvEscape(value) {
  const s = String(value ?? '').replaceAll('"','""');
  return `"${s}"`;
}
function exportCsv() {
  const header = ['日付','曜日','AMの活動','AM気分','PMの活動','PM気分','1日のふりかえり','目標1','目標1の結果','目標2','目標2の結果'];
  const rows = Object.entries(state.records).filter(([,r])=>hasRecordContent(r)).sort((a,b)=>a[0].localeCompare(b[0])).map(([key,r]) => {
    const d = parseDateKey(key); const g = getWeekGoalsForDate(key);
    return [key,WEEKDAYS[d.getDay()],r.amActivity,r.amMood,r.pmActivity,r.pmMood,r.reflection,g.goal1,r.goal1Result,g.goal2,r.goal2Result];
  });
  const csv = '\ufeff' + [header,...rows].map(row=>row.map(csvEscape).join(',')).join('\r\n');
  downloadFile(`komorebi-records-${toDateKey(new Date()).replaceAll('-','')}.csv`, csv, 'text/csv;charset=utf-8');
  showToast('CSVを書き出しました');
}

function parseBackupObject(obj) {
  const candidate = obj?.format === 'komorebi-record-backup' ? obj.data : obj;
  if (!isValidState(candidate)) throw new Error('このアプリのバックアップ形式として認識できません。');
  return normalizeState(candidate);
}

function remapWeekGoals(weekGoals, oldWeekStartsOn, newWeekStartsOn) {
  const oldStart = normalizeWeekStartsOn(oldWeekStartsOn);
  const newStart = normalizeWeekStartsOn(newWeekStartsOn);
  if (oldStart === newStart) return deepClone(weekGoals || {});
  const remapped = {};
  for (const [weekKey, goals] of Object.entries(weekGoals || {})) {
    const representativeDate = addDays(parseDateKey(weekKey), 3);
    const nextKey = weekKeyForDate(representativeDate, newStart);
    const existing = remapped[nextKey];
    const goalUpdated = Date.parse(goals?.updatedAt || '') || 0;
    const existingUpdated = Date.parse(existing?.updatedAt || '') || 0;
    if (!existing || goalUpdated >= existingUpdated) {
      remapped[nextKey] = { goal1: goals?.goal1 || '', goal2: goals?.goal2 || '', updatedAt: goals?.updatedAt || null };
    }
  }
  return remapped;
}

function updateWeekStartsOn(value) {
  const nextStart = normalizeWeekStartsOn(value);
  const previousStart = getWeekStartsOn();
  if (nextStart === previousStart) return;
  state.weekGoals = remapWeekGoals(state.weekGoals, previousStart, nextStart);
  state.settings.weekStartsOn = nextStart;
  currentWeekDate = startOfWeek(currentWeekDate, nextStart);
  scheduleSave();
  showToast(`週の開始曜日を${WEEKDAYS[nextStart]}曜日に変更しました`);
}

function mergeStates(current, incoming) {
  const currentState = normalizeState(current);
  const incomingState = normalizeState(incoming);
  const targetWeekStartsOn = normalizeWeekStartsOn(incomingState.settings?.weekStartsOn ?? currentState.settings.weekStartsOn);
  const merged = normalizeState(currentState);
  merged.records = { ...deepClone(currentState.records), ...deepClone(incomingState.records) };
  merged.weekGoals = {
    ...remapWeekGoals(currentState.weekGoals, currentState.settings.weekStartsOn, targetWeekStartsOn),
    ...remapWeekGoals(incomingState.weekGoals, incomingState.settings.weekStartsOn, targetWeekStartsOn)
  };
  merged.settings = { ...currentState.settings, ...deepClone(incomingState.settings || {}), weekStartsOn: targetWeekStartsOn };
  merged.meta.createdAt = currentState.meta?.createdAt || incomingState.meta?.createdAt || new Date().toISOString();
  merged.meta.updatedAt = new Date().toISOString();
  return merged;
}

async function importBackupFile(file) {
  if (!file) return;
  try {
    const text = await file.text();
    const incoming = parseBackupObject(JSON.parse(text));
    const mode = $('#importMode').value;
    if (mode === 'replace' && !confirm('現在の記録をバックアップ内容で置き換えます。続けますか？')) return;
    if (db) {
      try { await createSnapshotInternal('読込前'); } catch {}
    }
    state = mode === 'replace' ? incoming : mergeStates(state, incoming);
    state.meta.updatedAt = new Date().toISOString();
    await flushSave();
    renderView(currentView);
    showToast(mode === 'replace' ? 'バックアップで置き換えました' : 'バックアップを追加・更新しました');
  } catch (err) {
    console.error(err);
    alert(`読み込みに失敗しました。\n${err.message || err}`);
  } finally {
    $('#importBackup').value = '';
  }
}

async function restoreSnapshot(key) {
  if (!confirm('この復元ポイントの内容に戻します。現在の状態も復元前ポイントとして保存します。続けますか？')) return;
  try {
    // Read the requested snapshot first. Creating the pre-restore point can prune the oldest generation.
    const snap = await dbGet(key);
    if (!snap?.state || !isValidState(snap.state)) throw new Error('復元ポイントが壊れています。');
    const restoreState = normalizeState(snap.state);
    await createSnapshotInternal('復元前');
    state = restoreState;
    state.meta.updatedAt = new Date().toISOString();
    await flushSave();
    renderSettings();
    showToast('復元ポイントから戻しました');
  } catch (err) {
    alert(`復元に失敗しました。\n${err.message || err}`);
  }
}

function requestFreshAppCache(worker) {
  return new Promise((resolve, reject) => {
    if (!worker) {
      reject(new Error('Service Worker がまだ有効になっていません。'));
      return;
    }

    const channel = new MessageChannel();
    const timer = window.setTimeout(() => reject(new Error('更新処理がタイムアウトしました。')), 20000);
    channel.port1.onmessage = event => {
      window.clearTimeout(timer);
      if (event.data?.ok) resolve(event.data);
      else reject(new Error(event.data?.message || '最新版の取得に失敗しました。'));
    };
    worker.postMessage({ type: 'REFRESH_APP_CACHE' }, [channel.port2]);
  });
}

async function updateApp() {
  const button = $('#updateApp');
  const status = $('#appUpdateStatus');
  const originalText = button?.textContent || '最新版に更新';

  if (!navigator.onLine) {
    if (status) status.textContent = `現在のバージョン：v${APP_VERSION}。オンライン時に更新してください。`;
    showToast('オフラインではアプリを更新できません');
    return;
  }

  if (button) {
    button.disabled = true;
    button.textContent = '更新を確認中…';
  }

  try {
    if (status) status.textContent = '記録データを保存しています…';
    await flushSave();

    if (!('serviceWorker' in navigator) || !location.protocol.startsWith('http')) {
      throw new Error('この環境ではアプリ更新機能を利用できません。');
    }

    if (status) status.textContent = '最新版を取得しています…';
    let registration = await navigator.serviceWorker.getRegistration();
    if (!registration) {
      registration = await navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' });
      await navigator.serviceWorker.ready;
    }

    // sw.js 自体も HTTP キャッシュを使わず更新確認する。
    // 新しい Service Worker が見つかれば controllerchange 側で保存後に自動再読み込みする。
    await registration.update();

    // 現在の Service Worker が対応している場合は、アプリ用 Cache Storage も即時更新する。
    // （この app.js が動いている時点では v5 以降なので REFRESH_APP_CACHE に対応済み。）
    const worker = navigator.serviceWorker.controller || registration.active || registration.waiting;
    await requestFreshAppCache(worker);

    if (status) status.textContent = '最新版を取得しました。画面を再読み込みします…';
    showToast('アプリを最新版に更新しました');
    window.setTimeout(() => location.reload(), 350);
  } catch (err) {
    console.error('App update failed', err);
    if (status) status.textContent = `更新できませんでした：${err.message || err}`;
    showToast('アプリを更新できませんでした');
    if (button) {
      button.disabled = false;
      button.textContent = originalText;
    }
  }
}

async function requestPersistentStorage() {
  if (!navigator.storage?.persist) {
    showToast('このブラウザは永続ストレージ要求に対応していません');
    return;
  }
  try {
    const granted = await navigator.storage.persist();
    await updateStorageUi();
    showToast(granted ? '永続ストレージが許可されました' : '今回は許可されませんでした。外部バックアップも併用してください');
  } catch {
    showToast('永続ストレージを依頼できませんでした');
  }
}

async function resetAllData() {
  if (!confirm('すべての記録と週目標を削除します。\nこの操作の直前に端末内復元ポイントを作成します。続けますか？')) return;
  if (db) {
    try { await createSnapshotInternal('初期化前'); } catch {}
  }
  state = defaultState();
  await flushSave();
  currentWeekDate = startOfWeek(new Date());
  currentCalendarMonth = startOfMonth(new Date());
  selectedCalendarDate = toDateKey(new Date());
  renderView(currentView);
  showToast('記録を初期化しました');
}

function bindStaticEvents() {
  $$('[data-nav]').forEach(btn => btn.addEventListener('click', () => navigate(btn.dataset.nav)));
  $('#prevWeek').addEventListener('click', () => { currentWeekDate = addDays(currentWeekDate,-7); renderWeek(); });
  $('#nextWeek').addEventListener('click', () => { currentWeekDate = addDays(currentWeekDate,7); renderWeek(); });
  $('#thisWeek').addEventListener('click', () => { currentWeekDate = startOfWeek(new Date()); renderWeek(); });
  $('#weekLabel').addEventListener('click', () => { currentWeekDate = startOfWeek(new Date()); renderWeek(); });
  $('#editGoalsFromWeek').addEventListener('click', () => {
    const start = startOfWeek(currentWeekDate);
    currentCalendarMonth = startOfMonth(start);
    selectedCalendarDate = toDateKey(start);
    navigate('calendar');

    // The weekly-goal editor lives below the calendar/day editor on phones.
    // Scroll to the actual text boxes after the calendar view has rendered.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const goalEditor = $('.week-goals-card');
      if (!goalEditor) return;
      goalEditor.classList.add('is-edit-target');
      goalEditor.scrollIntoView({ behavior: 'smooth', block: 'center' });
      window.setTimeout(() => goalEditor.classList.remove('is-edit-target'), 1400);
    }));
  });

  $('#prevMonth').addEventListener('click', () => { currentCalendarMonth = addMonths(currentCalendarMonth,-1); selectedCalendarDate = toDateKey(currentCalendarMonth); renderCalendar(); });
  $('#nextMonth').addEventListener('click', () => { currentCalendarMonth = addMonths(currentCalendarMonth,1); selectedCalendarDate = toDateKey(currentCalendarMonth); renderCalendar(); });
  $('#thisMonth').addEventListener('click', () => { currentCalendarMonth = startOfMonth(new Date()); selectedCalendarDate = toDateKey(new Date()); renderCalendar(); });
  $('#monthLabel').addEventListener('click', () => { currentCalendarMonth = startOfMonth(new Date()); selectedCalendarDate = toDateKey(new Date()); renderCalendar(); });
  $('#weekGoalInput1').addEventListener('input', e => updateWeekGoal('goal1', e.target.value));
  $('#weekGoalInput2').addEventListener('input', e => updateWeekGoal('goal2', e.target.value));
  $('#weekStartSelect').addEventListener('change', e => updateWeekStartsOn(e.target.value));

  $('#listMonthFilter').addEventListener('change', renderRecordListItems);
  $('#listSearch').addEventListener('input', renderRecordListItems);
  $('#exportBackup').addEventListener('click', exportBackup);
  $('#exportCsv').addEventListener('click', exportCsv);
  $('#importBackup').addEventListener('change', e => importBackupFile(e.target.files?.[0]));
  $('#requestPersistentStorage').addEventListener('click', requestPersistentStorage);
  $('#updateApp').addEventListener('click', updateApp);
  $('#createSnapshot').addEventListener('click', async () => {
    try { await createSnapshotInternal('手動'); await flushSave(); await renderSettings(); showToast('復元ポイントを作成しました'); }
    catch { showToast('復元ポイントを作成できませんでした'); }
  });
  $('#resetData').addEventListener('click', resetAllData);

  window.addEventListener('beforeunload', () => {
    // Synchronous mirror gives the last keystrokes an additional chance to survive a quick tab close.
    if (state) { state.meta.updatedAt = new Date().toISOString(); writeShadow(state); }
  });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && state) flushSave(); });
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !location.protocol.startsWith('http')) return;

  // 初回インストール時の controllerchange では不要な再読み込みをしない。
  // すでに旧 Service Worker に制御されている画面だけ、新版への切り替わりを自動反映する。
  const hadControllerAtStartup = !!navigator.serviceWorker.controller;

  navigator.serviceWorker.addEventListener('controllerchange', async () => {
    if (!hadControllerAtStartup || serviceWorkerReloading) return;
    serviceWorkerReloading = true;

    try {
      if (state) await flushSave();
    } catch (err) {
      console.warn('Failed to flush state before Service Worker reload', err);
    } finally {
      location.reload();
    }
  });

  try {
    const registration = await navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' });
    await registration.update();
  } catch (err) {
    console.warn('Service worker registration failed', err);
  }
}

async function init() {
  await loadState();
  currentWeekDate = startOfWeek(new Date());
  bindStaticEvents();
  renderCalendar();
  updateStorageUi();
  registerServiceWorker();
  if (primaryStorageOkay && shadowStorageOkay) setSaveIndicator('saved', '保存済み（2重保存）');
  else if (primaryStorageOkay || shadowStorageOkay) setSaveIndicator('saved', '保存済み（予備経路）');
  else setSaveIndicator('error', '保存領域を利用できません');
}

document.addEventListener('DOMContentLoaded', init);
