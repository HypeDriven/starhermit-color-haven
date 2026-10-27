// The look per graphics level: the browser build's four presets and their
// budgets (js/gfx.js TABLE / BUDGETS, each tuned to hold 60 FPS on the
// weakest GPU Auto gave it) keyed by the runtime's quality tier
// (frame().quality), with the pigment-puff pool and the dust motes scaled
// within the tier by the level (frame().levelIndex), as the browser build
// scaled them by its hardware level. The runtime owns the rest of what the
// old Graphics panel did: Auto and the level choice, render scale and the
// pixel-ratio cap, adaptive resolution, the frame-rate limit and readout,
// and the shadow-map size and MSAA samples it holds to the level. The
// per-category overrides of the old panel are not offered (the runtime's
// Options choose a level).
import type { QualityTier } from "starhermit:engine";
import type { AntialiasMode } from "starhermit:scene";

export type Preset = QualityTier;
export interface Budget {
  /** Table, frame and tiles: Lambert on Low, standard PBR above (Ultra's paper sheen is not drawn by the engine). */
  material: "lambert" | "standard" | "physical";
  /** Grain canvas sizes in px (detailed scene; wood is 4:1). */
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
  aoRes: number;
}
export interface Look {
  preset: Preset;
  shadows: 0 | 1024 | 2048 | 4096;
  ao: "off" | "on" | "high";
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

const TABLE: Record<Preset, Omit<Look, "preset" | "budget">> = {
  low: { shadows: 0, ao: "off", grade: false, antialias: "off", studio: false, detailed: false, ambient: false },
  balanced: { shadows: 1024, ao: "off", grade: true, antialias: "fxaa", studio: true, detailed: true, ambient: true },
  high: { shadows: 2048, ao: "on", grade: true, antialias: "smaa", studio: true, detailed: true, ambient: true },
  ultra: { shadows: 4096, ao: "high", grade: true, antialias: "msaa", studio: true, detailed: true, ambient: true },
};
const BUDGETS: Record<Preset, Budget> = {
  low: { material: "lambert", paperTexture: 64, linenTexture: 64, woodTexture: 128, bevel: 1, overlayCell: 64, particles: 0, motes: 12, aoRes: 0.5 },
  balanced: { material: "standard", paperTexture: 128, linenTexture: 128, woodTexture: 256, bevel: 1, overlayCell: 80, particles: 300, motes: 24, aoRes: 0.5 },
  high: { material: "standard", paperTexture: 128, linenTexture: 128, woodTexture: 256, bevel: 2, overlayCell: 96, particles: 800, motes: 36, aoRes: 0.5 },
  ultra: { material: "physical", paperTexture: 256, linenTexture: 256, woodTexture: 512, bevel: 3, overlayCell: 128, particles: 1200, motes: 60, aoRes: 1 },
};
/** The Particles tier's cap (js/gfx.js PARTICLE_CAP: Balanced is "low", High and Ultra "high"). */
const PARTICLE_CAP: Record<Preset, number> = { low: 0, balanced: 400, high: 2400, ultra: 2400 };
const MOTE_CAP = 240;
/** The first level index of each tier (quantum, molecular, terrestrial, galactic). */
const TIER_FLOOR: Record<Preset, number> = { low: 0, balanced: 2, high: 4, ultra: 7 };

/** The look for a quality tier at a level index (0 quantum … 9 infinite). */
export function lookFor(preset: Preset, levelIndex: number): Look {
  const b = { ...BUDGETS[preset] };
  // Levels are about 1.64× apart in GPU throughput: counts grow with the
  // level above the tier's first, at most four times the tier's budget.
  const k = Math.min(4, Math.pow(1.64, Math.max(0, levelIndex - TIER_FLOOR[preset])));
  b.particles = Math.min(PARTICLE_CAP[preset], Math.round(b.particles * k));
  b.motes = Math.min(MOTE_CAP, Math.round(b.motes * k));
  return { preset, ...TABLE[preset], budget: b };
}
