/**
 * Color Haven — audio module.
 * Event one-shots prefer authored samples in sfx/ (see sfx/manifest.json),
 * lazily fetched and decoded after the user-gesture unlock; the original
 * WebAudio synthesis below remains as the loading/failure fallback.
 * Buses: music / effects / ambience / voice, independent gains.
 * Focus/background policy: everything ducks when the tab is hidden.
 */

const PAINT_FILL_SAMPLES = Object.freeze([
  'paint-fill-1', 'paint-fill-2', 'paint-fill-3', 'paint-fill-4',
]);

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.buses = {};
    this.volumes = { music: 0.6, effects: 0.8, ambience: 0.4, voice: 0.8 };
    this.enabled = true;
    this._musicTimer = null;
    this._musicIntensity = 0;
    this._ambNodes = null;
    this._captionsCb = null; // accessibility: text cues for meaningful audio
    this._sfx = new Map();   // name -> { status: 'loading'|'ready'|'failed', buffer }
  }

  /** Must be called from a user gesture. Idempotent. */
  unlock() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { this.enabled = false; return; }
    this.ctx = new AC();
    const master = this.ctx.createGain();
    master.gain.value = 1;
    master.connect(this.ctx.destination);
    this.master = master;
    for (const bus of ['music', 'effects', 'ambience', 'voice']) {
      const g = this.ctx.createGain();
      g.gain.value = this.enabled ? this.volumes[bus] : 0;
      g.connect(master);
      this.buses[bus] = g;
    }
  }

  onCaption(fn) { this._captionsCb = fn; }
  _caption(text) { if (this._captionsCb) this._captionsCb(text); }

  setVolume(bus, v) {
    this.volumes[bus] = v;
    if (this.buses[bus]) this.buses[bus].gain.value = this.enabled ? v : 0;
  }

  setEnabled(on) {
    this.enabled = on;
    for (const bus of Object.keys(this.buses)) {
      this.buses[bus].gain.value = on ? this.volumes[bus] : 0;
    }
  }

  duck(ducked) {
    if (!this.master) return;
    this.master.gain.linearRampToValueAtTime(ducked ? 0 : 1, this.ctx.currentTime + 0.2);
  }

  /* ------------------------- synth helpers ------------------------- */

  _blip({ freq = 440, dur = 0.08, type = 'sine', gain = 0.25, bus = 'effects', slide = 0 }) {
    if (!this.ctx || !this.enabled) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(40, freq + slide), t + dur);
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g); g.connect(this.buses[bus]);
    o.start(t); o.stop(t + dur + 0.02);
  }

  _noise({ dur = 0.12, gain = 0.2, bus = 'effects', lowpass = 2000 }) {
    if (!this.ctx || !this.enabled) return;
    const t = this.ctx.currentTime;
    const len = Math.max(1, Math.floor(this.ctx.sampleRate * dur));
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = lowpass;
    const g = this.ctx.createGain();
    g.gain.value = gain;
    src.connect(f); f.connect(g); g.connect(this.buses[bus]);
    src.start(t);
  }

  /* ------------------------- sample SFX ------------------------- */
  /* Authored one-shots (sfx/<name>.opus) mapped to the events below.
     Clips are fetched and decoded lazily on first use, after unlock(). */

  _sfxRecord(name) {
    let rec = this._sfx.get(name);
    if (rec) return rec;
    rec = { status: 'loading', buffer: null, promise: null };
    this._sfx.set(name, rec);
    rec.promise = fetch(`sfx/${name}.opus`)
      .then((r) => { if (!r.ok) throw new Error(`http ${r.status}`); return r.arrayBuffer(); })
      .then((ab) => this.ctx.decodeAudioData(ab))
      .then((buf) => { rec.buffer = buf; rec.status = 'ready'; return rec; })
      .catch(() => { rec.status = 'failed'; return rec; });
    return rec;
  }

  /**
   * Play the authored clip for an event through the effects bus.
   * Returns true when a decoded sample actually started; false means the
   * caller should run its synthesized fallback (still loading or failed).
   */
  _trySample(name) {
    if (!this.ctx || !this.enabled) return false;
    const rec = this._sfxRecord(name);
    if (rec.status !== 'ready') return false;
    const src = this.ctx.createBufferSource();
    src.buffer = rec.buffer;
    src.connect(this.buses.effects);
    src.start();
    return true;
  }

  /* ------------------------- event mapping ------------------------- */
  /* Event hierarchy: acknowledgment < legal move < goal < completion. */

  uiTick() {
    if (this._trySample('ui-tick')) return;
    this._blip({ freq: 660, dur: 0.04, gain: 0.08 });
  }
  select() {
    if (this._trySample('palette-select')) return;
    this._blip({ freq: 520, dur: 0.06, type: 'triangle', gain: 0.15 });
  }
  fill() {
    this._caption('region filled');
    const sample = PAINT_FILL_SAMPLES[Math.floor(Math.random() * PAINT_FILL_SAMPLES.length)];
    if (this._trySample(sample)) return;
    this._blip({ freq: 300, dur: 0.09, type: 'triangle', gain: 0.22, slide: 140 });
    this._noise({ dur: 0.07, gain: 0.12, lowpass: 3200 }); // pigment drag
  }
  undo() {
    if (this._trySample('paper-undo')) return;
    this._blip({ freq: 420, dur: 0.07, type: 'triangle', gain: 0.14, slide: -120 });
  }
  hint() {
    this._caption('hint used');
    if (this._trySample('hint-chime')) return;
    this._blip({ freq: 740, dur: 0.12, type: 'sine', gain: 0.14, slide: 180 });
  }
  invalid() {
    this._caption('that region needs a different number');
    if (this._trySample('invalid-thud')) return;
    this._blip({ freq: 160, dur: 0.12, type: 'square', gain: 0.10 });
  }
  complete() {
    this._caption('illustration complete');
    if (this._trySample('level-complete')) return;
    if (!this.ctx || !this.enabled) return;
    const notes = [392, 494, 587, 784]; // G major lift
    notes.forEach((f, i) => setTimeout(() => this._blip({ freq: f, dur: 0.35, type: 'triangle', gain: 0.18 }), i * 90));
  }
  movesExhausted() {
    this._caption('out of moves');
    if (this._trySample('moves-exhausted')) return;
    this._blip({ freq: 220, dur: 0.3, type: 'sine', gain: 0.14, slide: -80 });
  }
  achievement() {
    this._caption('achievement unlocked');
    if (this._trySample('achievement-chime')) return;
    [880, 1108].forEach((f, i) => setTimeout(() => this._blip({ freq: f, dur: 0.2, gain: 0.14 }), i * 110));
  }
  /** A new board is laid out on the table (round start / restart / resume). */
  roundStart() {
    if (this._trySample('board-unfold')) return;
    this._noise({ dur: 0.22, gain: 0.10, lowpass: 1800 }); // paper smoothed flat
  }
  /** The last region of one palette colour was filled (tray button turns "done"). */
  colorComplete() {
    this._caption('color complete');
    if (this._trySample('color-complete')) return;
    [523, 659].forEach((f, i) => setTimeout(() => this._blip({ freq: f, dur: 0.12, type: 'triangle', gain: 0.13 }), i * 70));
  }
  /** The Learn-mode coach banner advanced to its next step. */
  tutorialStep() {
    if (this._trySample('tutorial-page')) return;
    this._noise({ dur: 0.10, gain: 0.06, lowpass: 2600 }); // page turn
  }

  /* ------------------------- ambience + music ------------------------- */

  startAmbience() {
    if (!this.ctx || this._ambNodes) return;
    // Authored studio room tone (sfx/ambience-studio.opus) loops on the
    // ambience bus; the synthesized noise bed below covers loading/failure
    // and is swapped out once the clip is decoded.
    const rec = this._sfxRecord('ambience-studio');
    if (rec.status === 'ready') { this._startAmbienceLoop(rec.buffer); return; }
    if (rec.status === 'loading' && rec.promise) {
      rec.promise.then((r) => {
        if (r.status === 'ready' && this._ambNodes && this._ambNodes.synth) {
          this.stopAmbience();
          this._startAmbienceLoop(r.buffer);
        }
      });
    }
    // Quiet filtered-noise room tone.
    const len = this.ctx.sampleRate * 2;
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = this.ctx.createBufferSource();
    src.buffer = buf; src.loop = true;
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = 320;
    const g = this.ctx.createGain(); g.gain.value = 0.35;
    src.connect(f); f.connect(g); g.connect(this.buses.ambience);
    src.start();
    this._ambNodes = { src, g, synth: true };
  }

  _startAmbienceLoop(buffer) {
    if (!this.ctx || this._ambNodes) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buffer; src.loop = true;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, this.ctx.currentTime);
    g.gain.linearRampToValueAtTime(0.8, this.ctx.currentTime + 1.2);
    src.connect(g); g.connect(this.buses.ambience);
    src.start();
    this._ambNodes = { src, g, synth: false };
  }

  stopAmbience() {
    if (this._ambNodes) { try { this._ambNodes.src.stop(); } catch { /* noop */ } this._ambNodes = null; }
  }

  /** Adaptive music: a slow pentatonic pad; intensity adds voices. */
  startMusic() {
    if (!this.ctx || this._musicTimer) return;
    const scale = [261.6, 293.7, 329.6, 392.0, 440.0, 523.2];
    let step = 0;
    const tick = () => {
      if (!this.enabled) return;
      const voices = 1 + Math.floor(this._musicIntensity * 2.99); // 1..3
      for (let v = 0; v < voices; v++) {
        const f = scale[(step * 2 + v * 2) % scale.length] * (v === 2 ? 2 : 1);
        this._blip({ freq: f, dur: 1.6, type: 'sine', gain: 0.05, bus: 'music' });
      }
      step++;
    };
    tick();
    this._musicTimer = setInterval(tick, 2400);
  }

  stopMusic() {
    if (this._musicTimer) { clearInterval(this._musicTimer); this._musicTimer = null; }
  }

  setMusicIntensity(x) { this._musicIntensity = Math.max(0, Math.min(1, x)); }

  suspendAll() { this.duck(true); }
  resumeAll() { this.duck(false); }
}
