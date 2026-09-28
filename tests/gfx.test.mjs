/**
 * Color Haven — graphics quality model tests (node --test).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PRESETS, CATEGORIES, detectPreset, resolve, presetTier, choosePreset, describe, pixelRatio,
} from '../js/gfx.js';
import { GFX_LOCALES, gfxStrings, pickLocale } from '../js/gfx-ui.js';

test('detectPreset maps GPU strings to tiers', () => {
  assert.equal(detectPreset('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)'), 'low');
  assert.equal(detectPreset('llvmpipe (LLVM 15.0.7, 256 bits)'), 'low');
  assert.equal(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0)'), 'high');
  assert.equal(detectPreset('Apple M2 Pro'), 'high');
  assert.equal(detectPreset('ANGLE (AMD, AMD Radeon RX 6700 XT)'), 'high');
  assert.equal(detectPreset('ANGLE (Intel, Intel(R) UHD Graphics 620)'), 'balanced');
  assert.equal(detectPreset('Adreno (TM) 740'), 'balanced');
  assert.equal(detectPreset(''), 'balanced');
  // Touch/mobile devices cap Auto at balanced; software stays low.
  assert.equal(detectPreset('Apple M1', true), 'balanced');
  assert.equal(detectPreset('SwiftShader', true), 'low');
});

test('resolve: auto follows detection, explicit preset wins', () => {
  const a = resolve({}, 'high');
  assert.equal(a.preset, 'high');
  assert.equal(a.auto, true);
  const b = resolve({ preset: 'low' }, 'high');
  assert.equal(b.preset, 'low');
  assert.equal(b.auto, false);
  assert.equal(resolve({ preset: 'bogus' }, undefined).preset, 'balanced');
  for (const p of PRESETS) {
    const r = resolve({ preset: p }, 'low');
    for (const cat of Object.keys(CATEGORIES)) assert.equal(r[cat], presetTier(p, cat), `${p}.${cat}`);
  }
});

test('Low preset is the cheap path: no post, no shadows, pixel ratio 1', () => {
  const r = resolve({ preset: 'low' }, 'low');
  assert.equal(r.post, false);
  assert.equal(r.shadows, 'off');
  assert.equal(r.particles, 'off');
  assert.equal(pixelRatio(r, 3), 1);
  assert.equal(pixelRatio(resolve({ preset: 'balanced' }), 3), 1.5);
  assert.equal(pixelRatio(resolve({ preset: 'high' }), 3), 2);
});

test('overrides apply per category; unknown tiers fall back to the preset', () => {
  const r = resolve({ preset: 'low', shadows: 'high', ao: 'nope', antialias: 'smaa' }, 'low');
  assert.equal(r.shadows, 'high');
  assert.equal(r.ao, 'off');
  assert.equal(r.antialias, 'smaa');
  assert.equal(r.post, true); // SMAA needs the post chain
  assert.equal(resolve({ preset: 'high', antialias: 'msaa', ao: 'off', grade: 'off' }).post, false);
});

test('render scale is clamped to 50–200% and multiplies the preset scale', () => {
  assert.equal(resolve({ preset: 'high', render_scale: 5 }).renderScale, 2);
  assert.equal(resolve({ preset: 'high', render_scale: 0.1 }).renderScale, 0.5);
  assert.equal(resolve({ preset: 'ultra', render_scale: 1 }).scale, 1.25);
  assert.equal(resolve({ preset: 'high', render_scale: 1.5 }).scale, 1.5);
  assert.equal(resolve({ preset: 'high' }).renderScale, 1);
  assert.ok(pixelRatio(resolve({ preset: 'ultra', render_scale: 2 }), 2) <= 3);
});

test('adaptive defaults on, show_fps defaults off', () => {
  assert.equal(resolve({}).adaptive, true);
  assert.equal(resolve({ adaptive: false }).adaptive, false);
  assert.equal(resolve({}).showFps, false);
  assert.equal(resolve({ show_fps: true }).showFps, true);
});

test('choosing a preset clears overrides but keeps scale/adaptive/fps', () => {
  const saved = { preset: 'low', shadows: 'high', grade: 'on', render_scale: 1.5, adaptive: false, show_fps: true };
  const next = choosePreset(saved, 'high');
  assert.equal(next.preset, 'high');
  for (const cat of Object.keys(CATEGORIES)) assert.equal(next[cat], undefined, cat);
  assert.equal(next.render_scale, 1.5);
  assert.equal(next.adaptive, false);
  assert.equal(next.show_fps, true);
  assert.equal(choosePreset(saved, 'auto').preset, 'auto');
  assert.equal(saved.shadows, 'high', 'input not mutated');
});

test('describe summarises cost with pixels', () => {
  const s = describe(resolve({ preset: 'high' }), [1280, 720]);
  assert.match(s, /2048² shadows/);
  assert.match(s, /SMAA/);
  assert.match(s, /1280×720 px/);
  assert.match(describe(resolve({ preset: 'low' })), /no shadows.*no anti-aliasing/);
});

test('every Graphics panel locale is complete', () => {
  const ref = gfxStrings('en-US');
  for (const loc of ['en-US', 'en-GB', 'es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT']) {
    assert.ok(GFX_LOCALES.includes(loc), loc);
    const S = gfxStrings(loc);
    for (const [k, v] of Object.entries(ref)) {
      if (typeof v === 'string') assert.ok(S[k], `${loc}.${k}`);
      else for (const kk of Object.keys(v)) assert.ok(S[k][kk], `${loc}.${k}.${kk}`);
    }
    for (const cat of Object.keys(CATEGORIES)) {
      assert.ok(S.cats[cat], `${loc} cat ${cat}`);
      for (const t of CATEGORIES[cat]) assert.ok(S.tiers[t], `${loc} tier ${t}`);
    }
  }
  assert.equal(pickLocale('en-AU'), 'en-GB');
  assert.equal(pickLocale('es-MX'), 'es-419');
  assert.equal(pickLocale('fr-CA'), 'fr-CA');
  assert.equal(pickLocale('pt-PT'), 'pt-BR');
  assert.equal(pickLocale('ja-JP'), 'en-US');
});
