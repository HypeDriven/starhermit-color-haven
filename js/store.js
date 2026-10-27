/**
 * Color Haven — the save model (pure; no DOM, no engine).
 *
 * The game's save document is { v: 1, progress } (progress: journey bests
 * and stars, achievements with their unlock time, the finished daily days,
 * illustrations finished, the guest id, whether the Learn lessons were
 * finished). Two devices' copies merge with mergeProgress (the better of
 * both). The browser build's cloud save (slot game:color-haven, the JS
 * SDK's zipped save.json) is the text of { progress }; the engine shows it
 * as a foreign save whose text fromBrowserSave reads.
 *
 * The game's own settings (Captions for sounds, the colour-vision-safe
 * palette, the left-handed tray, haptics) are checked by checkSetting; the
 * browser build's other preferences (volumes, graphics, reduced motion,
 * high contrast, larger text) are the runtime's Options now.
 *
 * The round in progress (resume from the title) and the local leaderboards
 * stay on the device: snapshot and board helpers over a key/value store
 * with localStorage's getItem/setItem/removeItem.
 *
 * Shared by the engine client (native/*.ts) and the Node tests.
 */

import { ACHIEVEMENTS, journeyStages } from './content.js';
import { GameSession } from './session.js';

export const SAVE_VERSION = 1;

export function defaultProgress() {
  return { v: 2, journey: {}, achievements: {}, dailyDays: [], gamesPlayed: 0, tutorialDone: false };
}

/** A progress record with every field present and of the right type. */
export function normalizeProgress(p) {
  const base = defaultProgress();
  const src = p && typeof p === 'object' ? p : {};
  const out = Object.assign(base, src);
  if (!out.journey || typeof out.journey !== 'object' || Array.isArray(out.journey)) out.journey = {};
  if (!out.achievements || typeof out.achievements !== 'object' || Array.isArray(out.achievements)) out.achievements = {};
  if (!Array.isArray(out.dailyDays)) out.dailyDays = [];
  out.gamesPlayed = Number.isFinite(out.gamesPlayed) ? Math.max(0, Math.floor(out.gamesPlayed)) : 0;
  out.tutorialDone = !!out.tutorialDone;
  return out;
}

/** The engine save's document, or null when it is not one of ours. */
export function docFromSave(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  if (!data.progress || typeof data.progress !== 'object') return null;
  return { v: SAVE_VERSION, progress: normalizeProgress(data.progress) };
}

/**
 * The browser build's cloud save text ({ progress }) as a document, or null.
 * Its Learn flag lived in the device's settings, which do not migrate, so a
 * player who had finished an illustration is taken to have done the lessons.
 */
export function fromBrowserSave(text) {
  if (typeof text !== 'string' || !text) return null;
  let raw;
  try { raw = JSON.parse(text); } catch { return null; }
  const doc = docFromSave(raw);
  if (!doc) return null;
  if (doc.progress.gamesPlayed > 0 || Object.keys(doc.progress.journey).length) doc.progress.tutorialDone = true;
  return doc;
}

/**
 * Cloud-save conflict (another device saved first): the better of both
 * progress records so neither device loses anything — per stage the higher
 * best and stars, every achievement (earliest unlock), every daily day, the
 * larger finished count, a finished tutorial; this device's guest id.
 */
