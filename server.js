/**
 * Color Haven — authoritative game script (StarHermit `server=server.js`).
 * Zero-dependency Node server: static files, server time, versioned cloud
 * saves, and replay-validated leaderboards. Used only for seeded daily
 * sessions, replay validation, and durable score delivery; practice runs
 * fully client-side.
 *
 * Run standalone:  node server.js [port]
 */

import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateLevel, dailyLevel, CONTENT_VERSION } from './js/content.js';
import { replay, score as scoreOf, RULES_VERSION } from './js/rules.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const DATA_DIR = join(ROOT, 'data');
const BOARDS_FILE = join(DATA_DIR, 'boards.json');
const SAVES_FILE = join(DATA_DIR, 'saves.json');
const MAX_BODY = 512 * 1024;
const MAX_BOARD_ENTRIES = 200;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.opus': 'audio/ogg',
};

/* ------------------------------------------------------------------ */
/* tiny file-backed stores                                             */
/* ------------------------------------------------------------------ */

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return fallback; }
}
async function writeJson(file, data) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(file, JSON.stringify(data));
}

/* Simple per-IP token bucket (rate limits are recoverable UI states). */
const buckets = new Map();
function rateLimited(ip, cost = 1, perMinute = 120) {
  const now = Date.now();
  let b = buckets.get(ip);
  if (!b || now - b.start > 60000) { b = { start: now, count: 0 }; buckets.set(ip, b); }
  b.count += cost;
  return b.count > perMinute;
}

/* Scope a save key to the requesting identity. There is no account/token layer
 * in this offline build, so the peer address is the only available identity:
 * keying the store on it means one client can no longer read or overwrite
 * another's document by naming its key. */
function scopedSaveKey(ip, key) {
  return 'ip:' + String(ip).replace(/[^A-Za-z0-9.:]/g, '_') + '|' + key;
}

/* ------------------------------------------------------------------ */
/* replay validation                                                   */
/* ------------------------------------------------------------------ */

/**
 * Validate a score entry by replaying its envelope against a regenerated
 * level. Returns { valid, reason?, casual }.
 *
 * @param board  the leaderboard id from the URL (e.g. "daily-2026-08-20"),
 *               used to bind daily submissions to the server-published board.
 */
function validateEntry(entry, board) {
  const env = entry && entry.envelope;
  if (!env) {
    // No replay log. The authoritative server always validates via replay, so an
    // unverifiable claim is rejected outright rather than outranking validated
    // runs on a competitive board.
    return { valid: false, reason: 'missing replay log' };
  }
  try {
    if (env.schemaV !== 1) return { valid: false, reason: 'unknown envelope schema' };
    if (env.contentV !== CONTENT_VERSION) return { valid: false, reason: 'stale content version' };
    if (env.seed !== entry.seed || env.levelId !== entry.levelId) {
      return { valid: false, reason: 'envelope/entry mismatch' };
    }
    // Daily boards are published by the server: ignore any client-supplied
    // tier/mechanics and validate against the actual board for that date.
    const dailyMatch = board && /^daily-(\d{4}-\d{2}-\d{2})$/.exec(board);
    let level;
    let opts;
    if (dailyMatch) {
      level = dailyLevel(dailyMatch[1]);
      if (env.levelId !== level.id || env.seed !== level.seed) {
        return { valid: false, reason: 'not the published daily board' };
      }
      opts = { mode: env.mode }; // server-authoritative mechanics, not the client's
    } else {
      level = generateLevel({
        id: env.levelId, seed: env.seed, tier: env.tier, mechanics: env.mechanics,
      });
      opts = { mode: env.mode, mechanics: env.mechanics };
    }
    const { state } = replay(level, opts, env.commands || []);
    const sc = scoreOf(state, level);
    if (sc.total !== entry.score) return { valid: false, reason: 'score mismatch' };
    if (state.terminalReason !== 'completed') return { valid: false, reason: 'not completed' };
    return { valid: true, casual: false };
  } catch (err) {
    return { valid: false, reason: 'replay error: ' + err.message };
  }
}

/* ------------------------------------------------------------------ */
/* HTTP server                                                         */
/* ------------------------------------------------------------------ */

