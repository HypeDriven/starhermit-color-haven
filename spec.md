# Color Haven — Game Design Document (running spec)

**Status:** shipped; this document describes the game as it runs today.
**Pitch:** a paint-by-numbers paper-art game — pick a numbered colour, fill every region that carries that number, and finish a layered paper illustration. No timer, no way to lose.
**Genre:** relaxation / colouring puzzle. **Players:** 1 (asynchronous leaderboards). **Session:** 2–15 min per piece (tier-dependent; a Sprout board is ~2 min, an Elder board ~8 min at par).
**Platforms:** desktop and mobile browsers with WebGL. **Rendering:** Three.js orthographic paper board (instanced tiles) under a semantic HTML shell.

## 1. Overview and file map

| Path | Responsibility |
|---|---|
| `index.html` | Shell: topbar, two rails, canvas host, palette tray, eight overlay screens, ARIA live regions, WebGL compat notice. |
| `css/style.css` | Palette tokens, layout grid, responsive breakpoints, settings classes (`high-contrast`, `large-text`, `left-handed`, `reduced-motion`). |
| `js/main.js` | `App`: boot, screen state machine, mode setup, round lifecycle, tutorial engine, input (pointer/keyboard/gamepad), settings binding, snapshot resume. |
| `js/rules.js` | Pure rules engine: `createGame`, `applyCommand`, `listLegalActions`, `explainFill`, `score`, `hashState`, `replay`, `compareResults`, seeded RNG. |
| `js/content.js` | Themes, palettes, tiers, five procedural illustration generators, `generateLevel`, `validateLevel`, journey (40 stages), daily, tutorial lessons, achievements. |
| `js/session.js` | `GameSession`: command ids, elapsed-time deltas, pause, hash trail, replay envelope, snapshot/restore. |
| `js/render.js` | `PaperRenderer`: Three.js scene, camera framing, picking, number overlay, tile/undo/invalid/celebrate animations, quality tiers. |
| `js/ui.js` | DOM helpers, screen stack, settings/progress stores, palette tray, HUD, results/journey/help/leaderboard rendering, achievements. |
| `js/audio.js` | `AudioEngine`: four buses, authored Opus one-shots with synth fallbacks, studio ambience loop, adaptive pentatonic pad. |
| `js/platform.js` | StarHermit adapter: `/api/v1/time` probe, local saves/boards, no-op activity/telemetry. |
| `server.js` | Authoritative game script: static files, server time, replay-validated leaderboards, peer-scoped saves. |
| `sfx/` | 16 Opus clips, `manifest.txt` (canonical), `manifest.json` (generator input), `manifest.md`. |
| `assets/` | `title-backdrop.webp`, `results-studio.webp` (FLUX.2 key art). `coverart.png` at the root is the store cover. |
| `tests/` | `rules.test.mjs` (npm test), `e2e.mjs` (Playwright, real UI), `server.smoke.mjs` (HTTP). |
| `vendor/three.module.js` | Three.js (import-mapped as `three`). |
| `starhermit.txt` | `name=Color Haven`, `launch=index.html`, `server=server.js`, `cover=coverart.png`. |

## 2. Vision and design pillars

1. **Paper you can feel.** Every region is a physical paper tile that lifts when painted, wobbles when refused, and puffs pigment. Rules in: layered heights per colour, tactile one-shots for every action, pastel card-stock palettes. Rules out: glow, bloom, neon, screen shake, anything that reads as "digital".
2. **Nothing can go wrong, but care is rewarded.** There is no timer and no fail state in the core loop; slips only explain themselves. Rules in: unlimited attempts, undo that only lifts player fills, hint fills that stay. Rules out: lives, countdowns, punitive resets (move limits exist only in opted-in Challenge/Daily/mastery stages).
3. **Numbers never rely on colour.** Every palette entry is number + symbol + swatch, and the CVD palette is a first-class toggle. Rules in: symbols drawn on paper and watermarked on filled tiles, ARIA labels naming colours. Rules out: colour-only cues, hover-only information.
4. **One idea per stage.** Journey adds one concept at a time (a colour, a size, a constraint) and tests it every eighth stage. Rules in: authored mechanic flags per stage. Rules out: random modifiers, surprise rule changes mid-round.
5. **Fair boards, verifiable scores.** Everything is seeded; a leaderboard entry is a replayable command log that the server re-simulates. Rules in: deterministic generators, replay envelopes, integer scoring. Rules out: client-trusted totals, hidden boosts.

