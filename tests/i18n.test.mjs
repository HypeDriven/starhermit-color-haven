// Localization coverage: every English key the engine client (native/*.ts)
// and the content show is translated in every locale (en-GB → en-US,
// es-ES → es-419, fr-CA → fr-FR inherit), placeholders and markup survive,
// no table keeps a key nothing shows, and the classic js/i18n.js switches
// locale as native/i18n.ts drives it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { loadTables, codeKeys, audit, bootI18n } from './i18n-common.mjs';
import { TIERS, ACHIEVEMENTS, buildPalette, journeyStages, tutorialLessons } from '../js/content.js';

const ROOT = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8');

export function usedKeys() {
  const keys = new Set();
  for (const f of readdirSync(new URL('native/', ROOT)).filter((n) => n.endsWith('.ts'))) {
    codeKeys(read('native/' + f), ['tr']).forEach((k) => keys.add(k));
  }
  // Caption texts (native/audio.ts CAPTIONS, shown with tr()).
  const audio = read('native/audio.ts');
  const caps = audio.slice(audio.indexOf('const CAPTIONS'), audio.indexOf('};', audio.indexOf('const CAPTIONS')));
  for (const m of caps.matchAll(/:\s*"([^"]+)"/g)) keys.add(m[1]);
  for (const t of TIERS) keys.add(t.label);
  for (const a of ACHIEVEMENTS) { keys.add(a.name); keys.add(a.desc); }
  for (const p of [...buildPalette(8, false), ...buildPalette(8, true)]) keys.add(p.name);
  for (const st of journeyStages()) keys.add(st.title);
  for (const l of tutorialLessons()) { keys.add(l.title); for (const s of l.steps) keys.add(s.text); }
  ['Practice piece'].forEach((k) => keys.add(k));
  return [...keys].filter((k) => /[A-Za-z]/.test(k) && k !== 'Color Haven').sort();
}

test('every used key is translated in every locale; placeholders intact', () => {
  assert.deepEqual(audit(loadTables(ROOT, 'js/strings.js', 'HV_STRINGS'), usedKeys()), []);
});

test('the locale switches as the engine client sets it, with the regional tables', () => {
  const { I18N } = bootI18n(ROOT, { strings: 'js/strings.js', i18n: 'js/i18n.js', global: 'HVI18N' });
  assert.equal(I18N.lang, 'en-US');
  assert.equal(I18N.setLocale('de-DE'), 'de-DE');
  assert.equal(I18N.T('Resume'), 'Fortsetzen');
  I18N.setLocale('fr-CA');
  assert.equal(I18N.T('Score preview'), 'Aperçu du pointage');
  I18N.setLocale('en-GB');
  assert.equal(I18N.T('Resume'), 'Resume');
  assert.equal(I18N.setLocale('xx-YY'), 'en-US');
  assert.equal(I18N.T('Moves left: {n}', { n: 3 }), 'Moves left: 3');
});
