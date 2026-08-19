/**
 * Color Haven — content module.
 * Versioned, seeded, DOM-free level generation and validation.
 * Runs in the browser and in Node (server.js validation, tests).
 */

import { hashString, rngFromSeed } from './rules.js';

export const CONTENT_VERSION = 3;

/* ------------------------------------------------------------------ */
/* Themes (five visual themes; environment only, never rules)          */
/* ------------------------------------------------------------------ */

export const THEMES = [
  { id: 'daybreak', name: 'Daybreak', bg: 0xf6ead8, table: 0xe8d9c0, frame: 0xb98d5e, paper: 0xfdf8ef, light: 0xfff1d6, accent: 0xd96f4e },
  { id: 'meadow',   name: 'Meadow',   bg: 0xe4ecd8, table: 0xd2dfc0, frame: 0x7d9a5c, paper: 0xfbf9ee, light: 0xf4ffe0, accent: 0x5c8a4d },
  { id: 'harbor',   name: 'Harbor',   bg: 0xdde8ee, table: 0xc9d8e2, frame: 0x5d7f95, paper: 0xf8fbfb, light: 0xe0f2ff, accent: 0x3e6e8e },
  { id: 'dusk',     name: 'Dusk',     bg: 0xe6dcea, table: 0xd5c8dd, frame: 0x7a5f8e, paper: 0xfbf6fb, light: 0xffe4f0, accent: 0x8e5aa8 },
  { id: 'ember',    name: 'Ember',    bg: 0xf0ddd2, table: 0xe2c9b8, frame: 0x9e5f46, paper: 0xfdf5ec, light: 0xffdcb8, accent: 0xc2522e },
];

/* ------------------------------------------------------------------ */
/* Palettes: standard and color-vision-safe (Okabe–Ito inspired).      */
/* Each entry: base name + hex. Symbols come from symbolFor().         */
/* ------------------------------------------------------------------ */

const PALETTE_STD = [
  { name: 'Coral',   hex: 0xe0604e },
  { name: 'Amber',   hex: 0xe8a33d },
  { name: 'Leaf',    hex: 0x5f9e52 },
  { name: 'Sky',     hex: 0x5d9fd6 },
  { name: 'Violet',  hex: 0x8e6cc9 },
  { name: 'Rose',    hex: 0xd96f9e },
  { name: 'Teal',    hex: 0x3fa39a },
  { name: 'Cocoa',   hex: 0x8a6247 },
];

const PALETTE_CVD = [
  { name: 'Orange',  hex: 0xe69f00 },
  { name: 'SkyBlue', hex: 0x56b4e9 },
  { name: 'Green',   hex: 0x009e73 },
  { name: 'Yellow',  hex: 0xf0e442 },
  { name: 'Blue',    hex: 0x0072b2 },
  { name: 'Vermil.', hex: 0xd55e00 },
  { name: 'Purple',  hex: 0xcc79a7 },
  { name: 'Charcl.', hex: 0x4d4d4d },
];

/** Region-number symbols reinforce color (accessibility pillar). */
const SYMBOLS = ['●', '▲', '■', '◆', '★', '✚', '◐', '⬡'];
export function symbolFor(n) { return SYMBOLS[n % SYMBOLS.length]; }

export function buildPalette(size, cvdSafe) {
  const src = cvdSafe ? PALETTE_CVD : PALETTE_STD;
  const out = [];
  for (let i = 0; i < size; i++) {
    out.push({ i, hex: src[i].hex, name: src[i].name, symbol: symbolFor(i) });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Difficulty tiers                                                    */
/* ------------------------------------------------------------------ */

export const TIERS = [
  { tier: 1, label: 'Sprout',  size: 8,  colors: 3, timePerCellMs: 1600 },
  { tier: 2, label: 'Bloom',   size: 12, colors: 4, timePerCellMs: 1400 },
  { tier: 3, label: 'Thicket', size: 16, colors: 5, timePerCellMs: 1200 },
  { tier: 4, label: 'Canopy',  size: 18, colors: 6, timePerCellMs: 1100 },
  { tier: 5, label: 'Elder',   size: 22, colors: 8, timePerCellMs: 1000 },
];

export function tierSpec(tier) {
  return TIERS[Math.max(1, Math.min(TIERS.length, tier)) - 1];
}

/* ------------------------------------------------------------------ */
/* Illustration generators — original procedural paper-art scenes.     */
/* Each fills a w*h grid with palette indices. Deterministic per seed. */
/* ------------------------------------------------------------------ */

function genBands(rng, w, h, p) {
  // Horizontal wavy stripes (sky layers / field rows).
  const t = new Array(w * h);
  const amp = rng() * 1.5 + 0.3, freq = rng() * 0.35 + 0.12, ph = rng() * 6.28;
  const bands = p;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const wave = Math.sin(x * freq + ph) * amp;
      const v = (y + wave) / h;
      t[y * w + x] = Math.min(bands - 1, Math.max(0, Math.floor(v * bands)));
    }
  }
  return t;
}