## 3. Player experience

**Target player:** someone who wants a calm ten minutes — colouring-book and jigsaw players, commute sessions on a phone, desktop players who like a leaderboard on the side.

**First 60 seconds.** A new player sees the title card over a paper-cut backdrop and presses **Play**; because `settings.tutorialDone` is false, `App` routes to Learn (`main.js` `_wireChrome`). Lesson 1 ("Choosing a color", an 8×8 `bands` board) shows a coach banner: *pick colour 1* → *tap a "1" region* → *fill every remaining "1"* → acknowledgement. Each step advances only when the player performs the real action (`_tutorialEvent`), so by ~40 s the player has selected, filled, and heard the paint stroke. Lesson 2 teaches refusal and undo; lesson 3 finishes a whole piece and reads the score. Skipping Learn is one click (any mode button), and Settings → *Replay tutorial* brings it back.

**Session shape.** Title → (mode setup) → round (2–10 min) → results with breakdown → *Next stage* / *Play again* → title. Leaving mid-round autosaves; the title then offers **Continue** with the piece name and progress.

**Emotional beat.** The piece slowly emerges out of numbered paper: the moment the last region of a colour is filled (tray button goes to "done", a small wooden double-tap plays) and the final celebration puff when the board completes.

## 4. Core loop and rules contract

All rules live in `js/rules.js`; nothing mutates state except `applyCommand`.

**Board.** A level is `w×h` cells (`content.js` `generateLevel`), each with a target palette index in `level.targets`. Tiers (`TIERS`): Sprout 8×8/3 colours, Bloom 12×12/4, Thicket 16×16/5, Canopy 18×18/6, Elder 22×22/8. `repairTargets` guarantees every palette index appears at least once. `validateLevel` checks dimensions (≥4 per side, ≤1024 cells), target range, unused colours, par plausibility, theme id.

**State** (`createGame`): `selected` (colour or null), `fills[]` (0/1 per cell), `filled`, `total`, `moves`, `invalid`, `hints`, `undos`, `elapsedMs`, `remainingMoves` (null unless a move limit), `mechanics {hints, undo, moveLimit, timeTargetMs}`, `undoStack [{cell, byHint}]`, `status active|ended`, `terminalReason`, `log`, `seenIds`, `tick`.

**Commands** (`applyCommand(state, level, cmd)`; every command needs `id` and `type`; duplicate ids are accepted as no-ops):

| Command | Legal when | Effect | Rejections |
|---|---|---|---|
| `select {color}` | active, integer 0..paletteSize-1 | sets `selected`; tick+1 | `bad-color`, `game-over` |
| `fill {cell}` | active, moves remain, integer cell in range, unfilled, a colour selected, target matches | `fills[cell]=1`, `filled++`, `moves++`, `remainingMoves--`, push undo entry, tick+1 | `moves-exhausted`, `out-of-bounds`, `already-filled`, `no-selection`, `wrong-color` |
| `fill` with wrong colour | — | `invalid++`, `remainingMoves--` (if limited), **no tick**, event `invalid {need}` | returns `wrong-color` |
| `undo` | active, `mechanics.undo`, a non-hint fill exists | lifts the most recent player fill, `undos++`, tick+1 | `undo-disabled`, `nothing-to-undo` |
| `hint` | active, `mechanics.hints`, any cell left | fills the first unfilled cell of the selected colour (else first colour with cells left), selects that colour, `hints++`; not undoable | `hints-disabled` |
| `sync {elapsedMs}` | always | accumulates time only | — |

`elapsedMs` accumulates from each command's `elapsedMs` delta (`GameSession._elapsedDelta`, paused time excluded).

**Resolution order** inside `fill`: status → move budget → bounds → already filled → selection → colour match → apply → `checkCompletion` → `checkMoveLimitEnd`.

