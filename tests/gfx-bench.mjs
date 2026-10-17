// Graphics benchmark hook for tools/gfx-bench.mjs (dev-only): picks a preset in the real Settings
// screen, starts a Practice round and keeps painting regions through the visible palette and board
// taps (tile lifts, pigment puffs, motes, drifting sunlight and the post chain all run), replaying
// from the results screen.
export const presets = ['low', 'balanced', 'high', 'ultra'];
export const levels = { low: 0, balanced: 4, high: 10, ultra: 17 };

const shown = (page, n) => page.waitForFunction((id) => { const el = document.querySelector('#screen-' + id); return el && !el.hidden; }, n, { timeout: 15000 });

export async function setPreset(page, preset) {
  await page.waitForFunction(() => window.__colorhaven && window.__colorhaven.renderer, null, { timeout: 20000 });
  await shown(page, 'title');
  await page.click('#btn-title-settings');
  await shown(page, 'settings');
  await page.locator('#set-quality').scrollIntoViewIfNeeded();
  await page.selectOption('#set-quality', preset);
  await page.waitForFunction((p) => document.body.dataset.gfxPreset === p, preset);
  await page.click('#btn-settings-close');
}

async function step(page, mobile) {
  if (await page.locator('#btn-results-replay:visible').count()) { await page.click('#btn-results-replay', { timeout: 5000 }); return; }
  const st = await page.evaluate(() => {
    const app = window.__colorhaven;
    if (!app || !app.session || app.session.state.status !== 'active' || !document.querySelector('#hud-banner').hidden) return null;
    const s = app.session.state;
    const cell = Array.from(s.fills).findIndex((f) => !f);
    if (cell < 0) return null;
    return { cell, selected: s.selected, target: app.level.targets[cell], pos: app.renderer.cellToScreen(cell) };
  });
  if (!st || !st.pos) return;
  if (st.selected !== st.target) await page.locator('.pal-btn').nth(st.target).click({ timeout: 5000 });
  if (mobile) await page.touchscreen.tap(st.pos.x, st.pos.y); else await page.mouse.click(st.pos.x, st.pos.y);
}

export async function start(page, { mobile } = {}) {
  await page.click('.mode-btn[data-mode="practice"]');
  await shown(page, 'setup');
  await page.click('#btn-setup-start');
  await page.waitForFunction(() => window.__colorhaven.session && window.__colorhaven.session.state.status === 'active', null, { timeout: 15000 });
  let open = true;
  page.once('close', () => { open = false; });
  (async () => {
    while (open) {
      try { await step(page, mobile); await page.waitForTimeout(250); } catch (e) { if (!open) return; if (process.env.BENCH_DEBUG) console.error(e.message); }
    }
  })();
  await page.waitForTimeout(1500);
}
