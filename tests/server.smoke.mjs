/* End-to-end smoke test against a running server (started by the caller). */
import { generateLevel, dailyLevel, dailyInfo } from '../js/content.js';
import { createGame, applyCommand, hashState, score } from '../js/rules.js';

const BASE = process.env.BASE || 'http://localhost:8091';
let ok = 0, bad = 0;
const check = (c, n) => { c ? ok++ : (bad++, console.error('FAIL', n)); };

// server time
{
  const r = await fetch(BASE + '/api/v1/time');
  const d = await r.json();
  check(r.ok && Math.abs(d.now - Date.now()) < 5000, 'time endpoint');
}
// static index
{
  const r = await fetch(BASE + '/index.html');
  const t = await r.text();
  check(r.ok && t.includes('Color Haven'), 'index served');
  const r2 = await fetch(BASE + '/js/rules.js');
  check(r2.ok, 'js served');
  const r3 = await fetch(BASE + '/../server.js').catch(() => null);
  check(!r3 || r3.status === 404, 'no path traversal');
}
// solve a daily and submit with a valid envelope
{
  const info = dailyInfo(Date.now());
  const level = dailyLevel(Date.now());
  let st = createGame(level, { mode: 'daily' });
  const commands = [];
  let n = 0;
  const push = (type, extra = {}) => {
    const c = { id: 'smoke-' + (++n), type, elapsedMs: 120, ...extra };
    const r = applyCommand(st, level, c);
    commands.push({ id: c.id, type, cell: c.cell, color: c.color, elapsedMs: 120 });
    st = r.state;
  };
  for (let col = 0; col < level.paletteSize; col++) {
    push('select', { color: col });
    for (let i = 0; i < level.targets.length; i++) {
      if (level.targets[i] === col && !st.fills[i]) push('fill', { cell: i });
    }
  }
  check(st.terminalReason === 'completed', 'daily solved');
  const sc = score(st, level);
  const entry = {
    name: 'Smoke', score: sc.total, elapsedMs: st.elapsedMs, invalid: 0,
    sessionId: 'smoke-session-1', levelId: level.id, contentV: level.v, seed: level.seed,
    assists: { hints: true, undo: true },
    envelope: {
      schemaV: 1, contentV: level.v, levelId: level.id, seed: level.seed, tier: level.tier,
      mode: 'daily', mechanics: st.mechanics, sessionId: 'smoke-session-1',
      initialHash: hashState(createGame(level, { mode: 'daily' })),
      commands, hashes: [],
      result: { terminalReason: st.terminalReason, score: sc },
      checksum: hashState(st),
    },
  };
  const board = 'daily-' + info.date;
  const r = await fetch(BASE + '/api/v1/leaderboard/' + board, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(entry),
  });
  const d = await r.json();
  check(r.ok && d.ok && d.rank >= 1 && d.casual === false, 'valid score accepted: ' + JSON.stringify(d));
  // tampered score rejected
  const bad1 = await fetch(BASE + '/api/v1/leaderboard/' + board, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...entry, sessionId: 'smoke-cheat', score: sc.total + 500 }),
  });
  check(bad1.status === 422, 'tampered score rejected');
  // idempotent duplicate
  const dup = await fetch(BASE + '/api/v1/leaderboard/' + board, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(entry),
  });
  const dd = await dup.json();
  check(dup.ok && dd.rank === d.rank, 'duplicate submission idempotent');
  // fetch board
  const b = await fetch(BASE + '/api/v1/leaderboard/' + board);
  const bd = await b.json();
  check(bd.entries.length === 1 && bd.entries[0].envelope === undefined, 'board fetch, envelope hidden');
}
// save round-trip
{
  const doc = { v: 2, journey: { 'journey-1': { best: 1234, stars: 3 } } };
  await fetch(BASE + '/api/v1/save', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: 'test', doc }) });
  const r = await fetch(BASE + '/api/v1/save?key=test');
  const d = await r.json();
  check(d.doc && d.doc.journey['journey-1'].best === 1234, 'save round-trip');
}

console.log(`smoke: ${ok} passed, ${bad} failed`);
process.exit(bad ? 1 : 0);
