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
  balanced: { scale: 1,    dprCap: 1.5, shadows: 'low',    ao: 'off',  grade: 'on',  antialias: 'fxaa', lighting: 'studio', detail: 'detailed', particles: 'low',  ambient: 'on' },
  high:     { scale: 1,    dprCap: 2,   shadows: 'medium', ao: 'on',   grade: 'on',  antialias: 'smaa', lighting: 'studio', detail: 'detailed', particles: 'high', ambient: 'on' },
  ultra:    { scale: 1.25, dprCap: 2,   shadows: 'high',   ao: 'high', grade: 'on',  antialias: 'msaa', lighting: 'studio', detail: 'detailed', particles: 'high', ambient: 'on' },
};

export const SHADOW_MAP = { off: 0, low: 1024, medium: 2048, high: 4096 };
export const PARTICLE_POOL = { off: 0, low: 400, high: 1200 };

/**
 * Best preset for this GPU (WEBGL_debug_renderer_info UNMASKED_RENDERER).
 * Software renderers get low; discrete GPUs / Apple M get high; else balanced.
 * `mobile` (touch-only device) caps the result at balanced.
 */
export function detectPreset(gpu, mobile = false) {
  const g = String(gpu || '').toLowerCase();
  let p = 'balanced';
  if (/swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic/.test(g)) p = 'low';
  else if (/nvidia|geforce|rtx|gtx|quadro|radeon rx|radeon pro|amd radeon(?! graphics)|apple m\d/.test(g)) p = 'high';
  if (mobile && PRESETS.indexOf(p) > PRESETS.indexOf('balanced')) p = 'balanced';
  return p;
}

/** Resolve saved settings into concrete tiers. */
export function resolve(saved, detected) {
  const s = saved || {};
  const auto = !PRESETS.includes(s.preset);
  const preset = auto ? (PRESETS.includes(detected) ? detected : 'balanced') : s.preset;
  const row = TABLE[preset];
  const renderScale = clamp(Number(s.render_scale) || 1, 0.5, 2);
  const out = { preset, auto, renderScale, scale: row.scale * renderScale, dprCap: row.dprCap };
  for (const [cat, tiers] of Object.entries(CATEGORIES)) {
    out[cat] = tiers.includes(s[cat]) ? s[cat] : row[cat];
  }
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