**Terminal states** (`TERMINAL`): `completed` when `filled >= total`; `moves-exhausted` when `remainingMoves <= 0` with cells left (an invalid fill can trigger it). `listLegalActions` reports `active`, per-colour `selectable`, `fillableFor` (remaining count per colour), `canUndo`, `canHint`.

**Scoring** (`score(state, level)`, integers):
`cells = filled×10`; `completion = 1000` if completed; `accuracy = max(0, 500 − invalid×50)`; `timeBonus = max(0, floor((par.timeMs − elapsedMs)/1000))×5` only when completed; `hintPenalty = −25×hints`; `undoPenalty = −5×undos`; `total = max(0, sum)`. `par.timeMs = cells × tier.timePerCellMs` (1600 ms Sprout … 1000 ms Elder).
*Worked example:* Sprout 8×8 (64 cells, par 102.4 s) finished in 60 s with 1 slip, 1 hint, 2 undos → 640 + 1000 + 450 + 42×5=210 − 25 − 10 = **2265**.

**Stars** (`ui.js` `starCount`): 1 for completion, +1 if `invalid = 0` and `hints ≤ 1`, +1 if `elapsedMs ≤ par.timeMs`.

**Tie-break** (`compareResults`): completion fraction, fewer invalid, lower elapsed, session id. Server boards sort by `score` desc, `elapsedMs` asc, session id.

**RNG / seeding.** `rngFromSeed` = mulberry32 over FNV-1a of the seed string. Levels use `'level:' + seed`; the generator, theme and shape parameters all come from that stream, so `(seed, tier, genId)` reproduces the board exactly. Seeds: `journey/N`, `daily/YYYY-MM-DD`, `tutorial/N`, `practice/<base36 time>`, `challenge/<variant>`, `score/<player seed>`.

**Replay.** `replay(level, opts, commands)` re-applies a log and returns periodic `hashState` values (every 10 ticks). `hashState` JSON-serialises the truth vector (`v, levelId, seed, mode, tick, selected, filled, moves, invalid, hints, undos, elapsedMs, remainingMoves, status, terminalReason, fills`).

**Undo/hints availability** is per level (`level.mechanics`) and per mode; the HUD disables the buttons when a rule forbids them (`updateHUD`).

## 5. Modes and progression

| Mode | Entry | Board | Mechanics | Ranked | Owner |
|---|---|---|---|---|---|
| Learn | title *Learn*, first *Play*, Settings → Replay tutorial | three fixed Sprout lessons (`tutorial/1..3`, generators bands/sunrise/bloom) | hints + undo | no | `startLearn`, `_startLesson`, `_tutorial*` |
| Journey | title *Journey* → 40-stage map, or *Play* once the tutorial is done | `journey/N`; tier = 1 + floor((N−1)/8) | stages 15/21/28/36 add a move limit (ceil(cells×1.15)); hints off from 23; undo off from 31; every 8th stage is Mastery (no hints, limit ceil(cells×1.1)) | no | `journeyStages`, `startJourneyStage` |
| Daily | title *Daily* → setup card | `daily/YYYY-MM-DD` (UTC via platform time); tier = 2 + hash%4 | hints + undo, move limit ceil(cells×1.2) | yes, board `daily-<date>` | `dailyInfo`, `dailyLevel`, `_setupDaily` |
| Practice | title *Practice* → tier select, hints/undo toggles | `practice/<time>` at chosen tier | as chosen | no | `_setupPractice` |
| Challenge | title *Challenge* → variant | `moves`: Thicket, limit ceil(cells×1.05), no hints · `speed`: Thicket, no undo · `elder`: Elder, no hints/undo | per variant | yes, `challenge-<variant>` | `_setupChallenge` |
| Score chase | title *Score chase* → seed text + tier | `score/<seed>` | hints + undo | yes, `score-<seed>` | `_setupScore` |

Journey unlocks sequentially (`renderJourney`); best score and stars per stage persist in `colorhaven.progress.v2`. Achievements (`ACHIEVEMENTS`, `recordCompletion`): First Haven (first completion), Clean Hands (no slips/hints/undos), Three Dawns (daily on 3 distinct dates), Elder Artist (tier 5 completion), Long Road (25 journey stages). The title shows journey progress, today's daily tier, guest id and achievement count.

## 6. Controls and interaction

