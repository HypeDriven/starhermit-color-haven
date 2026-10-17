/**
 * Color Haven — graphics quality model (pure; no three.js, no DOM).
 * Presets, per-category overrides, GPU detection and a cost summary, shared by
 * the renderer (render.js) and the Settings → Graphics panel (gfx-ui.js).
 * Saved shape (settings.gfx): { preset: 'auto'|preset, render_scale, adaptive,
 * show_fps, <category>: tier } — a missing/unknown category means "from preset".
 */

export const PRESETS = ['low', 'balanced', 'high', 'ultra'];

// Category → allowed tiers, cheapest first. No bloom: the art direction rules out glow.
export const CATEGORIES = {
  shadows: ['off', 'low', 'medium', 'high'],
  ao: ['off', 'on', 'high'],
  grade: ['off', 'on'],
  antialias: ['off', 'fxaa', 'smaa', 'msaa'],
  lighting: ['basic', 'studio'],        // studio = image-based room lighting
  detail: ['plain', 'detailed'],        // bevelled paper tiles + paper/linen/wood grain
  particles: ['off', 'low', 'high'],    // pigment-puff pool size
  ambient: ['off', 'on'],               // dust motes, drifting sunlight, title petals
};

// Each preset: a tier per category, a render scale and a device-pixel-ratio cap.
const TABLE = {
  low:      { scale: 1,    dprCap: 1,   shadows: 'off',    ao: 'off',  grade: 'off', antialias: 'off',  lighting: 'basic',  detail: 'plain',    particles: 'off',  ambient: 'off' },
  balanced: { scale: 0.9,  dprCap: 1.5, shadows: 'low',    ao: 'off',  grade: 'on',  antialias: 'fxaa', lighting: 'studio', detail: 'detailed', particles: 'low',  ambient: 'on' },
  high:     { scale: 1,    dprCap: 2,   shadows: 'medium', ao: 'on',   grade: 'on',  antialias: 'smaa', lighting: 'studio', detail: 'detailed', particles: 'high', ambient: 'on' },
  ultra:    { scale: 1.25, dprCap: 2,   shadows: 'high',   ao: 'high', grade: 'on',  antialias: 'msaa', lighting: 'studio', detail: 'detailed', particles: 'high', ambient: 'on' },
};

export const SHADOW_MAP = { off: 0, low: 1024, medium: 2048, high: 4096 };
export const PARTICLE_POOL = { off: 0, low: 400, high: 1200 };

// Auto picks the preset from the StarHermit hardware level (0 = Galaxy S20 / Intel UHD or weaker, 20 = RTX
// 5090; js/gpu-level.js → globalThis.StarHermitGpu): Low from 0, Balanced from 4, High from 10, Ultra from 17.
// Phones, tablets and ≤ 4 GB machines are capped at level 9 (Balanced); software renderers are level 0.
export const PRESET_LEVELS = { low: 0, balanced: 4, high: 10, ultra: 17 };
const gpuApi = () => globalThis.StarHermitGpu;

/** Hardware level (0–20) for an unmasked renderer string plus StarHermitGpu.detectSystem() facts. */
export function detectLevel(gpu, system = {}) {
  const G = gpuApi();
  if (!G) return PRESET_LEVELS.balanced;
  return G.detectLevel({ ...(system || {}), gpu: String(gpu || '') });
}

/** The preset Auto starts from for a hardware level. */
export function presetForLevel(level) {
  const G = gpuApi();
  if (G) return G.presetForLevel(level, PRESET_LEVELS);
  return level >= 17 ? 'ultra' : level >= 10 ? 'high' : level >= 4 ? 'balanced' : 'low';
}

/** Best preset for a GPU (the hardware level already caps phones/tablets at Balanced). */
export function detectPreset(gpu, system = {}) {
  return presetForLevel(detectLevel(gpu, system));
}

/** Scale a count tuned at the preset's floor level up for faster GPUs (≤ 4×, never below the floor). */
function scaleCount(n, preset, level) {
  const G = gpuApi();
  const floor = PRESET_LEVELS[preset] || 0;
  return Math.round(G ? G.scaleBudget(n, Math.max(Number(level) || 0, floor), floor) : n);
}

/*
 * Per-preset asset and effect budget. Each preset is tuned to hold 60 FPS on the weakest GPU Auto gives
 * it (Low → level 0, Balanced → 4, High → 10, Ultra → 17; measured with tests/gfx-bench.mjs).
 *   material     table, frame and tiles: 'lambert' | 'standard' | 'physical' (sheen paper tiles);
 *   paperTexture / linenTexture / woodTexture  grain canvas sizes in px (detailed scene; wood is 4:1);
 *   bevel        rounded-tile and frame bevel segments (detailed scene);
 *   overlayCell  number-overlay canvas px per board cell (512–2048 total);
 *   particles    pigment-puff pool at the floor level (the Particles tier caps it: off 0, low 400);
 *   motes        ambient dust motes at the floor level;
 *   aoRes        GTAO resolution as a fraction of the frame.
 */
