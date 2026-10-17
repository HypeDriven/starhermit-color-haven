/**
 * Color Haven — graphics quality model tests (node --test).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import '../js/gpu-level.js'; // globalThis.StarHermitGpu, as the page's classic script
import * as G from '../js/gfx.js';
import {
  PRESETS, CATEGORIES, resolve, presetTier, choosePreset, describe, pixelRatio,
} from '../js/gfx.js';
import { GFX_LOCALES, gfxStrings, pickLocale } from '../js/gfx-ui.js';

const DESK = { webgl: true, webgl2: true, cores: 8, memoryGb: 8 };
const PHONE = { webgl: true, webgl2: true, mobile: true, cores: 8, memoryGb: 8 };

test('hardware level → preset: Low 0, Balanced 4, High 10, Ultra 17', () => {
  assert.equal(G.detectPreset('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)', DESK), 'low');
  assert.equal(G.detectLevel('llvmpipe (LLVM 15.0.7, 256 bits)', DESK), 0);
  assert.equal(G.detectPreset('ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0)', DESK), 'low');
  assert.equal(G.detectPreset('ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11)', DESK), 'low');
  assert.equal(G.detectPreset('ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11)', DESK), 'balanced');
  assert.equal(G.detectPreset('ANGLE (NVIDIA, NVIDIA GeForce GTX 1070 Direct3D11 vs_5_0 ps_5_0)', DESK), 'high');
  assert.equal(G.detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 4080 Direct3D11 vs_5_0 ps_5_0)', DESK), 'ultra');
  assert.equal(G.detectLevel('ANGLE (NVIDIA, NVIDIA GeForce RTX 5090 Direct3D11 vs_5_0 ps_5_0)', DESK), 20);
  assert.equal(G.detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 5090 Direct3D11 vs_5_0 ps_5_0)', DESK), 'ultra');
  assert.equal(G.presetForLevel(3), 'low');
  assert.equal(G.presetForLevel(16), 'high');
});

test('phones and tablets are capped at Balanced; software GPUs stay Low', () => {
  assert.equal(G.detectPreset('Adreno (TM) 740', PHONE), 'balanced');
  assert.ok(G.detectLevel('Adreno (TM) 740', PHONE) <= 9);
  assert.equal(G.detectPreset('NVIDIA GeForce RTX 5090', PHONE), 'balanced');
  assert.equal(G.detectPreset('SwiftShader', PHONE), 'low');
});

test('every preset has an explicit budget that grows from Low to Ultra and scales with the level', () => {
  const order = ['low', 'balanced', 'high', 'ultra'];
  for (const p of order) for (const k of ['material', 'paperTexture', 'linenTexture', 'woodTexture', 'bevel', 'overlayCell', 'particles', 'motes', 'aoRes']) assert.ok(G.BUDGETS[p][k] != null, `${p}.${k}`);
  for (let i = 1; i < order.length; i++) {
    for (const k of ['paperTexture', 'linenTexture', 'woodTexture', 'bevel', 'overlayCell', 'particles', 'motes', 'aoRes']) assert.ok(G.BUDGETS[order[i]][k] >= G.BUDGETS[order[i - 1]][k], `${order[i]}.${k}`);
  }
  assert.equal(G.BUDGETS.low.material, 'lambert');
  assert.deepEqual(G.resolve({ preset: 'ultra' }, 'low', 0).budget, G.resolve({ preset: 'ultra' }, 'ultra', 17).budget,
    'a manual Ultra on a weak GPU keeps the Ultra floor budget');
  const b4 = G.resolve({ preset: 'balanced' }, 'balanced', 4).budget, b9 = G.resolve({ preset: 'balanced' }, 'balanced', 9).budget;
  assert.ok(b9.motes > b4.motes, 'counts scale up within the preset');
  assert.equal(G.resolve({ preset: 'ultra', particles: 'low' }, 'ultra', 20).budget.particles, G.PARTICLE_CAP.low, 'Particles tier caps');
  assert.equal(G.resolve({ preset: 'low' }, 'low', 0).budget.particles, 0, 'Low: Particles off');
  assert.equal(G.resolve({ preset: 'balanced' }, 'balanced').scale, 0.9, 'Balanced renders at 0.9');
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
  assert.equal(pixelRatio(resolve({ preset: 'balanced' }), 3), 1.35, 'Balanced: cap 1.5 × preset scale 0.9');
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