| Input | Action | Feedback |
|---|---|---|
| Tap / click region | fill focused cell with selected colour (`pointerup` if moved < 12 px and held < 500 ms) | tile drops into place + pigment puff + paint stroke; wrong colour → wobble, thud, toast naming the needed colour, alert announcement, haptic `[30,40,30]` |
| Hover (pointer) | ghost preview of the region colour (bright if it matches selection, faint otherwise) | `render.js` `setHover` |
| Tray button / keys `1`–`8` | select colour | button `aria-pressed`, ring recolours, palette dab sound, announcement |
| Arrow keys / D-pad / left stick | move focus ring (wraps) | ring moves; announces "Region N, needs colour X" |
| Enter / Space / gamepad A | fill focused region | as tap |
| `U` / gamepad X, `H` / gamepad Y, `C` | undo, hint, re-centre camera | paper peel / glass chime / camera ease |
| `P`, Esc, gamepad Start, *Pause* button | pause (Esc also closes overlays) | pause screen, clock stops |
| Drag on board | ignored (no pan; the board always fits) | — |

Input locking: commands are ignored while paused or after the round ends (`GameSession.dispatch`, `_onKey`); overlays are modal (`showScreen`). Double commits are prevented by unique command ids, not debounce timers. Focus returns to the board (`#canvas-host`) after tray selection and resume.

## 7. Screens and UI flow

Screens (`ui.js` `SCREENS`): `title`, `setup`, `journey`, `results`, `pause`, `settings`, `help`, `scores`; one visible at a time on a stack, `closeScreen` returns to the previous one and restores focus.

```
boot ─► title ─┬─ Continue ─────────────────────► round
               ├─ Play ──► Learn (first time) / next Journey stage
               ├─ Learn ─► lesson 1 → 2 → 3 → title
               ├─ Journey ─► map ─► stage ─► results ─► next stage
               ├─ Daily / Practice / Challenge / Score ─► setup ─► round
               └─ Help · Settings (also from topbar and pause)
round ─► pause (Resume · Settings · Help · Leave) ─► title (snapshot kept)
round ─► results (Next · Replay · Leaderboard* · Home)      *ranked only
```

**Desktop (≥1024 px):** topbar (brand, status, Help/Settings/Pause) · three-column grid: left rail (Objective card with progress bar and moves/par, Session card) · board · right rail (Actions, Score preview) · palette tray along the bottom.
**Tablet / narrow (<1024 px):** rails collapse below the board as wrapping card rows; board keeps ≥40dvh.
**Portrait phone (≤640 px):** column flex — board fills, Objective card, Actions; Session and Score-preview cards are hidden; the topbar status is hidden; tray buttons narrow to 3.6 rem; mode grid becomes 2 columns.
**Landscape phone (≤500 px tall):** 12 rem rails, compact topbar without the brand name, results illustration hidden.
Safe areas: `#app` pads with `env(safe-area-inset-*)`; the tray adds the bottom inset. Must never be cut off: palette tray, Pause, the coach banner, the results buttons (the card scrolls inside `max-height: calc(100dvh − 2rem)`).

## 8. Art direction

**Palette (CSS tokens / `THEMES` / palettes):** background `#f6ead8`, panel `#fdf8ef`, panel edge `#e2d2b8`, ink `#3d332a`, soft ink `#7a6c5c`, accent coral `#d96f4e`, focus blue `#2f6fd0`, danger `#b5452e`. Five board themes set backdrop/table/frame/paper/key-light: Daybreak `#f6ead8/#e8d9c0/#b98d5e`, Meadow `#e4ecd8/#d2dfc0/#7d9a5c`, Harbor `#dde8ee/#c9d8e2/#5d7f95`, Dusk `#e6dcea/#d5c8dd/#7a5f8e`, Ember `#f0ddd2/#e2c9b8/#9e5f46`. Pigments: Coral `#e0604e`, Amber `#e8a33d`, Leaf `#5f9e52`, Sky `#5d9fd6`, Violet `#8e6cc9`, Rose `#d96f9e`, Teal `#3fa39a`, Cocoa `#8a6247`; CVD set (Okabe–Ito) `#e69f00 #56b4e9 #009e73 #f0e442 #0072b2 #d55e00 #cc79a7 #4d4d4d`. High-contrast mode switches to pure white/black with accent `#0044cc`.