export const BUDGETS = {
  low: { material: 'lambert', paperTexture: 64, linenTexture: 64, woodTexture: 128, bevel: 1, overlayCell: 64, particles: 150, motes: 12, aoRes: 0.5 },
  balanced: { material: 'standard', paperTexture: 128, linenTexture: 128, woodTexture: 256, bevel: 1, overlayCell: 80, particles: 300, motes: 24, aoRes: 0.5 },
  high: { material: 'standard', paperTexture: 128, linenTexture: 128, woodTexture: 256, bevel: 2, overlayCell: 96, particles: 800, motes: 36, aoRes: 0.5 },
  ultra: { material: 'physical', paperTexture: 256, linenTexture: 256, woodTexture: 512, bevel: 3, overlayCell: 128, particles: 1200, motes: 60, aoRes: 1 },
};
export const PARTICLE_CAP = { off: 0, low: 400, high: 2400 };

/** A preset's concrete budget for a hardware level and Particles tier. */
export function budgetFor(preset, level, particles = 'high') {
  const b = { ...(BUDGETS[preset] || BUDGETS.balanced) };
  b.particles = Math.min(PARTICLE_CAP[particles] ?? PARTICLE_CAP.high, scaleCount(b.particles, preset, level));
  b.motes = Math.min(240, scaleCount(b.motes, preset, level));
  return b;
}

/** Resolve saved settings into concrete tiers (`level`: hardware level; defaults to the preset's floor). */
export function resolve(saved, detected, level) {
  const s = saved || {};
  const auto = !PRESETS.includes(s.preset);
  const preset = auto ? (PRESETS.includes(detected) ? detected : 'balanced') : s.preset;
  const row = TABLE[preset];
  const renderScale = clamp(Number(s.render_scale) || 1, 0.5, 2);
  const out = { preset, auto, renderScale, scale: row.scale * renderScale, dprCap: row.dprCap };
  for (const [cat, tiers] of Object.entries(CATEGORIES)) {
    out[cat] = tiers.includes(s[cat]) ? s[cat] : row[cat];
  }
  out.level = level == null ? PRESET_LEVELS[preset] : level;
  out.budget = budgetFor(preset, out.level, out.particles);
  out.adaptive = s.adaptive !== false;
  out.showFps = !!s.show_fps;
  // Post-processing only when something needs it; plain MSAA uses the canvas.
  out.post = out.ao !== 'off' || out.grade === 'on' || out.antialias === 'fxaa' || out.antialias === 'smaa';
  return out;
}

/** Choosing a preset clears every override (keeps scale/adaptive/fps). */
export function choosePreset(saved, preset) {
  const s = { ...(saved || {}) };
  for (const cat of Object.keys(CATEGORIES)) delete s[cat];
  s.preset = PRESETS.includes(preset) ? preset : 'auto';
  return s;
}

/** The preset's own tier for a category (for "From preset (…)" labels). */
export function presetTier(preset, cat) {
  return TABLE[preset] ? TABLE[preset][cat] : undefined;
}

/** Final device pixel ratio for a resolved setting. */
export function pixelRatio(r, dpr, adaptiveScale = 1) {
  const base = Math.min(dpr || 1, r.dprCap);
  return clamp(base * r.scale * adaptiveScale, 0.5, 3);
}

const EN = {
  noShadows: 'no shadows', shadows: '{n}² shadows', ao: 'ambient occlusion', aoHigh: 'full ambient occlusion',
  grade: 'colour grade', noAA: 'no anti-aliasing', studio: 'studio lighting', detailed: 'paper detail',
};

/** One-line cost summary; `t` is an optional localized phrase table (keys as EN). */
export function describe(r, pixels, t = EN) {
  const T = (k) => t[k] || EN[k];
  const parts = [
    r.shadows === 'off' ? T('noShadows') : T('shadows').replace('{n}', SHADOW_MAP[r.shadows]),
    r.ao === 'off' ? null : r.ao === 'high' ? T('aoHigh') : T('ao'),
    r.grade === 'on' ? T('grade') : null,
    r.lighting === 'studio' ? T('studio') : null,
    r.detail === 'detailed' ? T('detailed') : null,
    r.antialias === 'off' ? T('noAA') : r.antialias.toUpperCase(),
    pixels ? `${pixels[0]}×${pixels[1]} px` : null,
  ];
  return parts.filter(Boolean).join(' · ');
}

function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
