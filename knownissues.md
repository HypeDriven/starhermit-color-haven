# Known Issues — Color Haven

QA pass 2026-08-20. Static review driven by Qwen3.8 27B on local5090 (HauhauCS Q3_K_P, 32k ctx),
alongside the game's own unit tests and server smoke suite.

## Test results

| Check | Result |
| --- | --- |
| `npm test` (`test/rules.test.mjs`) | 1409/1409 pass, 0 fail |
| `node --check` on all modules | clean (`js/*.js`, `server.js`, `test/*.mjs`) |
| `test/server.smoke.mjs` (against `node server.js 39307`) | PASS — 10/10, 0 fail |
| `tests/e2e.mjs` (headless Chrome) | not present; the shipped smoke is HTTP-level only |
| HTTP fuzz of `server.js` (directories, traversal, malformed encodings, 20 malformed bodies on all 5 API routes) | survived; no crash, no traversal |

## Confirmed defects

Defects 1-3 were reproduced against a running copy of `server.js`; 4-6 against the shipped modules.

### 1. The daily board validates against a level the client chose, not the published one

- **File:** `server.js:83-85` (`validateEntry`)
- **Trigger:** submit a replay whose envelope carries today's `levelId` and `seed` but a different
  `tier`.
- **Behaviour:** the level is regenerated with
  `generateLevel({ id: env.levelId, seed: env.seed, tier: env.tier, mechanics: env.mechanics })` — `tier`
  and `mechanics` come straight from the client's envelope. The only cross-check is
  `env.seed !== entry.seed || env.levelId !== entry.levelId` (line 80), and both of those are also
  client-supplied. The server never calls `dailyLevel()` to find out what today's board actually is, so
  the replay verifies honestly against a board of the submitter's choosing and the entry is stored with
  `casual: false` — i.e. flagged as replay-validated.
- **Expected:** spec.md §6 (line 204) — "validate score claims through a lightweight authoritative script
  using replayable input logs and deterministic seeds"; §2 — daily seeds are immutable after publication.
- **Evidence:** today's real daily is tier 4 (324 cells, 6 colours). Submitting the same `id`/`seed` with
  `tier: 8` yields a 484-cell, 8-colour board worth more points, and it outranks the honest run:

  ```
  real daily : {"id":"daily-2026-08-20","seed":"daily/2026-08-20","tier":4,"palette":6,"cells":324}
  forged tier: {"id":"daily-2026-08-20","seed":"daily/2026-08-20","tier":5,"palette":8,"cells":484}
  honest-daily: score=6520 -> 200 {"ok":true,"rank":3,"casual":false}
  forged-tier : score=8755 -> 200 {"ok":true,"rank":2,"casual":false}
  ```

### 2. A submission with no replay at all takes rank 1 on the daily board

- **File:** `server.js:68-76` (`validateEntry`, the no-envelope branch) and `server.js:186-195`
- **Trigger:** `POST /api/v1/leaderboard/daily-<today>` with `{"score":20000,"sessionId":"…"}` and no
  `envelope`.
- **Behaviour:** without an envelope the only test is `score >= 0 && score <= 20000`. The entry is stored
  in the *same* list as validated entries, and the list is sorted purely by
  `b.score - a.score || a.elapsedMs - b.elapsedMs || …` (line 191), so an unverified maximum-score claim
  sits above every replay-validated run. The `casual` flag is recorded per entry but does not affect
  placement, and `GET` returns them together.
- **Expected:** spec.md §6 (line 204) — "If validation is unavailable, label **the board** casual and
  apply plausibility/rate checks."
- **Evidence:**

  ```
  POST /api/v1/leaderboard/daily-2026-08-20  {"score":20000,"sessionId":"cheat-1","name":"NoReplay"}
    -> 200 {"ok":true,"rank":1,"casual":true}
  GET  /api/v1/leaderboard/daily-2026-08-20
    NoReplay=20000(casual=true)  honest-daily=6520(casual=false)  Smoke=6320(casual=false)
  ```

