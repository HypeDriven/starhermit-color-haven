/**
 * Color Haven — platform module (StarHermit host adapter) over
 * window.StarHermit (starhermit-sdk.js, loaded and init()ed from index.html
 * before the game modules). The SDK reads the launch token (#game_token from
 * the library, #access_token after a direct sign-in), strips it, keeps it in
 * memory, renews it, and owns the profile nickname (never /api/v1/me), the
 * cloud-save slot game:<slug> (remote wins on boot, saves debounce ~2 s and
 * flush on pagehide/hidden; localStorage stays the offline cache), the
 * settings KV, control bindings, the invite link and sign-in.
 *
 * The game's own dev server (server.js) answers /api/v1/time locally; it is
 * only asked when signed in. Standalone (no token) makes no requests at all.
 * Hosted activity/presence/telemetry have no launch-token endpoints and stay
 * no-ops by design.
 */

const LS_PREFIX = 'colorhaven.';
const SAVE_DEBOUNCE_MS = 2000;
const sdk = () => globalThis.StarHermit || null;

// Keyboard actions — declared as control.<action> in starhermit.txt.
export const DEFAULT_BINDINGS = {
  left: ['ArrowLeft'], right: ['ArrowRight'], up: ['ArrowUp'], down: ['ArrowDown'],
  fill: ['Enter', 'Space'], undo: ['KeyU'], hint: ['KeyH'], recenter: ['KeyC'], pause: ['KeyP'], cancel: ['Escape'],
  color1: ['Digit1', 'Numpad1'], color2: ['Digit2', 'Numpad2'], color3: ['Digit3', 'Numpad3'], color4: ['Digit4', 'Numpad4'],
  color5: ['Digit5', 'Numpad5'], color6: ['Digit6', 'Numpad6'], color7: ['Digit7', 'Numpad7'], color8: ['Digit8', 'Numpad8'],
};
// Preferences mirrored to the settings KV.
const SYNCED_SETTINGS = ['volMusic', 'volEffects', 'volAmbience', 'volVoice', 'captions', 'gfx', 'reducedMotion',
  'highContrast', 'cvdPalette', 'largeText', 'leftHanded', 'haptics'];
const KEY_NAMES = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Escape: 'Esc', Space: 'Space' };
const cloneBindings = (b) => Object.fromEntries(Object.entries(b).map(([k, v]) => [k, v.slice()]));

export class Platform {
  constructor() {
    this.online = false;       // own-server /api reachable (time probe)
    this.profile = null;       // { name } for the signed-in player
    this.sync = 'offline';     // offline | saving | synced (cloud mirror)
    this.timeOffsetMs = 0;     // serverTime - clientTime
    this.consented = false;    // telemetry consent
    this.bindings = cloneBindings(DEFAULT_BINDINGS);
    this._codeMap = null;
    this._syncListeners = [];
    this._authListeners = [];
    this._kvReady = false;
    this._kvLast = null;
    this._kvTimer = null;
  }

  get hosted() { const s = sdk(); return !!(s && s.signedIn); }
  get tokenHosted() { return this.hosted; }
  get launchToken() { const s = sdk(); return s ? s.token : null; }
  get userId() { const s = sdk(); return s ? s.userId : null; }
  get scope() { const s = sdk(); return s ? s.slug : null; }

  headers(extra = {}) {
    if (this.launchToken) extra.Authorization = 'Bearer ' + this.launchToken;
    return extra;
  }

  async init() {
    const s = sdk();
    if (s) {
      s.on('saved', (ok) => this._setSync(ok ? 'synced' : 'offline'));
      s.on('auth', (a) => {
        if (!a.signedIn) { this.profile = null; this.online = false; this._setSync('offline'); }
        for (const fn of this._authListeners) { try { fn(a); } catch { /* ignore */ } }
      });
    }
    if (this.hosted) {
      try {
        window.addEventListener('pagehide', () => this._flushSave());
        document.addEventListener('visibilitychange', () => { if (document.hidden) this._flushSave(); });
      } catch { /* no window events available */ }
      this.fetchProfile().catch(() => {});
    }
    await this.syncTime();
  }