function genSunrise(rng, w, h, p) {
  // Sky bands + sun disc + hills.
  const t = new Array(w * h);
  const cx = w * (0.3 + rng() * 0.4), cy = h * (0.22 + rng() * 0.15);
  const r = Math.min(w, h) * (0.16 + rng() * 0.08);
  const hillY = h * (0.55 + rng() * 0.1);
  const hillAmp = 1 + rng() * 2, hillFreq = 0.2 + rng() * 0.25, ph = rng() * 6.28;
  const skyColors = Math.max(1, p - 3);
  const sunIdx = Math.min(p - 1, skyColors);           // sun uses next color
  const hillA = Math.min(p - 1, skyColors + 1), hillB = Math.min(p - 1, skyColors + 2);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = Math.hypot(x - cx, y - cy);
      const edge = hillY + Math.sin(x * hillFreq + ph) * hillAmp;
      let v;
      if (d < r) v = sunIdx;
      else if (y >= edge + hillAmp * 0.8) v = hillB;
      else if (y >= edge) v = hillA;
      else v = Math.min(skyColors - 1, Math.floor((y / hillY) * skyColors));
      t[y * w + x] = v;
    }
  }
  return t;
}

function genBloom(rng, w, h, p) {
  // Scattered flowers (discs with centers) over a leafy background.
  const t = new Array(w * h).fill(0);
  const flowers = Math.max(2, Math.floor(p / 2));
  for (let f = 0; f < flowers; f++) {
    const petal = 1 + (f % Math.max(1, p - 2));
    const cx = 2 + rng() * (w - 4), cy = 2 + rng() * (h - 4);
    const r = 1.6 + rng() * Math.min(w, h) * 0.14;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const d = Math.hypot(x - cx, y - cy);
        if (d < r * 0.35) t[y * w + x] = p - 1;         // center
        else if (d < r) t[y * w + x] = petal;           // petals
      }
    }
  }
  return t;
}

function genDiamond(rng, w, h, p) {
  // Concentric diamonds (mandala-like paper layers).
  const t = new Array(w * h);
  const cx = (w - 1) / 2, cy = (h - 1) / 2;
  const maxD = cx + cy;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = (Math.abs(x - cx) + Math.abs(y - cy)) / maxD;
      t[y * w + x] = Math.min(p - 1, Math.floor(d * p));
    }
  }
  return t;
}

function genWaves(rng, w, h, p) {
  // Ocean waves: layered sine ridges.
  const t = new Array(w * h);
  const ridges = p;
  const ph = [rng() * 6.28, rng() * 6.28];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = (y + Math.sin(x * 0.5 + ph[0]) * 0.8 + Math.sin(x * 0.23 + ph[1]) * 1.2) / h;
      t[y * w + x] = Math.min(ridges - 1, Math.max(0, Math.floor(v * ridges)));
    }
  }
  return t;
}

const GENERATORS = [
  { id: 'bands',   fn: genBands,   title: 'Layered Fields' },
  { id: 'sunrise', fn: genSunrise, title: 'Quiet Sunrise' },
  { id: 'bloom',   fn: genBloom,   title: 'Paper Garden' },
  { id: 'diamond', fn: genDiamond, title: 'Folded Mandala' },
  { id: 'waves',   fn: genWaves,   title: 'Harbor Swell' },
];

/* ------------------------------------------------------------------ */
/* Level assembly                                                      */
/* ------------------------------------------------------------------ */

/**
 * Deterministically build a level.
 * @param spec { id, seed, tier, theme?, mechanics?, title?, genId? }
 */
