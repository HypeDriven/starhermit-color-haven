/**
 * Color Haven — platform module (StarHermit host adapter).
 * Same-origin /api routes when hosted; transparent local fallback offline.
 * Launch/account tokens are kept in memory only — never persisted.
 */

const LS_PREFIX = 'colorhaven.';

export class Platform {
  constructor() {
    const params = new URLSearchParams(location.search);
    this.launchToken = params.get('token') || null;  // memory only
    this.scope = params.get('scope') || 'local';
    this.online = false;          // host API reachable
    this.timeOffsetMs = 0;        // serverTime - clientTime
    this.consented = false;       // telemetry consent
    this._hbTimer = null;
  }

  async init() {
    await this.syncTime();
  }

  /* ------------------------- time sync ------------------------- */

  async syncTime() {
    try {
      const t0 = performance.now();
      const res = await fetch('/api/v1/time', { cache: 'no-store' });
      const rtt = performance.now() - t0;
      if (!res.ok) throw new Error('time ' + res.status);
      const data = await res.json();
      this.timeOffsetMs = data.now + rtt / 2 - Date.now();
      this.online = true;
    } catch {
      this.online = false;
      this.timeOffsetMs = 0;
    }
  }

  /** Authoritative-ish now (UTC ms), round-trip adjusted when hosted. */
  now() { return Date.now() + this.timeOffsetMs; }

  /* ------------------------- persistence ------------------------- */
  /* Cloud when hosted (versioned, checksummed doc); localStorage otherwise. */

  async saveDoc(key, doc) {
    const body = JSON.stringify({ key, doc });
    if (this.online) {
      try {
        const res = await this._fetch('/api/v1/save', { method: 'POST', body });
        if (res.ok) return true;
      } catch { /* fall through to local */ }
    }
    try { localStorage.setItem(LS_PREFIX + key, JSON.stringify(doc)); } catch { /* quota */ }
    return true;
  }

  async loadDoc(key) {
    if (this.online) {
      try {
        const res = await this._fetch('/api/v1/save?key=' + encodeURIComponent(key));
        if (res.ok) {
          const data = await res.json();
          if (data.doc) return data.doc;
        }
      } catch { /* fall through */ }
    }
    try {
      const raw = localStorage.getItem(LS_PREFIX + key);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  /* ------------------------- leaderboards ------------------------- */

  async submitScore(board, entry) {
    if (this.online) {
      try {
        const res = await this._fetch('/api/v1/leaderboard/' + encodeURIComponent(board), {
          method: 'POST', body: JSON.stringify(entry),
        });
        if (res.ok) return await res.json();
        const err = await res.json().catch(() => ({}));
        return { ok: false, error: err.error || 'submit failed' };
      } catch { /* fall through */ }
    }
    // Local board fallback.
    const list = await this.fetchBoard(board);
    list.push(entry);
    list.sort((a, b) => b.score - a.score || a.elapsedMs - b.elapsedMs);
    const trimmed = list.slice(0, 100);
    try { localStorage.setItem(LS_PREFIX + 'board.' + board, JSON.stringify(trimmed)); } catch { /* quota */ }
    const rank = trimmed.findIndex(e => e.sessionId === entry.sessionId) + 1;
    return { ok: true, rank, local: true };
  }

  async fetchBoard(board) {
    if (this.online) {
      try {
        const res = await this._fetch('/api/v1/leaderboard/' + encodeURIComponent(board));
        if (res.ok) {
          const data = await res.json();
          return data.entries || [];
        }
      } catch { /* fall through */ }
    }
    try {
      return JSON.parse(localStorage.getItem(LS_PREFIX + 'board.' + board) || '[]');
    } catch { return []; }
  }

  /* ------------------------- activity + presence ------------------------- */

  activityStart(mode) {
    this._activity('start', mode);
    this._heartbeat(true);
  }

  activityEnd(mode) {
    this._activity('end', mode);
    this._heartbeat(false);
  }

  async _activity(kind, mode) {
    if (!this.online) return;
    try { await this._fetch('/api/v1/activity', { method: 'POST', body: JSON.stringify({ kind, mode }) }); }
    catch { /* best effort */ }
  }

  _heartbeat(on) {
    if (this._hbTimer) { clearInterval(this._hbTimer); this._hbTimer = null; }
    if (!on || !this.online) return;
    this._hbTimer = setInterval(() => {
      this._fetch('/api/v1/presence', { method: 'POST', body: '{}' }).catch(() => {});
    }, 30000);
  }

  /* ------------------------- telemetry (consent-gated, aggregate) ------------------------- */

  setConsent(on) { this.consented = !!on; }

  track(event, props = {}) {
    if (!this.consented) return;
    const allowed = ['start', 'tutorial_step', 'round_end', 'retry', 'settings_change', 'error'];
    if (!allowed.includes(event)) return;
    if (this.online) {
      this._fetch('/api/v1/telemetry', {
        method: 'POST',
        body: JSON.stringify({ event, props, at: this.now() }),
      }).catch(() => {});
    }
  }

  /* ------------------------- fetch helper ------------------------- */

  async _fetch(url, opts = {}) {
    const headers = { 'content-type': 'application/json' };
    if (this.launchToken) headers['x-launch-token'] = this.launchToken;
    const res = await fetch(url, { ...opts, headers });
    if (res.status === 429) {
      // Structured rate-limit: recoverable; surface as offline for this call.
      this.online = false;
      setTimeout(() => { this.syncTime(); }, 5000);
      throw new Error('rate-limited');
    }
    return res;
  }
}