**Shape language.** Flat cut-paper layers: tiles are 0.94-unit boxes with a 6 % gap, stacked 0.05 units per palette index so higher numbers sit physically higher; a 0.34-unit frame of four slats; a 120-unit table plane. Rounded 14 px cards and 10 px buttons echo cut corners. The **hero** is the board itself, framed by an orthographic camera at 52° tilt, 1.55× diagonal distance, 18 % margin (`render.js` `CAMERA`).

**Typography.** `system-ui` stack, 16 px base (`--font-scale` 1.2 with Larger text), uppercase 0.95 rem card headings with 0.06 em tracking, tabular numerals for stats. Region numbers are drawn on a canvas overlay at 42 % of the cell (weight 600) with the symbol at 22 % below.

**Motion.** Fill: 260 ms ease-out drop from +0.35 units with 10 pigment puffs. Undo: 4 puffs. Invalid: 300 ms ×-axis wobble. Complete: 6 bursts of 24 puffs. Camera re-frame: 900 ms ease-out cubic, interruptible. Reduced motion (setting or body class) skips all tile tweens, puffs and camera eases, shortens the results delay to 200 ms, and zeroes CSS transitions. Quality tiers: low (DPR 1, no AA, no particles), medium (DPR 1.5, 400 particles), high (DPR 2, shadows, 1200 particles).

**Visual assets the design calls for:** store cover (`coverart.png`, paper-cut sunrise with title), title backdrop (`assets/title-backdrop.webp`, calm paper hills with petals under a cream wash), results illustration (`assets/results-studio.webp`, a finished paper garden with pigment jars and confetti, shown only on completion), favicon/icon (paper palette mark). No 3D model is called for: the board is procedural.

## 9. Audio direction

**Mix.** Four buses (`music`, `effects`, `ambience`, `voice`) with defaults 60/80/40/80 %, all under a master that ducks to 0 in 200 ms when the tab hides. Effects are quiet material sounds (paper, brush, wood) — never bright UI beeps. Hierarchy: acknowledgement < legal move < colour complete < round completion. Every authored clip has a WebAudio synth fallback that plays until the Opus clip is decoded or if it fails, so the cue always fires. Captions (Settings → *Text cues for sounds*) route meaningful cues to the polite live region.

**Music.** A generated slow pentatonic pad (`startMusic`): one to three sine voices every 2.4 s, voice count driven by completion fraction (`setMusicIntensity(0.2 + progress×0.8)`).
**Ambience.** `ambience-studio.opus` loops on the ambience bus with a 1.2 s fade-in; a filtered-noise room tone plays until it is decoded (`startAmbience`).

**SFX event table** (source for `sfx/manifest.txt`; all clips 48 kHz mono Opus from MOSS-SoundEffect v2):

| Event (`audio.js`) | File | Sound | Used when |
|---|---|---|---|
| `uiTick` | `ui-tick.opus` | soft wooden tap | any menu/topbar button |
| `select` | `palette-select.opus` | brush dab in a palette well | palette button / number key |
| `fill` | `paint-fill-1..4.opus` | four brush/sponge/roller strokes, random pick | region filled |
| `undo` | `paper-undo.opus` | paper peeled from a stack | undo |
| `hint` | `hint-chime.opus` | single glass chime | hint fill |
| `invalid` | `invalid-thud.opus` | dull double knock on cardboard | wrong-colour tap |
| `complete` | `level-complete.opus` | rising four-note marimba + rustle | board finished |
| `movesExhausted` | `moves-exhausted.opus` | descending two-note wood tone | move limit hit |
| `achievement` | `achievement-chime.opus` | two sparkling bell notes | new achievement on results |
| `roundStart` | `board-unfold.opus` | paper unfolded and smoothed flat | board laid out (start/restart/continue) |
| `colorComplete` | `color-complete.opus` | wooden xylophone double tap + paper flick | last region of a colour filled |
| `tutorialStep` | `tutorial-page.opus` | notebook page turn + pencil tick | coach banner advances |
| ambience | `ambience-studio.opus` | studio room tone, distant birds, breeze | looped during a round |

