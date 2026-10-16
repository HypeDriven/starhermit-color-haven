/**
 * Color Haven — ui module.
 * DOM shell helpers, persistent settings/progress stores, screen management,
 * HUD rendering, and accessibility announcements. UI state is fully separate
 * from simulation state.
 */

import { ACHIEVEMENTS, journeyStages, paletteFor, symbolFor } from './content.js';

/* ------------------------------------------------------------------ */
/* DOM helpers                                                         */
/* ------------------------------------------------------------------ */

/* Localization (js/i18n.js, window.HVI18N): English source strings are the
 * keys. T() translates now; N() only marks a string for display-time T(). */
export function T(key, vars) {
  if (window.HVI18N) return window.HVI18N.T(key, vars);
  return String(key).replace(/\{(\w+)\}/g, (m, k) => (vars && k in vars ? String(vars[k]) : m));
}
export const N = (key) => key;

/** A level's title in the game language (level data keeps the English title). */
export function levelTitle(level) {
  if (!level) return '';
  const id = String(level.id || '');
  if (id.startsWith('daily-')) return T('Daily — {date}', { date: id.slice(6) });
  const ch = /^challenge-(moves|speed|elder)$/.exec(id);
  if (ch) return T('Challenge — {variant}', { variant: T({ moves: N('moves'), speed: N('speed'), elder: N('elder') }[ch[1]]) });
  if (id.startsWith('score-')) return T('Seed “{seed}”', { seed: id.slice(6) });
  return T(level.title);
}

export const $ = (sel) => document.querySelector(sel);
export const $$ = (sel) => Array.from(document.querySelectorAll(sel));

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children) node.append(c);
  return node;
}

