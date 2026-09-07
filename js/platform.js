/**
 * Color Haven — platform module (StarHermit host adapter).
 * The host guarantees exactly one API route: GET /api/v1/time. It is probed
 * once at startup; every other hosted feature (save, boards, activity,
 * presence, telemetry) is a local no-op by design, because those routes are
 * not guaranteed to exist and calling them would surface console errors.
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

  /* ------------------------- persistence ------------------------- */
  /* localStorage only — the host does not guarantee a save route. */

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
  /* Local board only — the host does not guarantee a leaderboard route. */

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
  /* No-ops — the host does not guarantee activity/presence routes. */

  activityStart(mode) { /* no hosted route to notify */ }
  activityEnd(mode) { /* no hosted route to notify */ }

  /* ------------------------- telemetry (consent-gated, aggregate) ------------------------- */

  setConsent(on) { this.consented = !!on; }

  track(event, props = {}) {
    // Whitelist retained for the day a guaranteed route exists; until then
    // telemetry is intentionally not transmitted.
    if (!this.consented) return;
    const allowed = ['start', 'tutorial_step', 'round_end', 'retry', 'settings_change', 'error'];
    if (!allowed.includes(event)) return;
  }
}
