/**
 * Color Haven — platform module (StarHermit host adapter).
 *
 * Hosted contract (wiki): the platform opens the game as
 * index.html#game_token=<jwt> (optional &session_id=), stripped after the
 * read. The JWT carries sub = user id and game_scope = this game's slug —
 * never hard-coded. Same-origin /api calls send Authorization: Bearer; the
 * token re-mints every 45 min via POST /api/v1/games/{slug}/launch-token.
 * The display name is the profile nickname from GET /api/v1/users/{sub}/profile
 * — never /api/v1/me, never usernames. Cloud save is ONE zip+base64 slot at
 * GET/PUT /api/v1/me/cloud-saves/{slug}: remote wins on boot, saves debounce
 * ~2 s and flush on pagehide/hidden; localStorage stays the offline cache.
 *
 * The game's own dev server (server.js) additionally implements /api/v1/save
 * for local testing; the client uses the real platform slot instead. Hosted
 * activity/presence/telemetry have no launch-token endpoints (wiki) and stay
 * no-ops by design — calling them would only surface console errors.
 * Launch/account tokens are kept in memory only — never persisted.
 */

const LS_PREFIX = 'colorhaven.';
const REFRESH_MS = 45 * 60 * 1000; // token lives 60 min; re-mint at 45
const RETRY_MS = 60 * 1000;
const SAVE_DEBOUNCE_MS = 2000;