### 3. Cloud saves have no identity binding — any key can be read or overwritten by anyone

- **File:** `server.js:132-155` (`GET`/`POST /api/v1/save`)
- **Trigger:** `GET /api/v1/save?key=<anything>` or `POST /api/v1/save` with `{"key":"<anything>","doc":…}`.
- **Behaviour:** the key is taken verbatim from the query string or body; there is no session, token,
  header, or IP binding of any kind. Both routes operate on a single shared `saves.json` map, so one
  client can read and overwrite another's document given only its key.
- **Expected:** spec.md §6 (line 194) — cloud-save progression is per-player state; a save endpoint must
  scope documents to the requesting identity. (Compare `js/platform.js:65-73`, which treats the returned
  doc as authoritative progression.)
- **Evidence:**

  ```
  POST /api/v1/save {"key":"victim-key","doc":{"v":1,"tampered":true}}  -> {"ok":true}
  GET  /api/v1/save?key=victim-key                                     -> {"doc":{"v":1,"tampered":true}}
  ```

  Severity today is limited: `saveDoc`/`loadDoc` are defined in `js/platform.js:47-72` but no module in
  `js/` calls them, so the client never populates this store. The endpoint is nonetheless live.

### 4. `select` accepts a non-integer or string colour, which then makes every correct fill "wrong-color"

- **File:** `js/rules.js:237` (`if (c == null || c < 0 || c >= level.paletteSize) return fail(ERR.BAD_COLOR);`)
- **Trigger:** `applyCommand(state, level, { id, type: 'select', color: 1.5 })`, or `color: '1'`.
- **Behaviour:** the guard uses only relational comparisons, which succeed for fractions and for numeric
  strings (via coercion), so `state.selected` becomes `1.5` or `"1"`. `explainFill` then compares with
  `level.targets[cell] !== state.selected` (line 186), which can never match an integer target, so every
  subsequent fill is rejected as `wrong-color` — each one incrementing `state.invalid` and consuming one
  of `state.remainingMoves`.
- **Expected:** spec.md §5 — commands are validated for payload shape before they are applied; the guard
  needs `Number.isInteger(c)`.
- **Evidence:**

  ```
  select color 1.5     err=undefined selected=1.5  invalid=0 remainingMoves=389
    fill a cell targeting 1   err=wrong-color selected=1.5 invalid=1 remainingMoves=388
  select color "1"     err=undefined selected="1"  invalid=0 remainingMoves=389
    fill a cell targeting 1   err=wrong-color selected="1" invalid=1 remainingMoves=388
  ```

### 5. `fill` accepts non-integer cell indices, and `cell: "0"` actually fills cell 0

- **File:** `js/rules.js:253` / `js/rules.js:183`
  (`if (cell == null || cell < 0 || cell >= level.targets.length) return ERR.OUT_OF_BOUNDS;`)
- **Trigger:** `{ type: 'fill', cell: 2.5 }`, `{ cell: NaN }`, `{ cell: '0' }`.
- **Behaviour:** `2.5` and `NaN` pass the bounds guard; `state.fills[2.5]` is `undefined` so the
  already-filled check does not fire, and `level.targets[2.5]` is `undefined` so the command is scored as
  a wrong-colour fill — burning an invalid action and a move on a cell that does not exist. The string
  `"0"` passes the guard *and* indexes the arrays successfully, so it fills a real cell through a path
  that was never meant to accept strings.
- **Expected:** as above — the guard needs `Number.isInteger(cell)`.
- **Evidence:**

  ```
  fill cell 2.5   err=wrong-color invalid=1 moves=0 remainingMoves=388
  fill cell NaN   err=wrong-color invalid=1 moves=0 remainingMoves=388
  fill cell "0"   err=undefined   invalid=0 moves=1 remainingMoves=388   <- accepted
  ```

### 6. `hashState` cannot distinguish a numeric field from its string form

- **File:** `js/rules.js:134-142` (`hashState`)
- **Trigger:** two states differing only in `selected` being `1.5` versus `"1.5"` — reachable through
  defect 4.