export function mergeProgress(local, remote) {
  const a = Object.assign(defaultProgress(), local || {});
  const b = Object.assign(defaultProgress(), remote || {});
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

/** Record a finished round; returns newly unlocked achievements. `nowIso` stamps unlocks. */
export function recordCompletion(progress, { mode, level, state, scoreTotal, dateIso, nowIso }) {
  const before = new Set(Object.keys(progress.achievements));
  const stamp = nowIso || new Date().toISOString();
  const unlock = (key) => { if (!progress.achievements[key]) progress.achievements[key] = stamp; };
  progress.gamesPlayed += 1;

  if (state.terminalReason === 'completed') {
    unlock('first_completion');
    if (state.invalid === 0 && state.hints === 0 && state.undos === 0) unlock('mechanic_mastery');
    if (level.tier >= 5) unlock('elder_complete');

    if (mode === 'journey') {
      const prev = progress.journey[level.id] || { best: 0, stars: 0 };
      const stars = starCount(state, level);
      progress.journey[level.id] = {
        best: Math.max(prev.best, scoreTotal),
        stars: Math.max(prev.stars, stars),
      };
      const done = Object.keys(progress.journey).length;
      if (done >= 25) unlock('journey_25');
    }

    if (mode === 'daily' && dateIso) {
      if (!progress.dailyDays.includes(dateIso)) progress.dailyDays.push(dateIso);
      if (progress.dailyDays.length >= 3) unlock('daily_streak_3');
    }
  }
  return ACHIEVEMENTS.filter(a => !before.has(a.key) && progress.achievements[a.key]);
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

/** Each journey stage with whether it is done (its record) and unlocked (sequential). */
export function journeyMap(progress) {
  let unlocked = true;
  return journeyStages().map((st) => {
    const done = progress.journey[st.id] || null;
    const row = { stage: st, done, unlocked: unlocked || !!done };
    if (!done) unlocked = false;
    return row;
  });
}

/* ------------------------------------------------------------------ */
/* The game's own settings                                             */
/* ------------------------------------------------------------------ */

export const DEFAULT_SETTINGS = { captions: false, cvdPalette: false, leftHanded: false, haptics: true };
export const GAME_SETTING_KEYS = Object.keys(DEFAULT_SETTINGS);
/** Every key the browser build mirrored to the account's per-player settings. */
export const BROWSER_SETTING_KEYS = ['volMusic', 'volEffects', 'volAmbience', 'volVoice', 'captions', 'gfx', 'reducedMotion',
  'highContrast', 'cvdPalette', 'largeText', 'leftHanded', 'haptics'];

/** A setting's value when valid for its key, else undefined. */
export function checkSetting(key, value) {
  if (!GAME_SETTING_KEYS.includes(key)) return undefined;
  return typeof value === 'boolean' ? value : undefined;
}

/* ------------------------------------------------------------------ */
/* The round in progress (device only)                                 */
/* ------------------------------------------------------------------ */

export const SNAPSHOT_KEY = 'colorhaven.snapshot.v2';

export function saveSnapshot(ls, { ranked, boardId, session }) {
  try {
    ls.setItem(SNAPSHOT_KEY, JSON.stringify({ ranked, boardId, snap: JSON.parse(session.snapshot()) }));
  } catch { /* full */ }
}

export function clearSnapshot(ls) {
  try { ls.removeItem(SNAPSHOT_KEY); } catch { /* gone */ }
}

/** The saved round { ranked, boardId, snap }, or null when there is nothing usable to resume. */
export function readSnapshot(ls) {
  let raw = null;
  try { raw = ls.getItem(SNAPSHOT_KEY); } catch { return null; }
  if (!raw) return null;
  try {
    const wrap = JSON.parse(raw);
    if (!wrap || !wrap.snap || !wrap.snap.level || !wrap.snap.state) return null;
    const state = wrap.snap.state;
    if (!Number.isInteger(state.filled) || !Number.isInteger(state.total) ||
        state.total < 1 || state.filled < 0 || state.filled > state.total) return null;
    const restored = GameSession.restore(wrap.snap);
    if (!restored || restored.isOver) return null;
    return wrap;
  } catch { return null; }
}

/* ------------------------------------------------------------------ */
/* Local leaderboards (device only), one per ranked board              */
/* ------------------------------------------------------------------ */

const BOARD_PREFIX = 'colorhaven.board.';
const BOARD_INDEX = 'colorhaven.boards';
/** Boards kept on the device (the oldest played is dropped past it). */
export const MAX_BOARDS = 40;
export const BOARD_ENTRIES = 100;

export function fetchBoard(ls, board) {
  try {
    const list = JSON.parse(ls.getItem(BOARD_PREFIX + board) || '[]');
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}

/**
 * Adds a finished round to a board; { ok, rank, local }. The rank is read
 * from the full sorted list, so an entry outside the stored top 100 still
 * has its real placement. The replay envelope is not kept on the device
 * (nothing reads it there, and it would outgrow the store).
 */
export function submitScore(ls, board, entry) {
  const stored = Object.assign({}, entry);
  delete stored.envelope;
  const list = fetchBoard(ls, board);
  list.push(stored);
  list.sort((a, b) => b.score - a.score || a.elapsedMs - b.elapsedMs);
  const rank = list.findIndex(e => e.sessionId === entry.sessionId) + 1;
  try { ls.setItem(BOARD_PREFIX + board, JSON.stringify(list.slice(0, BOARD_ENTRIES))); } catch { /* full */ }
  let index = [];
  try { index = JSON.parse(ls.getItem(BOARD_INDEX) || '[]'); } catch { index = []; }
  if (!Array.isArray(index)) index = [];
  index = index.filter((b) => b !== board);
  index.push(board);
  while (index.length > MAX_BOARDS) {
    const old = index.shift();
    try { ls.removeItem(BOARD_PREFIX + old); } catch { /* gone */ }
  }
  try { ls.setItem(BOARD_INDEX, JSON.stringify(index)); } catch { /* full */ }
  return { ok: true, rank, local: true };
}
