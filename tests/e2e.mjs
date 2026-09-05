/**
 * Color Haven — end-to-end playthrough test (dev only, not shipped).
 *
 * Drives the real visible UI in headless Chrome (playwright-core + system
 * Chrome): title → settings → journey map → stage 1 played to completion by
 * tapping palette buttons and board regions → results → next stage →
 * hint/undo → pause/resume (incl. pause → settings) → leave round → title.
 * Runs twice: desktop 1280x800 and mobile 390x844 (touch).
 *
 * Self-contained: starts its own static server on an ephemeral port. The
 * repo's server.js is the StarHermit authoritative game script and is NOT
 * used here; a minimal /api/v1/time endpoint is included so the platform
 * probe succeeds exactly as it would when hosted.
 *
 * Game state (window.__colorhaven) is read only for synchronization and for
 * locating the on-screen position of board regions; every action goes
 * through the visible UI (real clicks/taps/keys).
 *
 * Run: npm run test:e2e
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const browserNoise = /GL Driver Message|GPU stall due to ReadPixels|Automatic fallback to software WebGL|EnableWebGLDeveloperExtensions|swiftshader|AudioContext was not allowed to start/i;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.opus': 'audio/ogg',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.glb': 'model/gltf-binary',
  '.woff2': 'font/woff2',
  '.ts': 'text/plain; charset=utf-8',
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/v1/time') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ now: Date.now() }));
      return;
    }
    let p = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
    if (p.startsWith('..')) { res.writeHead(404); res.end('nope'); return; }
    if (p === '' || p.endsWith('/')) p += 'index.html';
    const file = join(ROOT, p);
    if (!file.startsWith(ROOT)) { res.writeHead(404); res.end('nope'); return; }
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end('not found');
  }
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const BASE = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
});

const SHOT = (stage, vp) => `/tmp/color-haven-e2e-${stage}-${vp}.png`;

async function runPass(label, viewport, hasTouch) {
  const errors = [];
  const context = await browser.newContext({ viewport, hasTouch });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !browserNoise.test(m.text())) errors.push(`console: ${m.text()}`); });

  const tap = async (x, y) => { hasTouch ? await page.touchscreen.tap(x, y) : await page.mouse.click(x, y); };
  const step = async (name, fn) => { await fn(); console.log(`ok - [${label}] ${name}`); };
  const screenShown = (name) => page.waitForFunction(
    (n) => { const el = document.querySelector('#screen-' + n); return el && !el.hidden; }, name, { timeout: 8000 });
  const screenGone = (name) => page.waitForFunction(
    (n) => { const el = document.querySelector('#screen-' + n); return el && el.hidden; }, name, { timeout: 8000 });
  const readState = () => page.evaluate(() => {
    const app = window.__colorhaven;
    if (!app || !app.session) return null;
    const s = app.session.state;
    return {
      status: s.status, filled: s.filled, total: s.total, selected: s.selected,
      hints: s.hints, undos: s.undos, invalid: s.invalid, paused: app.session.paused,
      fills: Array.from(s.fills), targets: Array.from(app.level.targets),
      levelId: app.level.id, paletteSize: app.level.paletteSize,
    };
  });
  /** Tap a board region through the real pointer pipeline; verify it filled. */
  const fillCell = async (cell) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const pos = await page.evaluate((c) => window.__colorhaven.renderer.cellToScreen(c), cell);
      if (!pos) throw new Error(`no screen position for cell ${cell}`);
      await tap(pos.x, pos.y);
      const filled = await page.evaluate((c) => !!(window.__colorhaven.session && window.__colorhaven.session.state.fills[c]), cell);
      if (filled) return;
      await page.waitForTimeout(120);
    }
    throw new Error(`tap on region ${cell} did not fill it`);
  };

  try {
    await step('load + title visible', async () => {
      await page.goto(BASE, { waitUntil: 'load' });
      await page.waitForFunction(() => window.__colorhaven && !document.querySelector('#app').hidden, null, { timeout: 10000 });
      await screenShown('title');
      await page.screenshot({ path: SHOT('title', label) });
    });

    await step('journey map shows 40 stages, stage 1 unlocked', async () => {
      await page.click('.mode-btn[data-mode="journey"]');
      await screenShown('journey');
      const cells = await page.locator('.stage-btn').count();
      if (cells !== 40) throw new Error(`expected 40 stages, got ${cells}`);
      const locked = await page.locator('.stage-btn.locked').count();
      if (locked !== 39) throw new Error(`expected 39 locked stages, got ${locked}`);
      await page.screenshot({ path: SHOT('journey', label) });
      await page.locator('.stage-btn:not(.locked)').first().click();
      await page.waitForFunction(() => {
        const app = window.__colorhaven;
        return app.session && app.session.state.status === 'active' && app.level.id === 'journey-1';
      }, null, { timeout: 8000 });
      if (await page.locator('#btn-pause').isHidden()) throw new Error('pause button not offered in play');
      await page.screenshot({ path: SHOT('stage1-start', label) });
    });

    await step('help opens and closes (from topbar in play)', async () => {
      await page.click('#btn-help');
      await screenShown('help');
      if (await page.locator('.help-card').count() < 3) throw new Error('help cards missing');
      await page.click('#btn-help-close');
      await screenGone('help');
    });

    await step('settings open, toggle high contrast, close', async () => {
      await page.click('#btn-settings');
      await screenShown('settings');
      const box = page.locator('#set-contrast');
      const was = await box.isChecked();
      was ? await box.uncheck() : await box.check();
      const applied = await page.evaluate(() => document.body.classList.contains('high-contrast'));
      if (applied === was) throw new Error('high-contrast setting not applied to body');
      await page.screenshot({ path: SHOT('settings', label) });
      await page.click('#btn-settings-close');
      await screenGone('settings');
    });

    await step('play stage 1 to completion via palette + region taps', async () => {
      // Wait for the intro banner to clear so it cannot intercept taps.
      await page.waitForFunction(() => document.querySelector('#hud-banner').hidden, null, { timeout: 6000 });
      let midShot = false;
      for (let guard = 0; guard < 500; guard++) {
        const st = await readState();
        if (!st || st.status !== 'active') break;
        const cell = st.fills.findIndex((f) => !f);
        if (cell < 0) break;
        if (st.selected !== st.targets[cell]) {
          await page.locator('.pal-btn').nth(st.targets[cell]).click();
        }
        await fillCell(cell);
        if (!midShot && st.filled + 1 >= st.total / 2) {
          await page.screenshot({ path: SHOT('stage1-mid', label) });
          midShot = true;
        }
      }
      const st = await readState();
      if (!st || st.status !== 'ended') throw new Error('round did not end after all regions filled');
      if (st.invalid !== 0) throw new Error(`expected clean run, got ${st.invalid} slips`);
      console.log(`  stage 1 complete: ${st.filled}/${st.total} regions, ${st.invalid} slips`);
    });

    await step('results screen with score breakdown', async () => {
      await screenShown('results');
      const heading = await page.textContent('#results-h');
      if (!/complete/i.test(heading)) throw new Error('unexpected results heading: ' + heading);
      const rows = await page.locator('#results-table tbody tr').count();
      if (rows < 6) throw new Error(`expected breakdown rows, got ${rows}`);
      await page.screenshot({ path: SHOT('results', label) });
    });

    await step('progress persisted (journey-1 starred)', async () => {
      const prog = await page.evaluate(() => JSON.parse(localStorage.getItem('colorhaven.progress.v2') || 'null'));
      if (!prog || !prog.journey || !prog.journey['journey-1']) throw new Error('journey progress not persisted');
      if (prog.journey['journey-1'].stars < 1) throw new Error('no stars recorded for journey-1');
      console.log('  journey-1:', JSON.stringify(prog.journey['journey-1']), 'gamesPlayed:', prog.gamesPlayed);
    });

    await step('next stage starts (journey-2)', async () => {
      await page.click('#btn-results-next');
      await page.waitForFunction(() => {
        const app = window.__colorhaven;
        return app.session && app.session.state.status === 'active' && app.level.id === 'journey-2';
      }, null, { timeout: 8000 });
      await page.waitForFunction(() => document.querySelector('#hud-banner').hidden, null, { timeout: 6000 });
      await page.screenshot({ path: SHOT('stage2', label) });
    });

    await step('hint + undo buttons work in play', async () => {
      const st0 = await readState();
      const cell = st0.fills.findIndex((f) => !f);
      if (st0.selected !== st0.targets[cell]) await page.locator('.pal-btn').nth(st0.targets[cell]).click();
      await fillCell(cell); // a player fill so undo has something to lift
      await page.click('#btn-hint');
      await page.waitForFunction((n) => window.__colorhaven.session.state.hints === n, st0.hints + 1);
      await page.click('#btn-undo');
      await page.waitForFunction((n) => window.__colorhaven.session.state.undos === n, st0.undos + 1);
      const st1 = await readState();
      if (st1.filled !== st0.filled + 1) throw new Error(`hint(+1) then undo(-1) expected filled=${st0.filled + 1}, got ${st1.filled}`);
    });

    await step('pause → settings → resume', async () => {
      await page.click('#btn-pause');
      await screenShown('pause');
      const paused = await page.evaluate(() => window.__colorhaven.session.paused);
      if (!paused) throw new Error('session not paused');
      await page.screenshot({ path: SHOT('pause', label) });
      await page.click('#btn-pause-settings');
      await screenShown('settings');
      await page.click('#btn-settings-close');
      await screenShown('pause'); // returns to pause, not the board
      await page.click('#btn-resume');
      await screenGone('pause');
      const resumed = await page.evaluate(() => !window.__colorhaven.session.paused);
      if (!resumed) throw new Error('session did not resume');
    });

    await step('leave round → back to title', async () => {
      await page.keyboard.press('Escape'); // keyboard pause path
      await screenShown('pause');
      await page.click('#btn-pause-leave');
      await screenShown('title');
      const session = await page.evaluate(() => window.__colorhaven.session);
      if (session) throw new Error('session still live after leaving round');
      await page.screenshot({ path: SHOT('home', label) });
    });
  } finally {
    const real = errors.filter((e) => !browserNoise.test(e));
    if (real.length) {
      console.log(`PAGE ERRORS [${label}]:\n` + real.join('\n'));
      await context.close().catch(() => {});
      throw new Error(`${real.length} page error(s) in ${label} pass`);
    }
    await context.close();
  }
}

try {
  await runPass('desktop', { width: 1280, height: 800 }, false);
  await runPass('mobile', { width: 390, height: 844 }, true);
  console.log('\nE2E PASS — color-haven, desktop + mobile, no page errors');
} finally {
  await browser.close();
  server.close();
}
