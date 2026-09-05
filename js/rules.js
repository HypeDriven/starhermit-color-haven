/**
 * Color Haven — rules engine.
 * Pure, deterministic, DOM-free. Runs in the browser and in Node (server.js, tests).
 *
 * Contract:
 *  - State is JSON-serializable.
 *  - All transitions go through applyCommand(); nothing else mutates rules state.
 *  - listLegalActions() is the single source of truth for play, hints and tutorials.
 *  - state.tick increases monotonically with every accepted command.
 *  - Terminal states carry an explicit terminalReason.
 *  - All score/simulation values are integers; formatting is presentation-only.
 */

export const RULES_VERSION = 1;

/* ------------------------------------------------------------------ */
/* Seeded random stream (mulberry32 over an FNV-1a string hash)        */
/* ------------------------------------------------------------------ */

export function hashString(str) {
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function rngFromSeed(seed) {
  let a = hashString(seed);
  const next = function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.int = (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)); // inclusive
  next.pick = (arr) => arr[Math.floor(next() * arr.length)];
  return next;
}

/* ------------------------------------------------------------------ */
/* Terminal reasons & error codes                                      */
/* ------------------------------------------------------------------ */

export const TERMINAL = Object.freeze({
  COMPLETED: 'completed',
  MOVES_EXHAUSTED: 'moves-exhausted',
});

export const ERR = Object.freeze({
  BAD_COMMAND: 'bad-command',
  DUPLICATE: 'duplicate-command',
  GAME_OVER: 'game-over',
  NO_SELECTION: 'no-selection',
  OUT_OF_BOUNDS: 'out-of-bounds',
  ALREADY_FILLED: 'already-filled',
  WRONG_COLOR: 'wrong-color',
  COLOR_DONE: 'color-complete',
  BAD_COLOR: 'bad-color',
  HINTS_DISABLED: 'hints-disabled',
  UNDO_DISABLED: 'undo-disabled',
  NOTHING_TO_UNDO: 'nothing-to-undo',
  MOVES_EXHAUSTED: 'moves-exhausted',
});

/* ------------------------------------------------------------------ */
/* Game creation                                                       */
/* ------------------------------------------------------------------ */

/**
 * @param level  content descriptor from content.js
 * @param opts   { mode, mechanics?: {hints, undo, moveLimit, timeTargetMs} }
 */
export function createGame(level, opts = {}) {
  const mech = Object.assign({ hints: true, undo: true, moveLimit: null, timeTargetMs: null },
    level.mechanics || {}, opts.mechanics || {});
  const n = level.w * level.h;
  return {
    v: RULES_VERSION,
    levelId: level.id,
    contentV: level.v,
    seed: level.seed,
    mode: opts.mode || 'practice',
    tick: 0,
    selected: null,
    fills: new Array(n).fill(0),
    filled: 0,
    total: n,
    moves: 0,
    invalid: 0,
    hints: 0,
    undos: 0,
    elapsedMs: 0,
    remainingMoves: mech.moveLimit == null ? null : mech.moveLimit,
    mechanics: mech,
    undoStack: [],          // [{cell, byHint}]
    status: 'active',       // 'active' | 'ended'
    terminalReason: null,
    log: [],                // accepted commands (replay envelope core)
    seenIds: [],            // command ids for idempotent rejection
  };
}

/* ------------------------------------------------------------------ */
/* Serialization & migration                                           */
/* ------------------------------------------------------------------ */

export function serialize(state) {
  return JSON.stringify(state);
}

export function deserialize(json) {
  const s = typeof json === 'string' ? JSON.parse(json) : json;
  return migrate(s);
}

export function migrate(s) {
  if (!s || typeof s !== 'object') throw new Error('bad state');
  if (s.v === RULES_VERSION) return s;
  // v0 (pre-release) lacked seenIds/log.
  if (s.v == null || s.v === 0) {
    s.v = RULES_VERSION;
    s.log = s.log || [];
    s.seenIds = s.seenIds || [];
    s.undoStack = s.undoStack || [];
    return s;
  }
  throw new Error('unsupported state version ' + s.v);
}

/* Stable hash over the fields that define simulation truth. */
export function hashState(state) {
  // JSON.stringify preserves scalar types, so a numeric field (1.5) hashes
  // differently from its string form ("1.5") — the join(+sep) coercion used
  // before could not. state.fills is only ever 0/1, so join('') stays unambiguous.
  const key = JSON.stringify([
    state.v, state.levelId, state.seed, state.mode, state.tick,
    state.selected, state.filled, state.moves, state.invalid,
    state.hints, state.undos, state.elapsedMs, state.remainingMoves,
    state.status, state.terminalReason, state.fills.join(''),
  ]);
  return hashString(key).toString(16).padStart(8, '0');
}

/* ------------------------------------------------------------------ */
/* Legal-action queries (single source of truth)                       */
/* ------------------------------------------------------------------ */

export function remainingByColor(state, level) {
  const rem = new Array(level.paletteSize).fill(0);
  for (let i = 0; i < level.targets.length; i++) {
    if (!state.fills[i]) rem[level.targets[i]]++;
  }
  return rem;
}