  onAuth(fn) { if (typeof fn === 'function') this._authListeners.push(fn); }
  canSignIn() { const s = sdk(); return !!(s && s.canSignIn()); }
  signIn() { const s = sdk(); return !!(s && s.signIn()); }
  inviteLink() { return this.hosted ? sdk().inviteLink() : null; }
  async copyInvite() {
    const link = this.inviteLink();
    if (!link) return false;
    try { await navigator.clipboard.writeText(link); return true; } catch { return false; }
  }

  /* Token renewal is the SDK's (launch-token chain). */
  async _refreshToken() { const s = sdk(); return s ? !!(await s.refresh()) : false; }

  /* Identity: the profile nickname, 'Player <id>' fallback; never usernames. */
  profileFor(userId) {
    if (!userId || typeof userId !== 'string') return Promise.resolve('player');
    if (!this.hosted) return Promise.resolve('Player ' + userId.slice(0, 6));
    return sdk().profile(userId).then((p) => (p && p.displayName) || 'Player ' + userId.slice(0, 6))
      .catch(() => 'Player ' + userId.slice(0, 6));
  }

  async fetchProfile() {
    if (!this.userId) return null;
    const name = (await this.profileFor(this.userId)).slice(0, 40);
    this.profile = { name };
    return this.profile;
  }

  onSync(fn) { if (typeof fn === 'function') this._syncListeners.push(fn); }

  _setSync(state) {
    if (this.sync === state) return;
    this.sync = state;
    for (const fn of this._syncListeners) {
      try { fn(state); } catch { /* listener errors never break the adapter */ }
    }
  }

  /* ------------------------- time sync ------------------------- */

  /* Own-server clock, signed in only; standalone keeps the local clock. */
  async syncTime() {
    if (!this.hosted) { this.online = false; this.timeOffsetMs = 0; return; }
    try {
      const t0 = performance.now();
      const res = await fetch('/api/v1/time', { cache: 'no-store', headers: this.headers() });
      const rtt = performance.now() - t0;
      if (!res.ok) throw new Error('time ' + res.status);
      const data = await res.json();
      // Hosts expose the epoch under different keys (`now`, `serverTime`, `epochMs`).
      const serverMs = Number(data.now ?? data.serverTime ?? data.epochMs);
      if (!Number.isFinite(serverMs)) throw new Error('time shape');
      this.timeOffsetMs = serverMs + rtt / 2 - Date.now();
      this.online = true;
    } catch {
      this.online = false;
      this.timeOffsetMs = 0;
    }
  }

  /** Authoritative-ish now (UTC ms), round-trip adjusted when hosted. */
  now() { return Date.now() + this.timeOffsetMs; }

  /* ------------------------- cloud save ------------------------- */

  async loadCloud() {
    if (!this.hosted) return null;
    try { return await sdk().loadJSON(); } catch { return null; }
  }

  saveCloud(doc) {
    if (!this.hosted) return Promise.resolve(false);
    this._setSync('saving');
    sdk().saveJSON(doc, SAVE_DEBOUNCE_MS);
    return Promise.resolve(true);
  }

  async _flushSave() {
    if (!this.hosted) return false;
    return sdk().flushSave(true);
  }

  /* ------------------------- settings KV ------------------------- */

  async getSettings() {
    if (!this.hosted) return {};
    let kv = {};
    try { kv = (await sdk().getSettings()) || {}; } catch { kv = {}; }
    this._kvReady = true;
    const out = {};
    for (const k of SYNCED_SETTINGS) if (kv[k] !== undefined && kv[k] !== null) out[k] = kv[k];
    return out;
  }

  /** Debounced patch of changed preferences (only after the KV was read). */
  mirrorSettings(settings) {
    if (!this.hosted || !this._kvReady) return;
    const patch = {};
    for (const k of SYNCED_SETTINGS) if (settings[k] !== undefined) patch[k] = settings[k];
    const json = JSON.stringify(patch);
    if (json === this._kvLast) return;
    clearTimeout(this._kvTimer);
    this._kvTimer = setTimeout(() => { this._kvLast = json; sdk().patchSettings(patch); }, 800);
  }

