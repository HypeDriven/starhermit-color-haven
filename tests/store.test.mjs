// The save model (js/store.js): the engine save document, the browser
// build's cloud save as the engine shows it (foreign: the text of
// { progress }), the conflict merge, the game's own settings, finished
// rounds, the device's round snapshot and local leaderboards. The engine
// client's signed-in paths (foreign migration, legacy settings, score
// posting) can't run here; their logic is these functions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as S from '../js/store.js';
import { generateLevel } from '../js/content.js';
import { GameSession } from '../js/session.js';

function memoryStore() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), map: m };
}

test('save-conflict merge keeps the better of both devices', () => {
  const m = S.mergeProgress(
    { journey: { 'journey-1': { best: 900, stars: 1 } }, achievements: { first_completion: '2026-10-02T00:00:00Z' }, dailyDays: ['2026-10-01'], gamesPlayed: 3, tutorialDone: true, playerId: 'abc' },
    { journey: { 'journey-1': { best: 400, stars: 3 }, 'journey-2': { best: 100, stars: 1 } }, achievements: { first_completion: '2026-10-01T00:00:00Z', long_road: 'x' }, dailyDays: ['2026-10-02'], gamesPlayed: 7 });
  assert.deepEqual(m.journey['journey-1'], { best: 900, stars: 3 });
  assert.ok(m.journey['journey-2']);
  assert.equal(m.achievements.first_completion, '2026-10-01T00:00:00Z');
  assert.deepEqual(m.dailyDays, ['2026-10-01', '2026-10-02']);
  assert.equal(m.gamesPlayed, 7);
  assert.equal(m.tutorialDone, true);
  assert.equal(m.playerId, 'abc');
});

test('the engine save document: ours is read and normalized, anything else is not', () => {
  assert.equal(S.docFromSave(null), null);
  assert.equal(S.docFromSave([1, 2]), null);
  assert.equal(S.docFromSave({ v: 1 }), null);
  const d = S.docFromSave({ v: 1, progress: { gamesPlayed: 2.7, journey: [], dailyDays: 'x' } });
  assert.equal(d.v, S.SAVE_VERSION);
  assert.equal(d.progress.gamesPlayed, 2);
  assert.deepEqual(d.progress.journey, {});
  assert.deepEqual(d.progress.dailyDays, []);
  assert.equal(d.progress.tutorialDone, false);
});

test('the browser build\'s cloud save (foreign text { progress }) migrates', () => {
  // As the JS SDK's saveJSON wrote it: JSON.stringify({ progress }) in the zip's save.json.
  const text = JSON.stringify({ progress: { v: 2, journey: { 'journey-1': { best: 2400, stars: 3 } }, achievements: { first_completion: '2026-09-30T10:00:00.000Z' }, dailyDays: ['2026-09-30'], gamesPlayed: 4, tutorialDone: false, playerId: 'f09c66' } });
  const d = S.fromBrowserSave(text);
  assert.deepEqual(d.progress.journey['journey-1'], { best: 2400, stars: 3 });
  assert.equal(d.progress.gamesPlayed, 4);
  assert.equal(d.progress.playerId, 'f09c66');
  // The Learn flag lived in the device's settings: a player who finished pictures has done the lessons.
  assert.equal(d.progress.tutorialDone, true);
  assert.equal(S.fromBrowserSave(JSON.stringify({ progress: {} })).progress.tutorialDone, false);
  assert.equal(S.fromBrowserSave('not json'), null);
  assert.equal(S.fromBrowserSave(null), null);
  assert.equal(S.fromBrowserSave('{"other":1}'), null);
  // Merged with what this device has.
  const merged = S.mergeProgress({ ...S.defaultProgress(), gamesPlayed: 9 }, d.progress);
  assert.equal(merged.gamesPlayed, 9);
  assert.deepEqual(merged.journey['journey-1'], { best: 2400, stars: 3 });
});