## 10. Localization

**Shipping languages today:** en-US only. All player-facing strings are literals in `index.html`, `js/ui.js`, `js/main.js` and `js/content.js`; there is no string table and no locale selection. The product requirement is en-US, en-GB, es-419, es-ES, de-DE, fr-FR, fr-CA, pt-BR and it-IT; see *Design intent not yet implemented*. Layout already tolerates ~30 % expansion: cards wrap, the topbar status ellipsises, the tray scrolls horizontally, tutorial banners cap at 34 rem and wrap.

## 11. Accessibility

- **Keyboard-only path:** skip link → board (`#canvas-host`, `role=application`, `tabindex=0`); arrows/Enter/1–8/U/H/C/P cover every play action; all overlays are buttons/inputs; the tutorial banner becomes a `role=button` with Enter/Space when it waits for acknowledgement (`_setBannerAction`). `showScreen` focuses the first control; `closeScreen` restores the previous focus. Esc closes any overlay.
- **Focus visibility:** 3 px `#2f6fd0` outline on every focusable; the board focus ring is a white/selected-colour torus on the focused tile.
- **Announcements:** polite region for selection, focus moves, round start/resume, captions; assertive region for wrong colour, completion, out of moves. Progress bar carries `aria-valuenow`; tray buttons carry name, colour and remaining count.
- **Colour independence:** number + symbol on every region and tray button; CVD-safe palette; high-contrast theme.
- **Reduced motion:** setting (also body class) removes tweens, particles, camera eases and CSS transitions.
- **Targets:** buttons ≥ 44 px tall; tray buttons ≥ 3.4 rem; landscape keeps ≥ 44 px targets.
- **Other options:** larger text (×1.2), left-handed tray (row-reverse), haptics toggle, four volume sliders, text cues for sounds, tutorial replay.

## 12. StarHermit integration

Per https://wiki.starhermit.com/ conventions the game ships `starhermit.txt` (`name`, `launch`, `owner`, `server`, `cover`).

| Feature | Status |
|---|---|
| Server time | Used: `GET /api/v1/time` probed at boot and on tab return; round-trip-adjusted offset drives the daily date (`platform.js` `syncTime`, `now`). |
| Game script | `server.js` serves the distribution, `GET/POST /api/v1/leaderboard/<board>` with replay validation, `GET/POST /api/v1/save` scoped to the peer address, `204` sinks for `/activity`, `/presence`, `/telemetry`. |
| Leaderboards | Client currently submits to a **local** board in `localStorage` (`platform.js` `submitScore`/`fetchBoard`) and shows rank on results plus the Leaderboard screen; the server board API is exercised by `tests/server.smoke.mjs`. |
| Identity | Guest id generated locally (`progress.playerId`); launch `token`/`scope` query params are read into memory only, never persisted. |
| Achievements | Local, idempotent unlocks in `progress.achievements`. |
| Presence / activity / telemetry | Not transmitted (no-ops with a retained event whitelist). |
| Sessions, rooms, chat, voice | Not used: solo game. |

## 13. Technical architecture

- **Determinism:** rules and content are DOM-free ES modules shared by browser, `server.js` and tests. Commands carry ids and elapsed deltas; `GameSession` keeps a hash trail every 10 ticks and builds the replay envelope (`schemaV 1`, content/level/seed/tier/mode, mechanics, commands, hashes, result, checksum). The server regenerates the level (daily: from the date in the board id, ignoring client tier/mechanics), replays, and requires `score.total` and `completed` to match.
- **Persistence (localStorage):** `colorhaven.settings.v1`, `colorhaven.progress.v2`, `colorhaven.snapshot.v2` (autosaved after every state change, cleared on completion; restored by **Continue**), `colorhaven.board.<id>`.
- **Rendering:** one `InstancedMesh` for tiles, one canvas-texture overlay for numbers, an invisible pick plane on layer 1 (only raycast target), pooled particles on layer 3; shaders prewarmed with `renderer.compile`; board rebuilt on quality or palette change; disposal on rebuild. Budget: ≤ 1024 tiles → a handful of draw calls; DPR capped by tier; render loop stops when the tab hides.
- **Audio:** lazy fetch+decode after the first user gesture; every event has a synth fallback.
- **E2E drive:** `tests/e2e.mjs` starts its own static server, launches headless Chrome via `playwright-core`, and only clicks real controls; `window.__colorhaven` is read to synchronise and to find `renderer.cellToScreen(cell)` for taps.
- **Dev hooks:** `?autostart=practice|daily|journey|learn|selftest`, `?screen=settings|help|journey|pause`.