export function formatMs(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function announce(msg) {
  const n = $('#aria-live');
  if (n) { n.textContent = ''; requestAnimationFrame(() => { n.textContent = msg; }); }
}

export function announceAlert(msg) {
  const n = $('#aria-alert');
  if (n) { n.textContent = ''; requestAnimationFrame(() => { n.textContent = msg; }); }
}

let toastTimer = null;
export function toast(msg, ms = 2600) {
  const t = $('#hud-toast');
  if (!t) return;
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

export function banner(msg) {
  const b = $('#hud-banner');
  if (!b) return;
  if (msg == null) { b.hidden = true; reserveCoachSpace(); return; }
  b.textContent = msg;
  b.hidden = false;
  reserveCoachSpace();
}

/**
 * The coach banner gets its own band above the board instead of covering
 * cells: the play area exposes the banner's height as --coach-h and the
 * canvas host starts below it.
 */
function reserveCoachSpace() {
  const area = $('#play-area');
  const b = $('#hud-banner');
  if (!area || !b) return;
  requestAnimationFrame(() => {
    // Short landscape docks the banner beside the board instead (see CSS).
    const docked = window.matchMedia('(max-height: 500px) and (orientation: landscape)').matches;
    // Rects are visual (zoomed) px; --coach-h/-w are used inside the zoomed #app, so divide by the UI scale.
    const z = (window.UIScale && window.UIScale.value) || 1;
    const h = b.hidden || docked ? 0 : Math.ceil(b.getBoundingClientRect().height / z) + 12;
    const w = b.hidden || !docked ? 0 : Math.ceil(b.getBoundingClientRect().width / z) + 12;
    area.style.setProperty('--coach-h', h + 'px');
    area.style.setProperty('--coach-w', w + 'px');
  });
}
window.addEventListener('resize', reserveCoachSpace);

/* ------------------------------------------------------------------ */
/* Screen manager (one visible overlay at a time; focus restoration)   */
/* ------------------------------------------------------------------ */

const SCREENS = ['title', 'setup', 'journey', 'results', 'pause', 'settings', 'help', 'scores'];
let lastFocus = null;
const screenStack = [];

export function showScreen(name, { push = true } = {}) {
  for (const s of SCREENS) {
    const node = $('#screen-' + s);
    if (node) node.hidden = s !== name;
  }
  if (name) {
    lastFocus = document.activeElement;
    if (push) screenStack.push(name);
    const node = $('#screen-' + name);
    const first = node.querySelector('button, [href], input, select, [tabindex]');
    if (first) first.focus();
  }
}

export function closeScreen() {
  screenStack.pop();
  const next = screenStack[screenStack.length - 1] || null;
  showScreen(next, { push: false });
  if (!next && lastFocus && lastFocus.isConnected) lastFocus.focus();
}

export function currentScreen() {
  return screenStack[screenStack.length - 1] || null;
}

export function clearScreens() {
  screenStack.length = 0;
  for (const s of SCREENS) {
    const node = $('#screen-' + s);
    if (node) node.hidden = true;
  }
}

/* ------------------------------------------------------------------ */
/* Settings store (per-game settings; persisted)                       */
/* ------------------------------------------------------------------ */

export const DEFAULT_SETTINGS = {
  volMusic: 60, volEffects: 80, volAmbience: 40, volVoice: 80,
  captions: false,
  gfx: {},               // Graphics panel (gfx.js): {} = Auto preset
  reducedMotion: false,
  highContrast: false,
  cvdPalette: false,
  largeText: false,
  leftHanded: false,
  haptics: true,
  tutorialDone: false,
};

const SETTINGS_KEY = 'colorhaven.settings.v1';

export function loadSettings() {
  try {
    return Object.assign({}, DEFAULT_SETTINGS, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'));
  } catch { return { ...DEFAULT_SETTINGS }; }
}

export function saveSettings(s) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch { /* quota */ }
}

export function applySettingsClasses(s) {
  document.body.classList.toggle('reduced-motion', !!s.reducedMotion);
  document.body.classList.toggle('high-contrast', !!s.highContrast);
  document.body.classList.toggle('large-text', !!s.largeText);
  document.body.classList.toggle('left-handed', !!s.leftHanded);
}

/* ------------------------------------------------------------------ */
/* Progress store (journey, achievements, daily streak, stats)         */
/* ------------------------------------------------------------------ */

const PROGRESS_KEY = 'colorhaven.progress.v2';

export function loadProgress() {
  try {
    const p = JSON.parse(localStorage.getItem(PROGRESS_KEY) || '{}');
    return Object.assign({ v: 2, journey: {}, achievements: {}, dailyDays: [], gamesPlayed: 0, tutorialDone: false }, p);
  } catch {
    return { v: 2, journey: {}, achievements: {}, dailyDays: [], gamesPlayed: 0, tutorialDone: false };
  }
}

/**
 * Cloud-save conflict (another device saved first): the better of both
 * progress records so neither device loses anything — per stage the higher
 * best and stars, every achievement (earliest unlock), every daily day, the
 * larger finished count, a finished tutorial; this device's guest id.
 */
export function mergeProgress(local, remote) {
  const base = () => ({ v: 2, journey: {}, achievements: {}, dailyDays: [], gamesPlayed: 0, tutorialDone: false });
  const a = Object.assign(base(), local || {});
  const b = Object.assign(base(), remote || {});
  const journey = { ...b.journey };
  for (const [id, j] of Object.entries(a.journey)) {
    const o = journey[id];
    journey[id] = !o ? j : { best: Math.max(j.best || 0, o.best || 0), stars: Math.max(j.stars || 0, o.stars || 0) };
  }
  const achievements = { ...b.achievements };
  for (const [k, at] of Object.entries(a.achievements)) {
    achievements[k] = achievements[k] && String(achievements[k]) < String(at) ? achievements[k] : at;
  }
  return Object.assign({}, b, a, {
    journey, achievements,
    dailyDays: [...new Set([...b.dailyDays, ...a.dailyDays])].sort(),
    gamesPlayed: Math.max(a.gamesPlayed || 0, b.gamesPlayed || 0),
    tutorialDone: !!(a.tutorialDone || b.tutorialDone),
  });
}

export function saveProgress(p) {
  try { localStorage.setItem(PROGRESS_KEY, JSON.stringify(p)); } catch { /* quota */ }
}

/** Record a finished round; returns newly unlocked achievements. */
export function recordCompletion(progress, { mode, level, state, scoreTotal, dateIso }) {
  const before = new Set(Object.keys(progress.achievements));
  progress.gamesPlayed += 1;

  if (state.terminalReason === 'completed') {
    unlock(progress, 'first_completion');
    if (state.invalid === 0 && state.hints === 0 && state.undos === 0) unlock(progress, 'mechanic_mastery');
    if (level.tier >= 5) unlock(progress, 'elder_complete');

    if (mode === 'journey') {
      const prev = progress.journey[level.id] || { best: 0, stars: 0 };
      const stars = starCount(state, level);
      progress.journey[level.id] = {
        best: Math.max(prev.best, scoreTotal),
        stars: Math.max(prev.stars, stars),
      };
      const done = Object.keys(progress.journey).length;
      if (done >= 25) unlock(progress, 'journey_25');
    }

    if (mode === 'daily' && dateIso) {
      if (!progress.dailyDays.includes(dateIso)) progress.dailyDays.push(dateIso);
      if (progress.dailyDays.length >= 3) unlock(progress, 'daily_streak_3');
    }
  }
  saveProgress(progress);
  return ACHIEVEMENTS.filter(a => !before.has(a.key) && progress.achievements[a.key]);
}

function unlock(progress, key) {
  if (!progress.achievements[key]) progress.achievements[key] = new Date().toISOString();
}

/** 1–3 stars from accuracy and pace. */
export function starCount(state, level) {
  if (state.terminalReason !== 'completed') return 0;
  let stars = 1;
  if (state.invalid === 0 && state.hints <= 1) stars++;
  if (level.par && state.elapsedMs <= level.par.timeMs) stars++;
  return stars;
}

export function journeyProgressSummary(progress) {
  const total = journeyStages().length;
  const done = Object.keys(progress.journey).length;
  const stars = Object.values(progress.journey).reduce((a, j) => a + (j.stars || 0), 0);
  return { total, done, stars };
}

/** Next unlocked journey stage (first incomplete, sequential unlock). */
export function nextJourneyStage(progress) {
  const stages = journeyStages();
  for (const st of stages) {
    if (!progress.journey[st.id]) return st;
  }
  return stages[stages.length - 1];
}

/* ------------------------------------------------------------------ */
/* Palette tray                                                        */
/* ------------------------------------------------------------------ */

export function renderPalette(tray, palette, state, remaining, onSelect) {
  tray.textContent = '';
  palette.forEach((p, i) => {
    const btn = el('button', {
      class: 'pal-btn',
      type: 'button',
      'aria-label': T(remaining[i] === 1 ? 'Color {n}, {name}, {left} region left' : 'Color {n}, {name}, {left} regions left', { n: i + 1, name: T(p.name), left: remaining[i] }),
      'aria-pressed': state && state.selected === i ? 'true' : 'false',
    });
    btn.append(
      el('span', { class: 'pal-num', text: String(i + 1) }),
      el('span', { class: 'pal-sym', text: p.symbol }),
      el('span', { class: 'pal-count', text: remaining[i] > 0 ? String(remaining[i]) : T('done') }),
      el('span', { class: 'pal-swatch' }),
    );
    btn.querySelector('.pal-swatch').style.background = '#' + p.hex.toString(16).padStart(6, '0');
    if (state && state.selected === i) btn.classList.add('selected');
    if (remaining[i] === 0) btn.classList.add('done');
    btn.disabled = remaining[i] === 0;
    btn.addEventListener('click', () => onSelect(i));
    tray.append(btn);
  });
}

/* ------------------------------------------------------------------ */
/* HUD                                                                 */
/* ------------------------------------------------------------------ */

export function updateHUD(session, level) {
  const st = session.state;
  const pct = Math.round(session.progress * 100);
  $('#progress-fill').style.width = pct + '%';
  $('#progress-pct').textContent = pct + '%';
  const bar = $('#progress-bar');
  bar.setAttribute('aria-valuenow', String(pct));
  $('#stat-time').textContent = formatMs(st.elapsedMs);
  $('#stat-filled').textContent = `${st.filled} / ${st.total}`;
  $('#stat-invalid').textContent = String(st.invalid);
  $('#stat-hints').textContent = String(st.hints);
  const movesEl = $('#objective-moves');
  if (st.remainingMoves != null) {
    movesEl.textContent = T('Moves left: {n}', { n: st.remainingMoves });
  } else {
    movesEl.textContent = T('Par time: {time}', { time: formatMs(level.par.timeMs) });
  }
  const sc = session.scoreBreakdown;
  const prev = $('#score-preview');
  prev.querySelector('[data-k="cells"]').textContent = String(sc.cells);
  prev.querySelector('[data-k="accuracy"]').textContent = String(sc.accuracy);
  prev.querySelector('[data-k="hintPenalty"]').textContent = String(sc.hintPenalty);
  prev.querySelector('[data-k="total"]').textContent = String(sc.total);
  $('#btn-undo').disabled = !st.mechanics.undo || st.status !== 'active';
  $('#btn-hint').disabled = !st.mechanics.hints || st.status !== 'active';
}

export function setObjective(title, sub) {
  $('#objective-title').textContent = title;
  $('#objective-sub').textContent = sub || '';
}

export function setTopbarStatus(text) {
  $('#topbar-status').textContent = text;
}

/* ------------------------------------------------------------------ */
/* Results screen                                                      */
/* ------------------------------------------------------------------ */

export function renderResults({ session, level, mode, newAchievements, rankInfo }) {
  const st = session.state;
  const sc = session.scoreBreakdown;
  const complete = st.terminalReason === 'completed';
  $('#results-h').textContent = complete ? T('Illustration complete') : T('Round over');
  const art = $('#results-art');
  if (art) art.hidden = !complete || art.dataset.failed === '1';
  $('#results-sub').textContent =
    `${levelTitle(level)} · ${mode}` +
    (complete ? ' · ' + T('finished in {time}', { time: formatMs(st.elapsedMs) }) : ' · ' + T('moves exhausted'));
  const rows = [
    [T('Regions filled'), `${st.filled} / ${st.total}`, sc.cells],
    [T('Completion'), complete ? T('yes') : '—', sc.completion],
    [T('Accuracy'), T(st.invalid === 1 ? '{n} slip' : '{n} slips', { n: st.invalid }), sc.accuracy],
    [T('Pace'), formatMs(st.elapsedMs), sc.timeBonus],
    [T('Hints used'), String(st.hints), sc.hintPenalty],
    [T('Undos'), String(st.undos), sc.undoPenalty],
  ];
  const tbody = $('#results-table tbody');
  tbody.textContent = '';
  for (const [label, detail, pts] of rows) {
    tbody.append(el('tr', {}, [
      el('td', { text: label }), el('td', { text: detail }), el('td', { text: String(pts) }),
    ]));
  }
  tbody.append(el('tr', {}, [
    el('td', { text: T('Total') }), el('td', {}), el('td', { class: 'total', text: String(sc.total) }),
  ]));
  const ach = $('#results-achievements');
  ach.textContent = '';
  for (const a of newAchievements || []) {
    ach.append(el('div', { class: 'ach-item', text: T('Achievement unlocked: {name} — {desc}', { name: T(a.name), desc: T(a.desc) }) }));
  }
  $('#results-compare').textContent = rankInfo || '';
}

/* ------------------------------------------------------------------ */
/* Journey map                                                         */
/* ------------------------------------------------------------------ */

export function renderJourney(grid, progress, onPick) {
  grid.textContent = '';
  const stages = journeyStages();
  let unlocked = true; // sequential unlock
  for (const st of stages) {
    const done = progress.journey[st.id];
    const btn = el('button', {
      class: 'stage-btn' + (st.mastery ? ' mastery' : '') + (!unlocked && !done ? ' locked' : ''),
      type: 'button',
      'aria-label': done ? T('Stage {n}, {title}, best {best}, {stars} stars', { n: st.n, title: T(st.title), best: done.best, stars: done.stars })
        : unlocked ? T('Stage {n}, {title}', { n: st.n, title: T(st.title) }) : T('Stage {n}, {title}, locked', { n: st.n, title: T(st.title) }),
    });
    btn.append(
      el('span', { class: 'stage-num', text: String(st.n) }),
      el('span', { class: 'stage-stars', text: done ? '★'.repeat(done.stars) || '·' : unlocked ? '○' : '🔒' }),
    );
    btn.disabled = !unlocked && !done;
    btn.addEventListener('click', () => onPick(st));
    grid.append(btn);
    if (!done) unlocked = false;
  }
}

/* ------------------------------------------------------------------ */
/* Help cards (generated from current control mappings)                */
/* ------------------------------------------------------------------ */

export function renderHelp(container, keyLabel) {
  container.textContent = '';
  const k = keyLabel || ((a) => ({ left: '←', right: '→', up: '↑', down: '↓', fill: 'Enter / Space', undo: 'U', hint: 'H', recenter: 'C', pause: 'P', cancel: 'Esc' }[a] || a));
  const cards = [
    { h: T('The loop'), ps: [T('Pick a numbered color in the tray.'), T('Fill every region showing that number.'), T('Finish the picture — there is no timer and no way to lose.')] },
    { h: T('Mouse / touch'), ps: [T('Tap a region to fill it with the selected color.'), T('Hover previews the result before you commit.'), T('Drag to pan nothing — the board always fits.')] },
    { h: T('Keyboard'), ps: [T('{keys} — move between regions', { keys: `${k('left')} ${k('right')} ${k('up')} ${k('down')}` }), T('{key} — fill focused region', { key: k('fill') }),
      T('{from}–{to} — pick a color', { from: k('color1'), to: k('color8') }),
      T('{undo} — undo, {hint} — hint, {recenter} — re-center camera, {cancel} / {pause} — pause', { undo: k('undo'), hint: k('hint'), recenter: k('recenter'), cancel: k('cancel'), pause: k('pause') })] },
    { h: T('Gamepad'), ps: [T('D-pad / left stick — move focus'), T('A — fill, X — undo, Y — hint'), T('Start — pause')] },
    { h: T('Scoring'), ps: [T('Regions filled and accuracy earn points.'), T('Finishing quickly adds a pace bonus.'), T('Hints and undos cost a little. Slips cost more.')] },
    { h: T('Symbols'), ps: [T('Every color also has a symbol (● ▲ ■ ◆ …), so numbers never rely on color alone. A color-vision-safe palette is in Settings.')] },
  ];
  for (const c of cards) {
    const node = el('div', { class: 'help-card' }, [el('h3', { text: c.h })]);
    for (const p of c.ps) node.append(el('p', { text: p }));
    container.append(node);
  }
}

/* ------------------------------------------------------------------ */
/* Leaderboard table                                                   */
/* ------------------------------------------------------------------ */

export function renderScores(tbody, entries) {
  tbody.textContent = '';
  if (!entries.length) {
    tbody.append(el('tr', {}, [el('td', { colspan: '5', text: T('No scores yet — be the first.') })]));
    return;
  }
  entries.slice(0, 20).forEach((e2, i) => {
    tbody.append(el('tr', {}, [
      el('td', { text: String(i + 1) }),
      el('td', { text: e2.name || T('Guest') }),
      el('td', { text: String(e2.score) }),
      el('td', { text: formatMs(e2.elapsedMs || 0) }),
      el('td', { text: String(e2.invalid || 0) }),
    ]));
  });
}

export { paletteFor, symbolFor };