test('the game\'s own settings and the browser build\'s keys', () => {
  assert.deepEqual(S.GAME_SETTING_KEYS.sort(), ['captions', 'cvdPalette', 'haptics', 'leftHanded']);
  for (const k of S.GAME_SETTING_KEYS) assert.ok(S.BROWSER_SETTING_KEYS.includes(k));
  assert.equal(S.checkSetting('captions', true), true);
  assert.equal(S.checkSetting('captions', 'yes'), undefined);
  assert.equal(S.checkSetting('volMusic', 60), undefined);
});

test('a finished journey round records stars, best and achievements once', () => {
  const level = generateLevel({ id: 'journey-1', seed: 'journey/1', tier: 1 });
  const p = S.defaultProgress();
  const state = { terminalReason: 'completed', invalid: 0, hints: 0, undos: 0, elapsedMs: 1000 };
  const got = S.recordCompletion(p, { mode: 'journey', level, state, scoreTotal: 2650, nowIso: '2026-10-27T00:00:00.000Z' });
  assert.deepEqual(got.map((a) => a.key).sort(), ['first_completion', 'mechanic_mastery']);
  assert.deepEqual(p.journey['journey-1'], { best: 2650, stars: 3 });
  assert.equal(p.achievements.first_completion, '2026-10-27T00:00:00.000Z');
  assert.deepEqual(S.recordCompletion(p, { mode: 'journey', level, state: { ...state, invalid: 2 }, scoreTotal: 100 }), []);
  assert.deepEqual(p.journey['journey-1'], { best: 2650, stars: 3 });
  assert.equal(p.gamesPlayed, 2);
  assert.equal(S.nextJourneyStage(p).id, 'journey-2');
  const map = S.journeyMap(p);
  assert.equal(map[0].done.stars, 3);
  assert.equal(map[1].unlocked, true);
  assert.equal(map[2].unlocked, false);
  assert.deepEqual(S.journeyProgressSummary(p), { total: 40, done: 1, stars: 3 });
});

test('the round snapshot survives and refuses finished or broken rounds', () => {
  const ls = memoryStore();
  const level = generateLevel({ id: 'practice-x', seed: 'practice/x', tier: 1 });
  const session = new GameSession(level, { mode: 'practice' });
  session.selectColor(level.targets[0]);
  session.fillCell(0);
  S.saveSnapshot(ls, { ranked: false, boardId: null, session });
  const wrap = S.readSnapshot(ls);
  assert.equal(wrap.snap.state.filled, 1);
  assert.equal(GameSession.restore(wrap.snap).state.fills[0], 1);
  ls.setItem(S.SNAPSHOT_KEY, '{"snap":{"level":{},"state":{"filled":9,"total":4}}}');
  assert.equal(S.readSnapshot(ls), null);
  S.clearSnapshot(ls);
  assert.equal(S.readSnapshot(ls), null);
});

test('local boards rank entries, keep no envelope and cap the boards kept', () => {
  const ls = memoryStore();
  const e = (id, score, ms) => ({ name: 'Guest a', score, elapsedMs: ms, invalid: 0, sessionId: id, envelope: { commands: new Array(500).fill(0) } });
  assert.equal(S.submitScore(ls, 'daily-x', e('a', 900, 5000)).rank, 1);
  assert.equal(S.submitScore(ls, 'daily-x', e('b', 1200, 9000)).rank, 1);
  assert.equal(S.submitScore(ls, 'daily-x', e('c', 900, 4000)).rank, 2);
  const list = S.fetchBoard(ls, 'daily-x');
  assert.deepEqual(list.map((x) => x.sessionId), ['b', 'c', 'a']);
  assert.ok(list.every((x) => !('envelope' in x)));
  for (let i = 0; i < S.MAX_BOARDS + 5; i++) S.submitScore(ls, 'score-' + i, e('s' + i, 10, 10));
  assert.deepEqual(S.fetchBoard(ls, 'daily-x'), []);
  assert.equal(S.fetchBoard(ls, 'score-' + (S.MAX_BOARDS + 4)).length, 1);
  assert.equal([...ls.map.keys()].filter((k) => k.startsWith('colorhaven.board.')).length, S.MAX_BOARDS);
});
