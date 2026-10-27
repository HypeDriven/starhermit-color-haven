// Sound, as the browser build's js/audio.js: the authored one-shots
// (sfx/<name>.opus, mapped to the game's events by sfx/manifest.json; a
// fill picks one of the four paint strokes), the text cues it gave for
// meaningful sounds when "Text cues for sounds" is on, the studio room tone
// (sfx/ambience-studio.opus) looping through a round, and the slow
// pentatonic pad (a note every 2.4 s, one to three voices as the picture
// fills).
//
// The browser build's buses become the runtime's (Options › Audio owns the
// volumes, the mute and the voice limit): music → "music", effects and
// ambience → "effects", the menu tick → "interface"; the old default bus
// levels (music 60 %, effects 80 %, ambience 40 %) are folded into each
// sound's gain. The pad, which the browser build played with oscillators,
// is rendered once into clips (createClip); the synthesized stand-ins it
// played while a sample loaded are not ported. Clips load once the mixer
// runs (natively at once, in a browser after the first press), one at a
// time.
import { files } from "starhermit:engine";
import { context, createClip, loadClip, play as playClip, type AudioClip, type Bus, type Sound } from "starhermit:audio";

const LEVEL = { music: 0.6, effects: 0.8, ambience: 0.4 };
/** Caption text per event (js/audio.js _caption). */
const CAPTIONS: Record<string, string> = {
  fill: "region filled", hint: "hint used", invalid: "that region needs a different number", complete: "illustration complete",
  movesExhausted: "out of moves", achievement: "achievement unlocked", colorComplete: "color complete",
};
// The round's first sounds load first.
const FIRST = ["uiTick", "select", "fill", "roundStart", "invalid", "undo", "hint"];

const eventFiles = new Map<string, string[]>();
const clips = new Map<string, AudioClip>();
const queue: string[] = [];
let loading = false;
let wantClips = false;
function load(name: string): void { if (!queue.includes(name) && !clips.has(name)) queue.push(name); }
function pump(): void {
  if (loading || !queue.length) return;
  const name = queue.shift()!;
  loading = true;
  loadClip(`sfx/${name}.opus`).then((c) => { clips.set(name, c); loading = false; }, (e: unknown) => { console.warn(`sfx ${name}: ${String(e)}`); loading = false; });
}
/** Reads the manifest and asks for the clips; they load once the mixer runs (see update). */
export function loadSfx(): void {
  try {
    const list = files.readJson("sfx/manifest.json") as unknown as { name?: string; event?: string }[];
    for (const e of Array.isArray(list) ? list : []) {
      if (!e || typeof e.name !== "string" || typeof e.event !== "string") continue;
      const l = eventFiles.get(e.event) ?? [];
      l.push(e.name);
      eventFiles.set(e.event, l);
    }
  } catch (e) { console.warn(`sfx manifest: ${String(e)}`); }
  wantClips = true;
}

let captionFn: ((text: string) => void) | null = null;
/** fn(caption key) for each meaningful sound. */
export function onCaption(fn: (text: string) => void): void { captionFn = fn; }

/** Plays an event's sample (a random one of several); unknown or still-loading samples are silent. */
export function play(event: string): void {
  const cap = CAPTIONS[event];
  if (cap && captionFn) captionFn(cap);
  const list = eventFiles.get(event);
  if (!list || !list.length) return;
  const file = list[Math.floor(Math.random() * list.length)]!;
  const clip = clips.get(file);
  if (!clip) return;
  const bus: Bus = event === "uiTick" ? "interface" : "effects";
  try { playClip(clip, { bus, gain: LEVEL.effects }); }
  catch { clips.delete(file); load(file); } // a clip the mixer lost: load it again
}

// -- the pad ----------------------------------------------------------------------------------
const RATE = 11025;
const SCALE = [261.6, 293.7, 329.6, 392.0, 440.0, 523.2];
/** A pad note: a sine at 0.05 decaying exponentially to 0.001 over 1.6 s (js/audio.js _blip). */
function noteClip(freq: number): AudioClip {
  const dur = 1.62, n = Math.round(dur * RATE);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const g = t < 1.6 ? 0.05 * Math.pow(0.001 / 0.05, t / 1.6) : 0;
    out[i] = Math.sin(2 * Math.PI * freq * t) * g;
  }
  return createClip([out], RATE);
}
const notes = new Map<number, AudioClip>();
const NOTE_FREQS = [...SCALE, ...SCALE.map((f) => f * 2)];
/** One rendered note a frame, once the samples are in; false when all are made. */
function renderNext(): boolean {
  const f = NOTE_FREQS.find((x) => !notes.has(x));
  if (f == null) return false;
  notes.set(f, noteClip(f));
  return true;
}

// -- the round's ambience and music -------------------------------------------------------------
let inRound = false;
let intensity = 0;
let ambSound: Sound | null = null;
let ambStarted = false;
let nextNote = 0;
let step = 0;

/** The round started: the room tone fades in and the pad plays. */
export function startRound(): void { inRound = true; intensity = 0.2; nextNote = 0; step = 0; }
/** The round ended or was left: the room tone stops, the pad rests. */
export function stopRound(): void {
  inRound = false;
  if (ambSound) { try { ambSound.stop(); } catch { /* gone */ } }
  ambSound = null;
  ambStarted = false;
}
/** 0–1: the pad adds voices as the picture fills. */
export function setMusicIntensity(x: number): void { intensity = Math.max(0, Math.min(1, x)); }

/** Each frame: the samples once the mixer runs, one rendered note a frame,
 * then the room tone and the pad's notes by mixer time. */
export function update(): void {
  if (context.state !== "running") return;
  if (wantClips) {
    wantClips = false;
    for (const e of FIRST) for (const name of eventFiles.get(e) ?? []) load(name);
    for (const l of eventFiles.values()) for (const name of l) if (name !== "ambience-studio") load(name);
    load("ambience-studio");
  }
  pump();
  if (loading || queue.length) return;
  try { if (renderNext()) return; } catch (e) { console.warn(`audio: ${String(e)}`); return; }
  if (!inRound) return;
  const amb = clips.get("ambience-studio");
  if (!ambStarted && amb) {
    ambStarted = true;
    try { ambSound = playClip(amb, { bus: "effects", gain: 0.0001, loop: true }); ambSound.fade(0.8 * LEVEL.ambience, 1.2); }
    catch { ambSound = null; }
    return; // the pad starts on a frame of its own
  }
  const now = context.currentTime;
  if (now >= nextNote) {
    if (nextNote === 0 || now - nextNote > 1) nextNote = now;
    const voices = 1 + Math.floor(intensity * 2.99);
    for (let v = 0; v < voices; v++) {
      const f = SCALE[(step * 2 + v * 2) % SCALE.length]! * (v === 2 ? 2 : 1);
      const clip = notes.get(f);
      if (clip) { try { playClip(clip, { bus: "music", gain: LEVEL.music }); } catch { /* the mixer is full */ } }
    }
    step++;
    nextNote += 2.4;
  }
}
