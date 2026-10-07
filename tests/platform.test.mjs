// platform.test.mjs — js/platform.js over starhermit-sdk.js with a stubbed
// fetch and launch fragment: token read, profile nickname, cloud save
// round-trip on game:<slug>, settings KV patch, bindings, invite link, and
// no network at all when standalone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installHosted, installStandalone, UID } from './starhermit-harness.mjs';
import { Platform } from '../js/platform.js';

const SLUG = 'color-haven';

test('hosted: token, profile, cloud save game:<slug>, settings, bindings, invite', async () => {
  const { sdk, env, win } = installHosted(SLUG);
  assert.ok(!/game_token/.test(win.history.url || ''), 'fragment stripped');
  const p = new Platform();
  await p.init();
  assert.ok(p.hosted);
  assert.equal(p.userId, UID);
  assert.equal(p.scope, SLUG);
  assert.equal(p.headers().Authorization, 'Bearer ' + sdk.token);
  assert.equal((await p.fetchProfile()).name, 'Ada');

  assert.equal(await p.loadCloud(), null);
  p.saveCloud({ progress: { gamesPlayed: 3 } });
  assert.equal(await p._flushSave(), true);
  const put = env.calls.find((c) => c.method === 'PUT');
  assert.ok(put.url.endsWith('/cloud-saves/game%3Acolor-haven'), put.url);
  assert.deepEqual(await p.loadCloud(), { progress: { gamesPlayed: 3 } });
  assert.equal(p.sync, 'synced');

  assert.deepEqual(await p.getSettings(), {}, 'only preference keys pass');
  p.mirrorSettings({ volMusic: 10, tutorialDone: true });
  await new Promise((r) => setTimeout(r, 900));
  const patch = env.calls.find((c) => c.method === 'PATCH');
  assert.deepEqual(JSON.parse(patch.init.body).settings, { volMusic: 10 });

  await p.loadBindings();
  assert.equal(p.actionFor({ code: 'Digit3' }), 'color3');
  assert.equal(p.actionFor({ code: 'Space' }), 'fill');
  assert.equal(p.keyLabel('color8'), '8');
  assert.equal(p.inviteLink(), `https://dashboard.starhermit.com/game-invite/${UID}/${SLUG}`);
  assert.equal(p.canSignIn(), false);

  const sent = [];
  sdk.submitScores = async (sc) => { sent.push(sc); return Object.keys(sc); };
  sdk.leaderboard = async (key) => ({ items: key === 'high-score' ? [{ userId: UID, rank: 3 }] : [] });
  assert.deepEqual(await p.submitPlatformScore(1520.6), { posted: true, rank: 3 });
  assert.deepEqual(sent, [{ 'high-score': 1521 }]);
  sdk.submitScores = async () => [];
  assert.deepEqual(await p.submitPlatformScore(10), { posted: false, rank: null });
});

test('leaderboard line strings in every locale', async () => {
  const { platformStrings, PLATFORM_LOCALES } = await import('../js/platform-strings.js');
  assert.equal(PLATFORM_LOCALES.length, 9);
  for (const l of PLATFORM_LOCALES) {
    const t = platformStrings(l);
    for (const k of ['lbPosting', 'lbRank', 'lbPosted', 'lbNotPosted']) assert.ok(t[k], l + ' ' + k);
    assert.ok(t.lbRank.includes('{rank}'));
  }
});

test('standalone: no token, no network', async () => {
  const st = installStandalone();
  try {
    const p = new Platform();
    await p.init();
    assert.equal(p.hosted, false);
    assert.equal(p.online, false);
    assert.equal(await p.loadCloud(), null);
    await p.saveCloud({});
    await p._flushSave();
    assert.deepEqual(await p.getSettings(), {});
    p.mirrorSettings({ volMusic: 1 });
    await p.loadBindings();
    assert.equal(p.actionFor({ code: 'KeyH' }), 'hint');
    assert.equal(p.inviteLink(), null);
    assert.deepEqual(await p.submitPlatformScore(900), { posted: false, rank: null });
    assert.deepEqual(st.calls, []);
  } finally { st.restore(); }
});