export function generateLevel(spec) {
  const t = tierSpec(spec.tier);
  const rng = rngFromSeed('level:' + spec.seed);
  const gen = spec.genId
    ? GENERATORS.find(g => g.id === spec.genId)
    : GENERATORS[rng.int(0, GENERATORS.length - 1)];
  const w = t.size, h = t.size, p = t.colors;
  let targets = gen.fn(rng, w, h, p);
  targets = repairTargets(targets, w, h, p, rng);
  const theme = spec.theme || THEMES[rng.int(0, THEMES.length - 1)].id;
  const cells = w * h;
  return {
    v: CONTENT_VERSION,
    id: spec.id,
    seed: String(spec.seed),
    title: spec.title || gen.title,
    w, h,
    targets,
    paletteSize: p,
    theme,
    tier: t.tier,
    tierLabel: t.label,
    genId: gen.id,
    par: { moves: cells, timeMs: cells * t.timePerCellMs },
    mechanics: Object.assign({ hints: true, undo: true, moveLimit: null, timeTargetMs: null }, spec.mechanics || {}),
  };
}

/** Guarantee every palette index is used (reachability of goals). */
function repairTargets(targets, w, h, p, rng) {
  const used = new Set(targets);
  for (let c = 0; c < p; c++) {
    if (!used.has(c)) {
      // Paint a small deterministic blob of the missing color.
      const x = rng.int(0, w - 2), y = rng.int(0, h - 2);
      targets[y * w + x] = c;
      targets[y * w + x + 1] = c;
      targets[(y + 1) * w + x] = c;
    }
  }
  return targets;
}

/** Palette instance for a level, honoring the CVD-safe option. */
export function paletteFor(level, cvdSafe) {
  return buildPalette(level.paletteSize, !!cvdSafe);
}

/* ------------------------------------------------------------------ */
/* Validation (offline legality / reachability / bounds proof)         */
/* ------------------------------------------------------------------ */

export function validateLevel(level) {
  const issues = [];
  if (!level.id) issues.push('missing id');
  if (level.v !== CONTENT_VERSION) issues.push('content version mismatch');
  const n = level.w * level.h;
  if (level.w < 4 || level.h < 4 || n > 1024) issues.push('bad dimensions ' + level.w + 'x' + level.h);
  if (!Array.isArray(level.targets) || level.targets.length !== n) issues.push('targets length mismatch');
  else {
    const used = new Set();
    for (const t of level.targets) {
      if (!Number.isInteger(t) || t < 0 || t >= level.paletteSize) issues.push('target out of palette range');
      used.add(t);
    }
    for (let c = 0; c < level.paletteSize; c++) {
      if (!used.has(c)) issues.push('palette color ' + c + ' unused (unreachable goal)');
    }
  }
  if (!level.par || level.par.timeMs < n * 100) issues.push('par time implausible');
  if (!THEMES.some(t => t.id === level.theme)) issues.push('unknown theme ' + level.theme);
  return { ok: issues.length === 0, issues };
}

/* ------------------------------------------------------------------ */
/* Journey: 40 authored progression descriptors.                       */
/* One concept at a time, combine, then mastery every 8th stage.       */
/* ------------------------------------------------------------------ */

const JOURNEY_TITLES = [
  'First Strokes', 'Wide Meadow', 'Third Color', 'Gentle Slopes',
  'Harbor Lines', 'Evening Fold', 'Fourth Color', 'Mastery: Dawn',
  'Denser Weave', 'River Bend', 'Petal Study', 'Fifth Color',
  'Long Horizon', 'Crystal Fold', 'Careful Hands', 'Mastery: Garden',
  'Tide Charts', 'Sixth Color', 'Paper Valley', 'Steady Rhythm',
  'Deep Thicket', 'Night Bloom', 'No Safety Net', 'Mastery: Tide',
  'Grand Vista', 'Ember Rows', 'Seventh Color', 'Measured Steps',
  'Silent Canopy', 'Twilight Swell', 'Strict Ledger', 'Mastery: Dusk',
  'Elder Sunrise', 'Full Spectrum', 'Paper Summit', 'Perfect Patience',
  'Wide Expanse', 'Final Fold', "Artist's Trial", 'Mastery: Haven',
];

export function journeyStages() {
  const stages = [];
  for (let i = 0; i < 40; i++) {
    const n = i + 1;
    const tier = Math.min(5, 1 + Math.floor(i / 8));
    const mastery = n % 8 === 0;
    const mech = { hints: true, undo: true, moveLimit: null, timeTargetMs: null };
    if (n === 15 || n === 21 || n === 28 || n === 36) {
      // Move-limit lessons: fills+invalids capped near par.
      mech.moveLimit = Math.ceil(tierSpec(tier).size ** 2 * 1.15);
    }
    if (n >= 23) mech.hints = false;
    if (n >= 31) mech.undo = false;
    if (mastery) { mech.moveLimit = Math.ceil(tierSpec(tier).size ** 2 * 1.1); mech.hints = false; }
    stages.push({
      id: 'journey-' + n,
      n,
      seed: 'journey/' + n,
      tier,
      title: JOURNEY_TITLES[i],
      mastery,
      mechanics: mech,
    });
  }
  return stages;
}

