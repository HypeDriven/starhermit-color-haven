// Localization coverage: every English key the engine client (native/*.ts)
// and the content show is translated in every locale (en-GB → en-US,
// es-ES → es-419, fr-CA → fr-FR inherit), placeholders and markup survive,
// and no table keeps a key nothing shows. Locale chains are the engine's strings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { codeKeys, audit } from './i18n-common.mjs';
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
  assert.deepEqual(audit(JSON.parse(read('assets/strings.json')), usedKeys()), []);
});