function json(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function createColorHavenServer() {
  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    const ip = req.socket.remoteAddress || 'anon';

    try {
      /* ---------------- API ---------------- */
      if (path === '/api/v1/time' && req.method === 'GET') {
        return json(res, 200, { now: Date.now() });
      }

      if (path === '/api/v1/save' && req.method === 'GET') {
        const key = url.searchParams.get('key') || '';
        if (key.length > 80) return json(res, 400, { error: 'bad key' });
        const saves = await readJson(SAVES_FILE, {});
        return json(res, 200, { doc: saves[scopedSaveKey(ip, key)] || null });
      }

      if (path === '/api/v1/save' && req.method === 'POST') {
        if (rateLimited(ip, 2)) return json(res, 429, { error: 'rate limited' });
        const body = JSON.parse(await readBody(req) || '{}');
        if (typeof body.key !== 'string' || body.key.length > 80 || body.doc == null) {
          return json(res, 400, { error: 'bad save' });
        }
        const saves = await readJson(SAVES_FILE, {});
        const key = scopedSaveKey(ip, body.key);
        const prev = saves[key];
        // Versioned, checksummed doc: keep both when neither descends.
        if (prev && prev.v != null && body.doc.v != null && body.doc.v < prev.v) {
          saves[key + '.conflict.' + Date.now()] = body.doc;
        } else {
          saves[key] = body.doc;
        }
        await writeJson(SAVES_FILE, saves);
        return json(res, 200, { ok: true });
      }

      const boardMatch = path.match(/^\/api\/v1\/leaderboard\/(.+)$/);
      if (boardMatch && req.method === 'GET') {
        const board = decodeURIComponent(boardMatch[1]);
        const boards = await readJson(BOARDS_FILE, {});
        const entries = (boards[board] || [])
          .map(({ envelope, ...pub }) => pub)  // never echo replay logs back
          .slice(0, 50);
        return json(res, 200, { board, entries });
      }

      if (boardMatch && req.method === 'POST') {
        if (rateLimited(ip, 5)) return json(res, 429, { error: 'rate limited' });
        const board = decodeURIComponent(boardMatch[1]);
        if (board.length > 80) return json(res, 400, { error: 'bad board' });
        const entry = JSON.parse(await readBody(req) || '{}');
        // Bounds / shape validation.
        if (!Number.isInteger(entry.score) || entry.score < 0 || entry.score > 20000) {
          return json(res, 400, { error: 'bad score' });
        }
        if (typeof entry.sessionId !== 'string' || entry.sessionId.length > 80) {
          return json(res, 400, { error: 'bad session' });
        }
        entry.name = String(entry.name || 'Guest').slice(0, 24);
        entry.at = Date.now();

        const verdict = validateEntry(entry, board);
        if (!verdict.valid) return json(res, 422, { error: 'score rejected: ' + verdict.reason });
        entry.casual = !!verdict.casual;

        const boards = await readJson(BOARDS_FILE, {});
        const list = boards[board] || [];
        if (!list.some(e => e.sessionId === entry.sessionId)) { // idempotent
          list.push(entry);
        }
        list.sort((a, b) => b.score - a.score || a.elapsedMs - b.elapsedMs || String(a.sessionId).localeCompare(String(b.sessionId)));
        boards[board] = list.slice(0, MAX_BOARD_ENTRIES);
        await writeJson(BOARDS_FILE, boards);
        const rank = boards[board].findIndex(e => e.sessionId === entry.sessionId) + 1;
        return json(res, 200, { ok: true, rank, casual: entry.casual });
      }

      if (path === '/api/v1/activity' || path === '/api/v1/presence') {
        if (req.method !== 'POST') return json(res, 405, { error: 'method' });
        await readBody(req).catch(() => '');
        res.writeHead(204); return res.end();
      }

      if (path === '/api/v1/telemetry') {
        if (req.method !== 'POST') return json(res, 405, { error: 'method' });
        await readBody(req).catch(() => '');
        res.writeHead(204); return res.end();
      }

      if (path.startsWith('/api/')) return json(res, 404, { error: 'not found' });

      /* ---------------- static files ---------------- */
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return json(res, 405, { error: 'method' });
      }
      let rel = normalize(decodeURIComponent(path)).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '');
      if (!rel || rel === '.' || rel === '/') rel = 'index.html';
      const file = join(ROOT, rel);
      if (!file.startsWith(ROOT) || !existsSync(file)) {
        return json(res, 404, { error: 'not found' });
      }
      // Never serve hidden files, the server script, tests, or data.
      if (rel.includes('/.') || rel.startsWith('.') || rel === 'server.js' ||
          rel.startsWith('data/') || rel.startsWith('data\\') ||
          rel.startsWith('tests/') || rel.startsWith('tests\\') ||
          rel === 'package.json' || rel === 'package-lock.json') {
        return json(res, 404, { error: 'not found' });
      }
      const data = await readFile(file);
      res.writeHead(200, {
        'content-type': MIME[extname(file)] || 'application/octet-stream',
        'cache-control': rel === 'index.html' ? 'no-cache' : 'public, max-age=3600',
      });
      res.end(data);
    } catch (err) {
      if (!res.headersSent) json(res, 500, { error: 'internal' });
      console.error('server error', err.message);
    }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = +(process.argv[2] || process.env.PORT || 8080);
  createColorHavenServer().listen(port, () => {
    console.log(`Color Haven listening on http://localhost:${port}`);
  });
}
