/**
 * Color Haven — session module.
 * Owns one game session: command issuing (with ids + elapsed deltas), timing,
 * pause, snapshots, and the replay envelope. Only mutates rules state through
 * applyCommand(). Rendering/UI consume immutable snapshots.
 */

import {
  createGame, applyCommand, serialize, deserialize, hashState, score,
} from './rules.js';

export class GameSession {
  /**
   * @param level   content descriptor
   * @param opts    { mode, mechanics?, sessionId }
   */
  constructor(level, opts = {}) {
    this.level = level;
    this.mode = opts.mode || 'practice';
    this.sessionId = opts.sessionId || GameSession.newId();
    this.state = createGame(level, { mode: this.mode, mechanics: opts.mechanics });
    this.paused = false;
    this._lastStamp = null;   // monotonic ms stamp of last command
    this._cmdSeq = 0;
    this._listeners = new Set();
    this._hashTrail = [hashState(this.state)];
  }

  static newId() {
    return 's-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e9).toString(36);
  }

  onChange(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }
  _emit(events, result) {
    for (const fn of this._listeners) fn(this.state, events, result);
  }

  /** Milliseconds since session start, excluding paused time (authoritative). */
  _elapsedDelta() {
    const now = performance.now();
    if (this._lastStamp == null) { this._lastStamp = now; return 0; }
    const d = this.paused ? 0 : now - this._lastStamp;
    this._lastStamp = now;
    return Math.floor(d);
  }

  _mkCmd(type, extra = {}) {
    return Object.assign({
      id: this.sessionId + ':' + (++this._cmdSeq),
      type,
      elapsedMs: this._elapsedDelta(),
    }, extra);
  }

  /** Issue a command. Returns applyCommand result. */
  dispatch(type, extra = {}) {
    if (this.paused && type !== 'sync') {
      return { ok: false, state: this.state, events: [{ type: 'paused' }], error: 'paused' };
    }
    const cmd = this._mkCmd(type, extra);
    const result = applyCommand(this.state, this.level, cmd);
    if (result.state !== this.state) {
      this.state = result.state;
      if (this.state.tick % 10 === 0) this._hashTrail.push(hashState(this.state));
    }
    this._emit(result.events, result);
    return result;
  }

  selectColor(color) { return this.dispatch('select', { color }); }
  fillCell(cell) { return this.dispatch('fill', { cell }); }
  undo() { return this.dispatch('undo'); }
  hint() { return this.dispatch('hint'); }

  setPaused(p) {
    if (this.paused === p) return;
    this._elapsedDelta();          // flush accumulated time before flipping
    this.paused = p;
    this._lastStamp = null;
    this._emit([{ type: p ? 'paused' : 'resumed' }], { ok: true });
  }

  get progress() { return this.state.total ? this.state.filled / this.state.total : 0; }
  get scoreBreakdown() { return score(this.state, this.level); }
  get isOver() { return this.state.status === 'ended'; }

  /** Live elapsed ms (state.elapsedMs + time since last command), for display. */
  elapsedNow() {
    if (this.paused || this._lastStamp == null || this.isOver) return this.state.elapsedMs;
    return this.state.elapsedMs + Math.floor(performance.now() - this._lastStamp);
  }

  /** Replay envelope for submission/validation. */
  envelope() {
    return {
      schemaV: 1,
      contentV: this.level.v,
      levelId: this.level.id,
      seed: this.level.seed,
      tier: this.level.tier,
      mode: this.mode,
      sessionId: this.sessionId,
      mechanics: this.state.mechanics,
      initialHash: this._hashTrail[0],
      commands: this.state.log.slice(),
      hashes: this._hashTrail.concat([hashState(this.state)]),
      result: {
        terminalReason: this.state.terminalReason,
        score: this.scoreBreakdown,
        filled: this.state.filled,
        total: this.state.total,
        invalid: this.state.invalid,
        hints: this.state.hints,
        undos: this.state.undos,
        elapsedMs: this.state.elapsedMs,
      },
      checksum: hashState(this.state),
    };
  }

  /** Durable snapshot for reconnect/restore. */
  snapshot() {
    return JSON.stringify({
      sessionId: this.sessionId,
      mode: this.mode,
      level: this.level,
      state: JSON.parse(serialize(this.state)),
      savedAt: Date.now(),
    });
  }

  /** Restore from snapshot; returns null if unusable. */
  static restore(json) {
    try {
      const snap = typeof json === 'string' ? JSON.parse(json) : json;
      if (!snap.level || !snap.state) return null;
      const s = new GameSession(snap.level, { mode: snap.mode, sessionId: snap.sessionId });
      s.state = deserialize(JSON.stringify(snap.state));
      return s;
    } catch {
      return null;
    }
  }
}