// Minimal ZIP writer/reader (stored entries only, no compression).
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function zipStore(name, dataBytes) {
  const enc = new TextEncoder();
  const nameB = enc.encode(name);
  const crc = crc32(dataBytes);
  const out = [];
  const u16 = (v) => out.push(v & 0xff, (v >> 8) & 0xff);
  const u32 = (v) => out.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  u32(0x04034b50); u16(20); u16(0); u16(0); u16(0); u16(0);
  u32(crc); u32(dataBytes.length); u32(dataBytes.length);
  u16(nameB.length); u16(0);
  const head = new Uint8Array(out);
  const cd = [];
  const c16 = (v) => cd.push(v & 0xff, (v >> 8) & 0xff);
  const c32 = (v) => cd.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  c32(0x02014b50); c16(20); c16(20); c16(0); c16(0); c16(0); c16(0);
  c32(crc); c32(dataBytes.length); c32(dataBytes.length);
  c16(nameB.length); c16(0); c16(0); c16(0); c16(0); c32(0); c32(0);
  const cdHead = new Uint8Array(cd);
  const cdOff = head.length + nameB.length + dataBytes.length;
  const parts = [head, nameB, dataBytes, cdHead, nameB];
  const eocd = [];
  const e32 = (v) => eocd.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  const e16 = (v) => eocd.push(v & 0xff, (v >> 8) & 0xff);
  e32(0x06054b50); e16(0); e16(0); e16(1); e16(1);
  e32(cdHead.length + nameB.length); e32(cdOff); e16(0);
  parts.push(new Uint8Array(eocd));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const buf = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { buf.set(p, o); o += p.length; }
  return buf;
}
function unzipFirstEntry(zipBytes) {
  const dv = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
  let off = 0;
  while (off + 30 <= zipBytes.length && dv.getUint32(off, true) === 0x04034b50) {
    const method = dv.getUint16(off + 8, true);
    const size = dv.getUint32(off + 18, true);
    const nameLen = dv.getUint16(off + 26, true);
    const extraLen = dv.getUint16(off + 28, true);
    const dataOff = off + 30 + nameLen + extraLen;
    if (method !== 0) throw new Error('unsupported zip entry');
    return zipBytes.slice(dataOff, dataOff + size);
  }
  throw new Error('bad zip');
}
function bytesToBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export class Platform {
  constructor() {
    this.launchToken = null;   // memory only
    this.userId = null;        // JWT sub
    this.scope = null;         // JWT game_scope — never hard-coded
    this.hosted = false;       // a launch token was read
    this.online = false;       // own-server /api reachable (time probe)
    this.profile = null;       // { name } for the signed-in player
    this.sync = 'offline';     // offline | saving | synced (cloud mirror)
    this.timeOffsetMs = 0;     // serverTime - clientTime
    this.consented = false;    // telemetry consent
    this._profileNames = {};   // userId -> Promise<string>
    this._syncListeners = [];
    this._refreshTimer = null;
    this._retryTimer = null;
    this._saveTimer = null;
    this._pendingSave = null;
  }

  _decodeJwt(t) {
    try {
      const seg = String(t).split('.')[1];
      if (!seg) return null;
      let b64 = seg.replace(/-/g, '+').replace(/_/g, '/');
      b64 += '='.repeat((4 - (b64.length % 4)) % 4);
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return null;
    }
  }

  // Fragment first (platform contract); query forms are local-dev only.
  _readLaunchToken() {
    try {
      const h = new URLSearchParams(String(location.hash || '').replace(/^#/, ''));
      const t = h.get('game_token');
      if (t) {
        h.delete('game_token');
        h.delete('session_id');
        const rest = h.toString();
        history.replaceState(null, '', location.pathname + location.search + (rest ? '#' + rest : ''));
        return t;
      }
      const q = new URLSearchParams(location.search);
      return q.get('game_token') || q.get('token') || q.get('launch_token') || null;
    } catch {
      return null;
    }
  }

  headers(extra = {}) {
    if (this.launchToken) extra.Authorization = 'Bearer ' + this.launchToken;
    return extra;
  }

  async init() {
    this.launchToken = this._readLaunchToken();
    if (this.launchToken) {
      const claims = this._decodeJwt(this.launchToken);
      if (!claims) this.launchToken = null;
      else {
        if (typeof claims.sub === 'string' && claims.sub) this.userId = claims.sub;
        if (typeof claims.game_scope === 'string' && claims.game_scope) this.scope = claims.game_scope;
        if (!this.userId || !this.scope) this.launchToken = null; // not a usable launch token
      }
    }
    this.hosted = !!this.launchToken;
    if (!this.scope) {
      // Local dev fallback only; on-platform the slug always comes from the token.
      try { this.scope = new URLSearchParams(location.search).get('scope') || null; } catch { this.scope = null; }
    }
    if (this.hosted) {
      if (this._refreshTimer) clearInterval(this._refreshTimer);
      this._refreshTimer = setInterval(() => this._refreshToken(), REFRESH_MS);
      try {
        window.addEventListener('pagehide', () => this._flushSave());
        document.addEventListener('visibilitychange', () => { if (document.hidden) this._flushSave(); });
      } catch { /* no window events available */ }
      this.fetchProfile().catch(() => {});
    }
    await this.syncTime();
  }

  get tokenHosted() { return this.hosted; }

  /* Token refresh: scoped tokens may re-mint via the game's launch-token
   * route. Retry a failed re-mint after ~60 s. */
  async _refreshToken() {
    if (!this.launchToken || !this.scope) return false;
    try {
      const res = await fetch(`/api/v1/games/${encodeURIComponent(this.scope)}/launch-token`, {
        method: 'POST', headers: this.headers({ 'Content-Type': 'application/json' }), body: '{}',
      });
      const j = await res.json().catch(() => null);
      if (res.ok && j && typeof j.token === 'string' && j.token) {
        this.launchToken = j.token; // memory only
        const claims = this._decodeJwt(this.launchToken);
        if (claims && claims.sub) this.userId = claims.sub;
        if (claims && claims.game_scope) this.scope = claims.game_scope;
        return true;
      }
    } catch { /* fall through to retry */ }
    if (!this._retryTimer) {
      this._retryTimer = setTimeout(() => { this._retryTimer = null; this._refreshToken(); }, RETRY_MS);
    }
    return false;
  }

  /* Identity: the profile nickname is the only profile read a game-scoped
   * token may make. Never /api/v1/me, never usernames. Cached per id. */
  profileFor(userId) {
    if (!userId || typeof userId !== 'string') return Promise.resolve('player');
    if (this._profileNames[userId]) return this._profileNames[userId];
    const p = fetch(`/api/v1/users/${encodeURIComponent(userId)}/profile`, { headers: this.headers() })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => (j && typeof j.nickname === 'string' && j.nickname ? j.nickname : null))
      .then((n) => n || ('Player ' + userId.slice(0, 8)))
      .catch(() => 'Player ' + userId.slice(0, 8));
    this._profileNames[userId] = p;
    return p;
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

  async syncTime() {
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
  /* ONE zip+base64 slot at /api/v1/me/cloud-saves/{slug}. Remote wins on
   * boot; saves debounce ~2 s and flush on pagehide/hidden with keepalive.
   * localStorage (saveDoc/loadDoc below) stays the offline cache. */

  async loadCloud() {
    if (!this.hosted || !this.scope) return null;
    try {
      const res = await fetch(`/api/v1/me/cloud-saves/${encodeURIComponent(this.scope)}`, { headers: this.headers() });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`http-${res.status}`);
      const buf = await res.arrayBuffer();
      if (!buf || !buf.byteLength) return null;
      return JSON.parse(new TextDecoder().decode(unzipFirstEntry(new Uint8Array(buf))));
    } catch {
      return null;
    }
  }

  saveCloud(doc) {
    if (!this.hosted || !this.scope) return Promise.resolve(false);
    this._pendingSave = doc;
    this._setSync('saving');
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this._flushSave(), SAVE_DEBOUNCE_MS);
    return Promise.resolve(true);
  }

  async _flushSave() {
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
    if (!this.hosted || !this.scope || this._pendingSave == null) return false;
    const doc = this._pendingSave;
    this._pendingSave = null;
    let body;
    try {
      body = { dataBase64: bytesToBase64(zipStore('save.json', new TextEncoder().encode(JSON.stringify(doc)))) };
    } catch {
      return false;
    }
    try {
      const res = await fetch(`/api/v1/me/cloud-saves/${encodeURIComponent(this.scope)}`, {
        method: 'PUT',
        headers: this.headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(body),
        keepalive: true,
      });
      if (res.ok) { this._setSync('synced'); return true; }
      this._pendingSave = this._pendingSave == null ? doc : this._pendingSave;
      this._setSync('offline');
      return false;
    } catch {
      this._pendingSave = this._pendingSave == null ? doc : this._pendingSave;
      this._setSync('offline');
      return false;
    }
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
