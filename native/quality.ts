// The look per graphics level. The engine-owned effects come from the frame's
// level (levelSettings()): shadows and their map size, ambient occlusion
// (resolution and samples), the grade and anti-aliasing (this game has no
// bloom). The game's own art (materials, grain textures, bevels, the overlay
// size, studio light, the detailed scene and its ambience) stays keyed by
// the quality tier (frame().quality), as the browser build's presets were
// (js/gfx.js BUDGETS, each tuned to hold 60 FPS on the weakest GPU Auto gave
// it). The pigment-puff pool and the dust motes scale with the level's
// particle budget against the tier's anchor level (quantum, molecular,
// terrestrial, galactic), at most four times the tier's budget. The game
// sets the shadow-map size itself: at engine.minor 23 and up the runtime
// keeps a light's mapSize whatever the level. The runtime owns the rest of
// what the old Graphics panel did: Auto and the level choice, render scale
// and the pixel-ratio cap, adaptive resolution, the frame-rate limit and
// readout. The per-category overrides of the old panel are not offered (the
// runtime's Options choose a level).
import { levelSettings, type GraphicsLevel, type LevelSettings, type QualityTier } from "starhermit:engine";
import type { AntialiasMode } from "starhermit:scene";

export type Preset = QualityTier;
export interface Budget {
  /** Table, frame and tiles: Lambert on Low, standard PBR above (Ultra's paper sheen is not drawn by the engine). */
  material: "lambert" | "standard" | "physical";
  /** Grain canvas sizes in px (detailed scene; wood is 4:1), at most the level's texture size. */
  paperTexture: number;
  linenTexture: number;
  woodTexture: number;
  /** Rounded-tile and frame bevel segments (detailed scene). */
  bevel: number;
  /** Number-overlay canvas px per board cell (512–2048 in all). */
  overlayCell: number;
  /** Pigment-puff pool. */
  particles: number;
  /** Ambient dust motes. */
  motes: number;
}
export interface Look {
  preset: Preset;
  /** The level's shadow-map size; 0: no shadows. */
  shadows: number;
  /** The level's ambient occlusion; null: off. */
  ao: { resolution: number; samples: number; denoiseSamples: number } | null;
  grade: boolean;
  antialias: AntialiasMode;
  /** Image-based studio light from the RoomEnvironment. */
  studio: boolean;
  /** Bevelled paper tiles and paper, linen and wood grain. */
  detailed: boolean;
  /** Dust motes, drifting sunlight and the title's petals. */
  ambient: boolean;
  budget: Budget;
}

type Art = Pick<Look, "studio" | "detailed" | "ambient">;
const ART: Record<Preset, Art> = {
  low: { studio: false, detailed: false, ambient: false },
  balanced: { studio: true, detailed: true, ambient: true },
  high: { studio: true, detailed: true, ambient: true },
  ultra: { studio: true, detailed: true, ambient: true },
};
const BUDGETS: Record<Preset, Budget> = {
  low: { material: "lambert", paperTexture: 64, linenTexture: 64, woodTexture: 128, bevel: 1, overlayCell: 64, particles: 0, motes: 12 },
  balanced: { material: "standard", paperTexture: 128, linenTexture: 128, woodTexture: 256, bevel: 1, overlayCell: 80, particles: 300, motes: 24 },
  high: { material: "standard", paperTexture: 128, linenTexture: 128, woodTexture: 256, bevel: 2, overlayCell: 96, particles: 800, motes: 36 },
  ultra: { material: "physical", paperTexture: 256, linenTexture: 256, woodTexture: 512, bevel: 3, overlayCell: 128, particles: 1200, motes: 60 },
};
/** The Particles tier's cap (js/gfx.js PARTICLE_CAP: Balanced is "low", High and Ultra "high"). */
const PARTICLE_CAP: Record<Preset, number> = { low: 0, balanced: 400, high: 2400, ultra: 2400 };
const MOTE_CAP = 240;
/** Each tier's anchor level: its budgets are tuned for it. */
const ANCHOR: Record<Preset, GraphicsLevel> = { low: "quantum", balanced: "molecular", high: "terrestrial", ultra: "galactic" };

/** The look for a graphics level (default: this frame's). */
export function lookFor(s: LevelSettings = levelSettings()): Look {
  const preset = s.quality;
  const b = BUDGETS[preset];
  // The level's particle budget doubles a level: counts grow with it above
  // the tier's anchor, at most four times the tier's budget.
  const k = Math.min(4, Math.max(1, s.particles / levelSettings(ANCHOR[preset]).particles));
  const tex = (n: number): number => Math.min(n, s.maxTextureSize);
  return {
    preset, ...ART[preset],
    shadows: s.shadows ? s.shadowMapSize : 0,
    ao: s.ao && { resolution: s.ao.resolution, samples: s.ao.samples, denoiseSamples: s.ao.denoiseSamples },
    grade: s.grade,
    antialias: s.antialias,
    budget: {
      ...b,
      paperTexture: tex(b.paperTexture), linenTexture: tex(b.linenTexture), woodTexture: tex(b.woodTexture),
      particles: Math.min(PARTICLE_CAP[preset], Math.round(b.particles * k)),
      motes: Math.min(MOTE_CAP, Math.round(b.motes * k)),
    },
  };
}