## 14. Testing and acceptance criteria

- `npm test` (`tests/rules.test.mjs`, 1421 assertions): RNG determinism, level generation/validation across tiers, all 40 journey stages valid with reachable move limits, 7 daily boards, tutorial count, palettes, every command path and rejection code, completion and move-limit terminals, score components, serialization/migration, replay hash property test, hint legality, tie-breaks, payload type guards.
- `tests/e2e.mjs` (desktop 1280×800 mouse, mobile 390×844 touch, learn, ranked): title → journey map (40 stages, 39 locked) → stage 1 played by tray + region taps → results rows → progress persisted → stage 2 → hint/undo → pause/settings/resume → Esc → leave → Continue resumes; learn banner advances select → fill → all → acknowledge → lesson 2 → restart keeps the lesson; score-chase round submits and the Leaderboard screen lists it. Fails on any page error or console error.
- `tests/server.smoke.mjs`: time, static, traversal refusal, valid daily replay accepted, tampered score 422, idempotent duplicate, envelope hidden on GET, save round-trip.
- QA bar (checkable): every mode reachable by clicking; no console errors/warnings on desktop and mobile; tray, pause and results buttons visible at 390×844 portrait and 844×390 landscape; text never clipped in cards (they scroll); reduced motion removes all animation; keyboard-only completes a board.

## 15. Asset inventory

| Path | Purpose | Source | Status |
|---|---|---|---|
| `coverart.png` (1200×675) | store cover: paper-cut sunrise + title | FLUX.2 klein seed 3601, text via ffmpeg drawtext, 256-colour PNG | generated in this pass |
| `assets/title-backdrop.webp` (1536×864) | title-screen backdrop | FLUX.2 klein seed 3602 | generated in this pass, wired (`#screen-title`) |
| `assets/results-studio.webp` (768×512) | results illustration on completion | FLUX.2 klein seed 3603 | generated in this pass, wired (`#results-art`) |
| `favicon.svg`, `icon.png` | tab icon / platform icon | hand-authored SVG | shipped |
| `sfx/ui-tick.opus` … `sfx/achievement-chime.opus` (12 clips) | event one-shots (table §9) | MOSS-SFX v2, 100 steps | shipped |
| `sfx/board-unfold.opus` | round start | MOSS-SFX v2 | generated in this pass |
| `sfx/color-complete.opus` | colour finished | MOSS-SFX v2 | generated in this pass |
| `sfx/tutorial-page.opus` | tutorial step | MOSS-SFX v2 | generated in this pass |
| `sfx/ambience-studio.opus` (12 s loop) | round ambience | MOSS-SFX v2 | generated in this pass |
| 3D models / character animation | — | — | not called for (procedural board, no characters) |

## 16. Known limitations

- No localization layer; English only (see §10).
- Leaderboards and achievements are local to the browser; the hosted board API in `server.js` is not called by the client, so "Leaderboard rank" on results is a local-board rank (`(local board)` suffix).
- `replay(level, opts, commands, 0)` records no periodic hashes (`n % 0`); no shipped caller passes 0.
- Server sort tie-break uses `localeCompare` on ASCII session ids.
- A literal `null` JSON body on the save/leaderboard POST routes returns 500 rather than 400.
- Hover preview and the results illustration are cosmetic only; the game is complete without them.

## Design intent not yet implemented

- Ship the nine required locales (en-US, en-GB, es-419, es-ES, de-DE, fr-FR, fr-CA, pt-BR, it-IT) via a string table with a language picker defaulting from `navigator.language`.
- Route ranked submissions through `server.js` (`POST /api/v1/leaderboard/<board>`) when the host is online, keeping the local board as the offline fallback.
- Cloud-save progression through `/api/v1/save` (`platform.saveDoc/loadDoc` exist but have no callers).