/**
 * Returns the compact legal-action summary used by play, hints and tutorials.
 * { active, selectable:[bool], fillableFor:[int per color], canUndo, canHint,
 *   reasons: {select:{...}}, terminalReason }
 */
export function listLegalActions(state, level) {
  const rem = remainingByColor(state, level);
  const active = state.status === 'active' &&
    (state.remainingMoves == null || state.remainingMoves > 0 || rem.every(r => r === 0));
  const selectable = level.targets && Array.from({ length: level.paletteSize }, (_, i) => active && rem[i] > 0);
  const canUndo = active && !!state.mechanics.undo &&
    state.undoStack.some(e => !e.byHint);
  const canHint = active && !!state.mechanics.hints && rem.some(r => r > 0);
  return {
    active,
    selectable,
    fillableFor: rem,
    canUndo,
    canHint,
    terminalReason: state.terminalReason,
  };
}

/** Validate a fill without applying it: null if legal, else ERR code. */
export function explainFill(state, level, cell) {
  if (state.status !== 'active') return ERR.GAME_OVER;
  if (state.remainingMoves === 0) return ERR.MOVES_EXHAUSTED;
  if (!Number.isInteger(cell) || cell < 0 || cell >= level.targets.length) return ERR.OUT_OF_BOUNDS;
  if (state.fills[cell]) return ERR.ALREADY_FILLED;
  if (state.selected == null) return ERR.NO_SELECTION;
  if (level.targets[cell] !== state.selected) return ERR.WRONG_COLOR;
  return null;
}

/* ------------------------------------------------------------------ */
/* Command application                                                 */
/* ------------------------------------------------------------------ */

function cloneState(s) {
  return Object.assign({}, s, {
    fills: s.fills.slice(),
    undoStack: s.undoStack.map(e => ({ cell: e.cell, byHint: e.byHint })),
    log: s.log.slice(),
    seenIds: s.seenIds.slice(),
    mechanics: Object.assign({}, s.mechanics),
  });
}

/**
 * @returns { ok, state, events, error, errorDetail }
 * Every well-formed command with a fresh id is recorded in seenIds, even when
 * rejected, so duplicate submissions are idempotent and replaying the full
 * issued stream reproduces state exactly (hashState excludes seenIds).
 */
export function applyCommand(state, level, cmd) {
  if (!cmd || typeof cmd !== 'object' || !cmd.type || !cmd.id) {
    return { ok: false, state, events: [], error: ERR.BAD_COMMAND };
  }
  if (state.seenIds.includes(cmd.id)) {
    return { ok: true, state, events: [{ type: 'duplicate', id: cmd.id }] };
  }

  const s = cloneState(state);
  const events = [];
  const accept = () => {
    s.tick += 1;
    if (typeof cmd.elapsedMs === 'number' && cmd.elapsedMs > 0) {
      s.elapsedMs += Math.floor(cmd.elapsedMs);
    }
    s.log.push({ id: cmd.id, type: cmd.type, cell: cmd.cell, color: cmd.color });
    s.seenIds.push(cmd.id);
  };
  const fail = (error, detail) => {
    s.seenIds.push(cmd.id); // recorded; no tick, no other mutation
    return { ok: false, state: s, events, error, errorDetail: detail };
  };

  switch (cmd.type) {
    case 'select': {
      if (s.status !== 'active') return fail(ERR.GAME_OVER);
      const c = cmd.color;
      if (!Number.isInteger(c) || c < 0 || c >= level.paletteSize) return fail(ERR.BAD_COLOR);
      if (s.selected === c) {
        accept();
        events.push({ type: 'select', color: c, reselect: true });
        return { ok: true, state: s, events };
      }
      s.selected = c;
      accept();
      events.push({ type: 'select', color: c });
      return { ok: true, state: s, events };
    }

    case 'fill': {
      if (s.status !== 'active') return fail(ERR.GAME_OVER);
      if (s.remainingMoves === 0) return fail(ERR.MOVES_EXHAUSTED);
      const cell = cmd.cell;
      if (!Number.isInteger(cell) || cell < 0 || cell >= level.targets.length) return fail(ERR.OUT_OF_BOUNDS);
      if (s.fills[cell]) return fail(ERR.ALREADY_FILLED);
      if (s.selected == null) return fail(ERR.NO_SELECTION);
      if (level.targets[cell] !== s.selected) {
        // Invalid attempts are recorded (they cost score and, in move-limited
        // challenges, a move) but are not state transitions, so no tick.
        s.invalid += 1;
        if (s.remainingMoves != null) s.remainingMoves -= 1;
        s.seenIds.push(cmd.id);
        events.push({ type: 'invalid', cell, reason: ERR.WRONG_COLOR, need: level.targets[cell] });
        checkMoveLimitEnd(s, level, events);
        return { ok: false, state: s, events, error: ERR.WRONG_COLOR, errorDetail: { need: level.targets[cell] } };
      }
      s.fills[cell] = 1;
      s.filled += 1;
      s.moves += 1;
      if (s.remainingMoves != null) s.remainingMoves -= 1;
      s.undoStack.push({ cell, byHint: false });
      accept();
      events.push({ type: 'fill', cell, color: s.selected });
      checkCompletion(s, level, events);
      if (s.status === 'active') checkMoveLimitEnd(s, level, events);
      return { ok: true, state: s, events };
    }

    case 'undo': {
      if (s.status !== 'active') return fail(ERR.GAME_OVER);
      if (!s.mechanics.undo) return fail(ERR.UNDO_DISABLED);
      // Undo the most recent player fill (hint fills are permanent gifts).
      let idx = -1;
      for (let i = s.undoStack.length - 1; i >= 0; i--) {
        if (!s.undoStack[i].byHint) { idx = i; break; }
      }
      if (idx < 0) return fail(ERR.NOTHING_TO_UNDO);
      const entry = s.undoStack.splice(idx, 1)[0];
      s.fills[entry.cell] = 0;
      s.filled -= 1;
      s.undos += 1;
      accept();
      events.push({ type: 'undo', cell: entry.cell });
      return { ok: true, state: s, events };
    }

    case 'hint': {
      if (s.status !== 'active') return fail(ERR.GAME_OVER);
      if (!s.mechanics.hints) return fail(ERR.HINTS_DISABLED);
      // Prefer a cell of the selected color; otherwise any unfilled cell.
      let cell = -1;
      const rem = remainingByColor(s, level);
      const prefer = s.selected != null && rem[s.selected] > 0 ? s.selected : rem.findIndex(r => r > 0);
      if (prefer < 0) return fail(ERR.GAME_OVER);
      for (let i = 0; i < level.targets.length; i++) {
        if (!s.fills[i] && level.targets[i] === prefer) { cell = i; break; }
      }
      s.selected = prefer;
      s.fills[cell] = 1;
      s.filled += 1;
      s.hints += 1;
      s.undoStack.push({ cell, byHint: true });
      accept();
      events.push({ type: 'hint', cell, color: prefer });
      checkCompletion(s, level, events);
      return { ok: true, state: s, events };
    }

    case 'sync': {
      // Pure time accumulation checkpoint; no rule change.
      accept();
      events.push({ type: 'sync', elapsedMs: s.elapsedMs });
      return { ok: true, state: s, events };
    }

    default:
      return fail(ERR.BAD_COMMAND);
  }
}