export function journeyLevel(stage) {
  return generateLevel({
    id: stage.id, seed: stage.seed, tier: stage.tier,
    title: stage.title, mechanics: stage.mechanics,
  });
}

/* ------------------------------------------------------------------ */
/* Daily challenge: one shared seed + ruleset per UTC day.             */
/* ------------------------------------------------------------------ */

export function dailyInfo(dateUtc) {
  const d = dateUtc ? new Date(dateUtc) : new Date();
  const iso = d.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  const tier = 2 + (hashString('daily:' + iso) % 4); // tiers 2..5
  return {
    id: 'daily-' + iso,
    date: iso,
    seed: 'daily/' + iso,
    tier,
    mechanics: { hints: true, undo: true, moveLimit: Math.ceil(tierSpec(tier).size ** 2 * 1.2), timeTargetMs: null },
  };
}

export function dailyLevel(dateUtc) {
  const info = dailyInfo(dateUtc);
  return generateLevel({
    id: info.id, seed: info.seed, tier: info.tier,
    title: 'Daily — ' + info.date, mechanics: info.mechanics,
  });
}

/* ------------------------------------------------------------------ */
/* Tutorial (Learn mode): fixed micro-levels, one rule per lesson.     */
/* ------------------------------------------------------------------ */

export function tutorialLessons() {
  return [
    {
      id: 'learn-1', title: 'Choosing a color',
      level: generateLevel({ id: 'learn-1', seed: 'tutorial/1', tier: 1, title: 'Choosing a color', genId: 'bands' }),
      steps: [
        { text: 'Each region has a number. Pick color 1 in the palette below.', require: { type: 'select', color: 0 } },
        { text: 'Now tap a region marked "1" to fill it.', require: { type: 'fill', color: 0 } },
        { text: 'Fill every remaining "1" region.', require: { type: 'fill', color: 0, count: 'all' } },
        { text: 'Well done! That is the whole loop: pick, match, fill.', require: null },
      ],
    },
    {
      id: 'learn-2', title: 'Numbers and mistakes',
      level: generateLevel({ id: 'learn-2', seed: 'tutorial/2', tier: 1, title: 'Numbers and mistakes', genId: 'sunrise' }),
      steps: [
        { text: 'Colors have numbers and symbols. Select color 2.', require: { type: 'select', color: 1 } },
        { text: 'Regions only accept their own number. Try filling a "1" region while 2 is selected — nothing breaks, it just explains the refusal.', require: { type: 'invalid' }, optional: true },
        { text: 'Fill two regions marked "2".', require: { type: 'fill', color: 1, count: 2 } },
        { text: 'Made a slip? The Undo button (or U key) lifts the last fill.', require: null },
      ],
    },
    {
      id: 'learn-3', title: 'Finishing a piece',
      level: generateLevel({ id: 'learn-3', seed: 'tutorial/3', tier: 1, title: 'Finishing a piece', genId: 'bloom' }),
      steps: [
        { text: 'The progress bar shows how much is done. Finish this small piece any way you like.', require: { type: 'complete' } },
        { text: 'A finished piece! Scores reward accuracy and a steady pace — hints cost a little.', require: null },
      ],
    },
  ];
}

/* ------------------------------------------------------------------ */
/* Achievements (static set, stable lowercase keys, idempotent)        */
/* ------------------------------------------------------------------ */

export const ACHIEVEMENTS = [
  { key: 'first_completion', name: 'First Haven', desc: 'Complete your first illustration.' },
  { key: 'mechanic_mastery', name: 'Clean Hands', desc: 'Complete a stage with no invalid fills, hints, or undos.' },
  { key: 'daily_streak_3',   name: 'Three Dawns', desc: 'Finish the daily challenge on three different days.' },
  { key: 'elder_complete',   name: 'Elder Artist', desc: 'Complete an Elder (tier 5) illustration.' },
  { key: 'journey_25',       name: 'Long Road',   desc: 'Complete 25 journey stages.' },
];