- **Behaviour:** every field is stringified into one `'|'`-joined key, so `1.5` and `"1.5"` produce the
  same hash. Replay verification compares these hashes.
- **Expected:** spec.md §5 "Determinism, replay, and security" — the hash is what proves a replay matches.
- **Evidence:** `hashState({...base, selected: 1.5}) === hashState({...base, selected: '1.5'})` → `true`.
  (`state.fills` is only ever 0/1 — `js/rules.js:266`, `js/rules.js:288` — so `fills.join('')` is
  unambiguous; the collision is in the scalar fields.)

## Suspected — not confirmed

### 1. `replay(level, opts, commands, 0)` silently records no periodic hashes

- **File:** `js/rules.js` around line 389 (`if (state.tick % hashEvery === 0) hashes.push(...)`)
- **Concern:** `n % 0` is `NaN`, so a `hashEvery` of `0` disables checkpointing without any error; only
  the initial and final hashes survive, weakening replay verification.
- **Why unconfirmed:** no shipped caller passes `0` — `server.js:86` calls `replay(level, opts, commands)`
  and relies on the default — so this is a latent API hazard rather than an active bug.

### 2. `list.sort` tie-break uses `localeCompare`

- **File:** `server.js:191`
- **Concern:** `String(a.sessionId).localeCompare(String(b.sessionId))` is locale- and ICU-dependent, so
  two hosts could order identical boards differently.
- **Why unconfirmed:** shipped session ids are ASCII, for which common collations agree with code-unit
  order.

## Checked, no defects found

- `js/rules.js:148-177` — `remainingByColor` / `listLegalActions`. The `fills` array stores a 0/1 flag
  (`js/rules.js:266`, `js/rules.js:288`), not a colour index, so using `0` as the "unfilled" sentinel is
  safe even when `level.targets` contains colour index `0`.
- `js/rules.js:180-188` (`explainFill`) — terminal, move-budget, bounds, already-filled, no-selection and
  wrong-colour checks are all present and correctly ordered (the type gaps above are the only holes).
- `js/rules.js:194-201` (`cloneState`) — `fills`, `undoStack`, `log`, `seenIds` and `mechanics` are all
  copied, so command application does not mutate the caller's state.
- `server.js:157-165` — `GET` strips `envelope` from every entry before returning a board, so replay logs
  are never echoed back to other players.
- `server.js:216-228` — static path handling: decode, `normalize`, strip leading `../` and `/`, re-check
  the resolved path against `ROOT`, then explicitly refuse dotfiles, `server.js`, `data/`, `test/` and the
  package manifests. Directory requests surface as a caught 500 rather than a crash.
- `server.js:106-118` (`readBody`) — 512 KB cap with `req.destroy()`; `server.js:51-58` — per-IP token
  bucket applied to both save and score submission.
- Malformed-body handling — a literal `null` JSON body on `POST /api/v1/save` or
  `POST /api/v1/leaderboard/<board>` dereferences `null` at `server.js:142` / `server.js:173` and is
  caught by the outer handler (`server.js:235-238`), returning 500 rather than the more accurate 400.
  The process survives: 20 malformed bodies were POSTed to each of the five API routes with no crash.
  Worth tidying, but it is a status-code accuracy issue, not a defect in the four categories above.

## Not tested

- The browser UI: this game ships no headless-browser test, and the shipped `test/server.smoke.mjs` is
  HTTP-level only. Rendering, input, accessibility and responsive layout were not exercised.
- Audio output (`js/audio.js`).
- Hosted/StarHermit integration in `js/platform.js` beyond reading the code (`saveDoc`/`loadDoc` have no
  callers in `js/`).

## Runtime artefacts

Starting `server.js` created an untracked `data/` directory (`boards.json`, `saves.json`) inside this
game folder. It is runtime state, not a source change; it is being cleaned up centrally. The three
leaderboard/save exploits above were run against **copies** of the game in a scratch directory, so no
forged entry was written to this folder's boards — only the shipped `test/server.smoke.mjs` submission is
present here.