function checkCompletion(s, level, events) {
  if (s.filled >= s.total) {
    s.status = 'ended';
    s.terminalReason = TERMINAL.COMPLETED;
    events.push({ type: 'complete', score: score(s, level) });
  }
}

function checkMoveLimitEnd(s, level, events) {
  if (s.status === 'active' && s.remainingMoves != null && s.remainingMoves <= 0 && s.filled < s.total) {
    s.status = 'ended';
    s.terminalReason = TERMINAL.MOVES_EXHAUSTED;
    events.push({ type: 'ended', reason: TERMINAL.MOVES_EXHAUSTED, score: score(s, level) });
  }
}

/* ------------------------------------------------------------------ */
/* Scoring — integer components, breakdown returned                    */
/* ------------------------------------------------------------------ */

export function score(state, level) {
  const cells = state.filled * 10;
  const completion = state.terminalReason === TERMINAL.COMPLETED ? 1000 : 0;
  const accuracy = Math.max(0, 500 - state.invalid * 50);
  const parMs = level.par ? level.par.timeMs : 0;
  const timeBonus = state.terminalReason === TERMINAL.COMPLETED && parMs > 0
    ? Math.max(0, Math.floor((parMs - state.elapsedMs) / 1000) * 5) : 0;
  const hintPenalty = state.hints * -25;
  const undoPenalty = state.undos * -5;
  const total = Math.max(0, cells + completion + accuracy + timeBonus + hintPenalty + undoPenalty);
  return { cells, completion, accuracy, timeBonus, hintPenalty, undoPenalty, total };
}

/**
 * Tie-break ordering: completion, fewer invalid, lower elapsed, stable session id.
 * Returns negative if a beats b.
 */
export function compareResults(a, b) {
  const pa = a.state.filled / a.state.total, pb = b.state.filled / b.state.total;
  if (pa !== pb) return pb - pa;
  if (a.state.invalid !== b.state.invalid) return a.state.invalid - b.state.invalid;
  if (a.state.elapsedMs !== b.state.elapsedMs) return a.state.elapsedMs - b.state.elapsedMs;
  return String(a.sessionId || '').localeCompare(String(b.sessionId || ''));
}

/* ------------------------------------------------------------------ */
/* Replay                                                              */
/* ------------------------------------------------------------------ */

/**
 * Replay a command log from scratch. Returns { state, hashes } — hashes are
 * periodic state hashes for envelope verification.
 */
export function replay(level, opts, commands, hashEvery = 10) {
  let state = createGame(level, opts);
  const hashes = [hashState(state)];
  for (const cmd of commands) {
    const r = applyCommand(state, level, cmd);
    state = r.state;
    if (state.tick % hashEvery === 0) hashes.push(hashState(state));
  }
  hashes.push(hashState(state));
  return { state, hashes };
}
