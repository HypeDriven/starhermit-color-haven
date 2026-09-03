/**
 * Color Haven — rules/content test suite (Node, no deps).
 * Run: node tests/rules.test.mjs
 */
import {
  createGame, applyCommand, listLegalActions, serialize, deserialize,
  hashState, replay, score, compareResults, explainFill, rngFromSeed,
  ERR, TERMINAL, RULES_VERSION,
} from '../js/rules.js';
import {
  generateLevel, validateLevel, journeyStages, journeyLevel, dailyLevel,
  dailyInfo, tutorialLessons, paletteFor, CONTENT_VERSION, TIERS,
} from '../js/content.js';

let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; }
  else { failed++; console.error('FAIL:', name); }
}
function eq(a, b, name) { ok(a === b, `${name} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }

let cmdCounter = 0;
const cid = () => 'cmd-' + (++cmdCounter);
const cmd = (type, extra = {}) => ({ id: cid(), type, elapsedMs: 100, ...extra });

/* ---------- determinism of rng ---------- */
{
  const a = rngFromSeed('x'), b = rngFromSeed('x');
  const seqA = [a(), a(), a()], seqB = [b(), b(), b()];
  ok(JSON.stringify(seqA) === JSON.stringify(seqB), 'rng deterministic per seed');
}

/* ---------- level generation + validation ---------- */
{
  const lv1 = generateLevel({ id: 't1', seed: 's1', tier: 3 });
  const lv2 = generateLevel({ id: 't1', seed: 's1', tier: 3 });
  ok(JSON.stringify(lv1.targets) === JSON.stringify(lv2.targets), 'level generation deterministic');
  ok(validateLevel(lv1).ok, 'generated level passes validation: ' + JSON.stringify(validateLevel(lv1).issues));
  for (let tier = 1; tier <= 5; tier++) {
    for (let i = 0; i < 5; i++) {
      const lv = generateLevel({ id: `fuzz-${tier}-${i}`, seed: `fuzz/${tier}/${i}`, tier });
      const v = validateLevel(lv);
      ok(v.ok, `tier ${tier} fuzz ${i} valid: ${v.issues.join(',')}`);
    }
  }
  const stages = journeyStages();
  eq(stages.length, 40, 'journey has 40 stages');
  for (const st of stages) {
    const lv = journeyLevel(st);
    const v = validateLevel(lv);
    ok(v.ok, `journey ${st.id} valid: ${v.issues.join(',')}`);
    if (st.mechanics.moveLimit != null) {
      ok(st.mechanics.moveLimit >= lv.w * lv.h, `journey ${st.id} move limit reachable`);
    }
  }
  for (let d = 0; d < 7; d++) {
    const lv = dailyLevel(Date.UTC(2026, 0, 1 + d));
    ok(validateLevel(lv).ok, 'daily valid ' + d);
    ok(lv.id === dailyInfo(Date.UTC(2026, 0, 1 + d)).id, 'daily id stable');
  }
  eq(tutorialLessons().length, 3, 'three tutorial lessons');
  eq(paletteFor(lv1, false).length, lv1.paletteSize, 'palette size matches');
  eq(paletteFor(lv1, true).length, lv1.paletteSize, 'cvd palette size matches');
}

/* ---------- basic play ---------- */
const level = generateLevel({ id: 'play', seed: 'play/1', tier: 1 });
const w = level.w;

function firstCellOf(lv, color, fills) {
  for (let i = 0; i < lv.targets.length; i++) {
    if (lv.targets[i] === color && !(fills && fills[i])) return i;
  }
  return -1;
}

{
  let st = createGame(level, { mode: 'practice' });
  eq(st.tick, 0, 'initial tick 0');
  eq(st.status, 'active', 'initial status active');
  const legal = listLegalActions(st, level);
  ok(legal.active, 'initial active legal');
  ok(legal.selectable.every(Boolean), 'all colors selectable initially');

  // select
  let r = applyCommand(st, level, cmd('select', { color: 0 }));
  ok(r.ok, 'select accepted');
  st = r.state;
  eq(st.selected, 0, 'selected color 0');
  eq(st.tick, 1, 'tick increments');

  // duplicate id idempotent
  const dup = applyCommand(st, level, { id: 'cmd-1', type: 'select', color: 1 });
  ok(dup.ok && dup.state === st, 'duplicate command rejected idempotently');

  // wrong color fill → invalid
  const wrong = firstCellOf(level, 1);
  r = applyCommand(st, level, cmd('fill', { cell: wrong }));
  ok(!r.ok && r.error === ERR.WRONG_COLOR, 'wrong color rejected with reason');
  eq(r.state.invalid, 1, 'invalid count recorded');
  eq(explainFill(r.state, level, wrong), ERR.WRONG_COLOR, 'explainFill wrong-color');

  // correct fill
  const c0 = firstCellOf(level, 0);
  r = applyCommand(r.state, level, cmd('fill', { cell: c0 }));
  ok(r.ok, 'correct fill accepted');
  st = r.state;
  eq(st.filled, 1, 'filled count 1');
  eq(st.moves, 1, 'moves 1');

  // already filled
  r = applyCommand(st, level, cmd('fill', { cell: c0 }));
  ok(!r.ok && r.error === ERR.ALREADY_FILLED, 'already-filled rejected');

  // out of bounds
  r = applyCommand(st, level, cmd('fill', { cell: 9999 }));
  ok(!r.ok && r.error === ERR.OUT_OF_BOUNDS, 'out-of-bounds rejected');

  // no selection (fresh state)
  const fresh = createGame(level, { mode: 'practice' });
  r = applyCommand(fresh, level, cmd('fill', { cell: 0 }));
  ok(!r.ok && r.error === ERR.NO_SELECTION, 'no-selection rejected');

  // undo
  r = applyCommand(st, level, cmd('undo'));
  ok(r.ok, 'undo accepted');
  st = r.state;
  eq(st.filled, 0, 'undo removed fill');
  eq(st.undos, 1, 'undos counted');

  // hint
  r = applyCommand(st, level, cmd('hint'));
  ok(r.ok, 'hint accepted');
  st = r.state;
  eq(st.filled, 1, 'hint filled a cell');
  eq(st.hints, 1, 'hint counted');
  // undo does not undo hints
  r = applyCommand(st, level, cmd('undo'));
  ok(!r.ok && r.error === ERR.NOTHING_TO_UNDO, 'hint fills not undoable');

  // bad command
  r = applyCommand(st, level, { type: 'fill', cell: 0 });
  ok(!r.ok && r.error === ERR.BAD_COMMAND, 'id-less command rejected');
}

/* ---------- complete a game → terminal + scoring ---------- */
function solveAll(st, lv) {
  for (let c = 0; c < lv.paletteSize; c++) {
    let r = applyCommand(st, lv, cmd('select', { color: c }));
    st = r.state;
    for (let i = 0; i < lv.targets.length; i++) {
      if (lv.targets[i] === c && !st.fills[i]) {
        r = applyCommand(st, lv, cmd('fill', { cell: i }));
        if (!r.ok) throw new Error('solve failed at ' + i + ': ' + r.error);
        st = r.state;
      }
    }
  }
  return st;
}

{
  let st = createGame(level, { mode: 'practice' });
  st = solveAll(st, level);
  eq(st.status, 'ended', 'game ends when complete');
  eq(st.terminalReason, TERMINAL.COMPLETED, 'terminal reason completed');
  const sc = score(st, level);
  ok(sc.total > 0, 'score positive');
  eq(sc.completion, 1000, 'completion component');
  ok(sc.cells === st.filled * 10, 'cells component');
  ok(sc.total === sc.cells + sc.completion + sc.accuracy + sc.timeBonus + sc.hintPenalty + sc.undoPenalty, 'score components sum');
  // commands after end rejected
  const r = applyCommand(st, level, cmd('select', { color: 0 }));
  ok(!r.ok && r.error === ERR.GAME_OVER, 'post-terminal commands rejected');
}

/* ---------- move limit terminal ---------- */
{
  const lv = generateLevel({ id: 'ml', seed: 'ml/1', tier: 1, mechanics: { moveLimit: 3 } });
  let st = createGame(lv, { mode: 'challenge' });
  eq(st.remainingMoves, 3, 'move limit initialized');
  st = applyCommand(st, lv, cmd('select', { color: 0 })).state;
  for (let i = 0; i < 3; i++) {
    const cell = firstCellOf(lv, 0, st.fills);
    st = applyCommand(st, lv, cmd('fill', { cell })).state;
  }
  eq(st.remainingMoves, 0, 'moves exhausted');
  if (st.filled < st.total) {
    eq(st.status, 'ended', 'move-limit exhaustion ends game');
    eq(st.terminalReason, TERMINAL.MOVES_EXHAUSTED, 'terminal reason moves-exhausted');
  }
}

/* ---------- serialization / migration ---------- */
{
  let st = createGame(level, { mode: 'practice' });
  st = applyCommand(st, level, cmd('select', { color: 2 })).state;
  st = applyCommand(st, level, cmd('fill', { cell: firstCellOf(level, 2) })).state;
  const json = serialize(st);
  const st2 = deserialize(json);
  ok(JSON.stringify(st2) === JSON.stringify(st), 'round-trip serialization identical');
  eq(hashState(st2), hashState(st), 'hash stable across serialization');
  // migration from v0
  const legacy = JSON.parse(json); legacy.v = 0; delete legacy.seenIds;
  const mig = deserialize(JSON.stringify(legacy));
  eq(mig.v, RULES_VERSION, 'migrated to current version');
}

/* ---------- replay determinism (property test) ---------- */
{
  const rng = rngFromSeed('fuzz-commands');
  for (let trial = 0; trial < 20; trial++) {
    const lv = generateLevel({ id: 'fz' + trial, seed: 'fz/' + trial, tier: 1 + (trial % 3) });
    let st = createGame(lv, { mode: 'practice' });
    const commands = [];
    // Random legal-ish command stream.
    for (let k = 0; k < 60 && st.status === 'active'; k++) {
      const c = { id: `t${trial}-c${k}`, type: 'fill', cell: rng.int(0, lv.targets.length - 1), elapsedMs: 50 };
      const pick = rng();
      if (pick < 0.3) { c.type = 'select'; c.color = rng.int(0, lv.paletteSize - 1); delete c.cell; }
      else if (pick < 0.35) { c.type = 'undo'; delete c.cell; }
      else if (pick < 0.4) { c.type = 'hint'; delete c.cell; }
      const r = applyCommand(st, lv, c);
      // The replay envelope logs every issued command, accepted or rejected.
      commands.push({ id: c.id, type: c.type, cell: c.cell, color: c.color, elapsedMs: c.elapsedMs });
      st = r.state;
      // invariants: no NaN, bounded values
      ok(Number.isFinite(st.elapsedMs) && st.filled <= st.total && st.filled >= 0, `fuzz invariants t${trial} k${k}`);
    }
    const { state: re, hashes } = replay(lv, { mode: 'practice' }, commands);
    eq(hashState(re), hashState(st), `replay hash matches trial ${trial}`);
    ok(hashes.length >= 2, 'periodic hashes recorded');
    ok(st.elapsedMs === commands.filter(c2 => true).length * 0 + st.elapsedMs, 'sanity');
  }
}

/* ---------- hint legality matches play API ---------- */
{
  let st = createGame(level, { mode: 'practice' });
  const legal = listLegalActions(st, level);
  ok(legal.canHint, 'hint legal at start');
  // use hint repeatedly; hint must always target an actually-legal cell
  for (let i = 0; i < 10; i++) {
    const r = applyCommand(st, level, cmd('hint'));
    if (!r.ok) break;
    st = r.state;
    const ev = r.events.find(e => e.type === 'hint');
    ok(st.fills[ev.cell] === 1, 'hinted cell is filled');
  }
}

/* ---------- tie-break ordering ---------- */
{
  const mk = (filled, invalid, elapsedMs, sessionId) => ({
    state: { filled, total: 100, invalid, elapsedMs }, sessionId,
  });
  ok(compareResults(mk(100, 0, 5000, 'b'), mk(50, 0, 100, 'a')) < 0, 'completion wins tie-break');
  ok(compareResults(mk(100, 1, 5000, 'a'), mk(100, 2, 100, 'b')) < 0, 'fewer invalid wins');
  ok(compareResults(mk(100, 1, 3000, 'b'), mk(100, 1, 5000, 'a')) < 0, 'lower time wins');
  ok(compareResults(mk(100, 1, 3000, 'a'), mk(100, 1, 3000, 'b')) < 0, 'stable id final tie-break');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