  /* ------------------------- controls ------------------------- */

  async loadBindings() {
    if (this.hosted) {
      try { this.bindings = await sdk().loadBindings(DEFAULT_BINDINGS); } catch { /* defaults */ }
    }
    this._codeMap = null;
    return this.bindings;
  }

  actionFor(e) {
    if (!this._codeMap) {
      this._codeMap = {};
      for (const [a, codes] of Object.entries(this.bindings)) for (const c of codes) this._codeMap[c] = a;
    }
    return this._codeMap[e.code] || null;
  }

  keyLabel(action) {
    return (this.bindings[action] || []).filter((c) => !/^Numpad/.test(c))
      .map((c) => KEY_NAMES[c] || c.replace(/^Key|^Digit/, '')).join(' / ');
  }

  /* ------------------------- persistence ------------------------- */
  /* localStorage only — the offline cache; the cloud slot mirrors it. */

  async saveDoc(key, doc) {
    try { localStorage.setItem(LS_PREFIX + key, JSON.stringify(doc)); } catch { /* quota */ }
    return true;
  }

  async loadDoc(key) {
    try {
      const raw = localStorage.getItem(LS_PREFIX + key);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  /* ------------------------- leaderboards ------------------------- */
  /* Local board only — clients never submit to game leaderboards (wiki) and
   * the host does not guarantee a leaderboard route. */

  /**
   * Signed in only: post a completed ranked round's total to the platform
   * `high-score` board (score-script.js). Resolves { posted, rank } — the
   * player's rank on that board, or null. Standalone → not posted, no request.
   */
  async submitPlatformScore(total) {
    const s = sdk();
    if (!this.hosted || !s || typeof s.submitScores !== 'function') return { posted: false, rank: null };
    let keys = [];
    try { keys = await s.submitScores({ 'high-score': Math.max(0, Math.round(total)) }); } catch { keys = []; }
    if (!keys.includes('high-score')) return { posted: false, rank: null };
    try {
      const r = await s.leaderboard('high-score', { pageSize: 100 });
      const me = (r.items || []).find(i => i.userId === this.userId);
      return { posted: true, rank: me ? me.rank : null };
    } catch { return { posted: true, rank: null }; }
  }

  async submitScore(board, entry) {
    const list = await this.fetchBoard(board);
    list.push(entry);
    list.sort((a, b) => b.score - a.score || a.elapsedMs - b.elapsedMs);
    // Rank is read from the full sorted list: an entry that falls outside the
    // stored top 100 still has a real placement, not rank 0.
    const rank = list.findIndex(e => e.sessionId === entry.sessionId) + 1;
    const trimmed = list.slice(0, 100);
    try { localStorage.setItem(LS_PREFIX + 'board.' + board, JSON.stringify(trimmed)); } catch { /* quota */ }
    return { ok: true, rank, local: true };
  }

  async fetchBoard(board) {
    try {
      return JSON.parse(localStorage.getItem(LS_PREFIX + 'board.' + board) || '[]');
    } catch { return []; }
  }

  /* ------------------------- activity + presence ------------------------- */
  /* No-ops — no per-game activity/presence endpoints exist for launch tokens
   * (wiki); calling them would only surface console errors. */

  activityStart(mode) { /* no hosted route to notify */ }
  activityEnd(mode) { /* no hosted route to notify */ }

  /* ------------------------- telemetry (consent-gated, aggregate) ------------------------- */

  setConsent(on) { this.consented = !!on; }

  track(event, props = {}) {
    // No client telemetry endpoint exists for launch tokens (wiki);
    // consent-gated events are intentionally not transmitted.
    if (!this.consented) return;
    const allowed = ['start', 'tutorial_step', 'round_end', 'retry', 'settings_change', 'error'];
    if (!allowed.includes(event)) return;
  }
}
