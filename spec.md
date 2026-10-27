# Color Haven — Game Design Document (running spec)

**Status:** shipped; this document describes the game as it runs today.
**Pitch:** a paint-by-numbers paper-art game — pick a numbered colour, fill every region that carries that number, and finish a layered paper illustration. No timer, no way to lose.
**Genre:** relaxation / colouring puzzle. **Players:** 1 (asynchronous leaderboards). **Session:** 2–15 min per piece (tier-dependent).
**Platforms:** a StarHermit engine script game (engine 1.16.0, host API 1.18, `engine.minor=18`): played natively by the StarHermit client and in browsers by the engine's web runtime from one package. **Rendering:** an orthographic paper board on `starhermit:scene` under an immediate-mode `starhermit:ui` shell.

## 1. File map

| Path | Role |
|---|---|
| `starhermit.txt` | manifest: `engine.entry=native/main.ts`, `engine.version=1.16.0`, `engine.minor=18`, capabilities `platform,storage,clipboard`, `control.*` / `engine.gamepad.*` / `engine.group.*`, `server=score-script.js`, cover |
| `native/main.ts` | entry: state machine, round lifecycle and snapshot, session events → sound/toast/announcement/board, Learn coach banner, input (actions, board taps, hover), results and leaderboard posting, lifecycle |
| `native/screens.ts` | every screen, card, dialog and toast (`starhermit:ui`), layouts per window size, title petals, drawn glyphs |
| `native/render.ts` | the paper board (`starhermit:scene`): table, frame, instanced tiles, number overlay canvas, focus ring, hover ghost, pigment puffs, motes, lights, post effects, picking |
| `native/symbols.ts` | the eight palette symbols drawn as shapes (canvas paths and `starhermit:draw`) |
| `native/audio.ts` | sample one-shots, studio room-tone loop, rendered pentatonic pad (`starhermit:audio`) |
| `native/platform.ts` | save (`saves`), foreign-save migration, game settings and legacy keys, device storage shim, player, invite, server clock, high-score posting |
| `native/quality.ts` | the look per graphics tier/level (the old presets and budgets) |
| `native/i18n.ts`, `native/style.ts` | locale from the runtime's interface language; UI theme and `assets/ui-style.json` |
| `js/rules.js`, `js/content.js`, `js/session.js` | rules engine, content generators, session with replay envelope (ES modules shared with `server.js` and the tests; the session takes the host's clock through `GameSession.clock`) |
| `js/store.js` | the pure save model: document, merge, browser-save migration, settings checks, completion records, snapshot, local boards |
| `js/strings.js`, `js/i18n.js`, `js/platform-strings.js` | string tables (nine locales) and lookup |
| `tools/ui-style.css` → `assets/ui-style.json` | the class-based style sheet (`npm run css`) |
| `index.html`, `starhermit-files.json` | the engine's web loader and file index (`npm run package`; never edited by hand) |
| `score-script.js` | platform script that range-checks and records `high-score` results |
| `server.js` | local dev static server and the replay-validating board API (not part of the package) |
| `tests/`, `tools/` | unit, i18n, native and browser checks; play-script generator (not part of the package) |

## 2. Vision and design pillars

1. **Paper you can feel.** Every region is a physical paper tile that lifts when painted, wobbles when refused, and puffs pigment. Rules in: layered heights per colour, tactile one-shots for every action, pastel card-stock palettes. Rules out: glow, bloom, neon, screen shake, anything that reads as "digital".
2. **Nothing can go wrong, but care is rewarded.** There is no timer and no fail state in the core loop; slips only explain themselves. Rules in: unlimited attempts, undo that only lifts player fills, hint fills that stay. Rules out: lives, countdowns, punitive resets (move limits exist only in opted-in Challenge/Daily/mastery stages).
3. **Numbers never rely on colour.** Every palette entry is number + symbol + swatch, and the CVD palette is a first-class toggle. Rules in: symbols drawn on paper and watermarked on filled tiles, accessible names naming colours. Rules out: colour-only cues, hover-only information.
4. **One idea per stage.** Journey adds one concept at a time (a colour, a size, a constraint) and tests it every eighth stage. Rules in: authored mechanic flags per stage. Rules out: random modifiers, surprise rule changes mid-round.
5. **Fair boards, verifiable scores.** Everything is seeded; a leaderboard entry is a replayable command log that the server re-simulates. Rules in: deterministic generators, replay envelopes, integer scoring. Rules out: client-trusted totals, hidden boosts.

## 3. Player experience

A new player sees the title card over the paper-cut backdrop and presses **Play**; with the Learn lessons unfinished (`progress.tutorialDone` false) it starts Learn. Lesson 1 ("Choosing a color", 8×8 bands) shows a coach banner above the board: *pick colour 1* → *tap a "1" region* → *fill every remaining "1"* → a note acknowledged by tapping the banner (or Enter on it). Each step advances only on the real action. Lesson 2 teaches refusal and undo; lesson 3 finishes a piece to the results; **Play again** there ends the tutorial and returns to the title ("Tutorial complete — Journey is ready."). Afterwards Play opens the next journey stage. Settings → *Replay tutorial* runs it again.

Session shape: title → (setup dialog / journey map) → round → results (shown 1.2 s after the last fill, 0.2 s with reduced motion) → *Next stage* / *Play again* / *Replay* / *Leaderboard* / *Home*. Leaving a round (Pause → Leave round) keeps it: the title offers **Continue** with the piece name and progress.

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

**Stars** (`js/store.js` `starCount`): 1 for completion, +1 if `invalid = 0` and `hints ≤ 1`, +1 if `elapsedMs ≤ par.timeMs`.

**Tie-break** (`compareResults`): completion fraction, fewer invalid, lower elapsed, session id. Server boards sort by `score` desc, `elapsedMs` asc, session id.

**RNG / seeding.** `rngFromSeed` = mulberry32 over FNV-1a of the seed string. Levels use `'level:' + seed`; the generator, theme and shape parameters all come from that stream, so `(seed, tier, genId)` reproduces the board exactly. Seeds: `journey/N`, `daily/YYYY-MM-DD`, `tutorial/N`, `practice/<base36 time>`, `challenge/<variant>`, `score/<player seed>`.

**Replay.** `replay(level, opts, commands)` re-applies a log and returns periodic `hashState` values (every 10 ticks). `hashState` JSON-serialises the truth vector (`v, levelId, seed, mode, tick, selected, filled, moves, invalid, hints, undos, elapsedMs, remainingMoves, status, terminalReason, fills`).

**Undo/hints availability** is per level (`level.mechanics`) and per mode; the Actions card disables the buttons when a rule forbids them.

## 5. Modes and progression

| Mode | Entry | Board | Mechanics | Ranked | Owner |
|---|---|---|---|---|---|
| Learn | title *Learn*, first *Play*, Settings → Replay tutorial | three fixed Sprout lessons (`tutorial/1..3`, generators bands/sunrise/bloom) | hints + undo | no | `startLearn`, `startLesson`, `tutorial*` |
| Journey | title *Journey* → 40-stage map, or *Play* once the tutorial is done | `journey/N`; tier = 1 + floor((N−1)/8) | stages 15/21/28/36 add a move limit (ceil(cells×1.15)); hints off from 23; undo off from 31; every 8th stage is Mastery (no hints, limit ceil(cells×1.1)) | no | `journeyStages`, `startJourneyStage` |
| Daily | title *Daily* → setup card | `daily/YYYY-MM-DD` (UTC, by the platform's clock (`serverNow`), else the device's); tier = 2 + hash%4 | hints + undo, move limit ceil(cells×1.2) | yes, board `daily-<date>` | `dailyInfo`, `dailyLevel` |
| Practice | title *Practice* → tier select, hints/undo toggles | `practice/<time>` at chosen tier | as chosen | no | setup dialog |
| Challenge | title *Challenge* → variant | `moves`: Thicket, limit ceil(cells×1.05), no hints · `speed`: Thicket, no undo · `elder`: Elder, no hints/undo | per variant | yes, `challenge-<variant>` | setup dialog |
| Score chase | title *Score chase* → seed text + tier | `score/<seed>` | hints + undo | yes, `score-<seed>` | setup dialog |

Journey unlocks sequentially (`journeyMap`); best score and stars per stage persist in the game's save. Achievements (`ACHIEVEMENTS`, `recordCompletion`): First Haven (first completion), Clean Hands (no slips/hints/undos), Three Dawns (daily on 3 distinct dates), Elder Artist (tier 5 completion), Long Road (25 journey stages). The title shows journey progress, today's daily tier, guest id and achievement count.

## 6. Controls and interaction

Actions are declared in `starhermit.txt`; players rebind keys and pads in the runtime's Options (Settings → *Change keys and buttons* opens it).

| Action | Keys | Pad | Touch / pointer | Effect |
|---|---|---|---|---|
| `left` `right` `up` `down` | arrows | D-pad, left stick | — | move the focus ring (wraps); announces "Region N, needs color X" |
| `fill` | Enter, Space | South (A) | tap a region (within 12 px and 500 ms) | fill the focused / tapped region with the selected colour |
| `color1`…`color8` | 1–8 (and numpad) | — | tap a palette button | select that colour |
| `color_prev` / `color_next` | Q / E | LB / RB | — | step to the previous / next colour with regions left (new for pads, which had no way to pick a colour) |
| `undo` | U | West (X) | Undo button | lift the last player fill |
| `hint` | H | North (Y) | Hint button | fill a region for −25 points |
| `recenter` | C | right stick press | Re-center button | re-frame the board (it always fits; nothing pans) |
| `pause` | P | Start | Pause button | pause dialog |
| `cancel` | Escape | East (B) | — | pause in a round; closes the innermost dialog (the pause dialog resumes) |

The pointer's hover ghosts the region's colour (bright when it matches the selection). Wrong colour: the tile wobbles, a thud plays, a toast names the colour needed, an assertive announcement, a 60 ms vibration (haptics on). Game actions act only in a round with no dialog open; arrows and Enter clear UI focus so they steer the board, and Enter on a focused button activates that button instead. All dialogs and buttons work by keyboard, pad (UI navigation) and touch.

## 7. Screens and layout

- **Title**: backdrop art (cover-fitted, cream wash; plain paper under high contrast), drifting cut-paper petals on looks with ambient motion (not with reduced motion or high contrast), a card with the title, tagline, Continue (when a round is saved), Play, the six mode buttons (three columns, two below 420 px), Settings, Help, Invite a friend (signed in), Sign in with StarHermit (guests), the profile line (`Playing as … · progress synced / saving… / cloud sync pending` or `Local play · Guest <id>`) and achievements/illustrations count. The card scrolls when the window is short.
- **Round**: top bar (palette mark, "Color Haven", "<mode> — <piece>", Help, Settings, Pause), the Objective card (piece, tier · size · colours · move limit, progress bar, moves left or par time), the Session card (time, filled, slips, hints), the playfield with the coach banner in its own band above the board and the toast at its foot, the Actions card (Undo, Hint, Re-center, Restart with key chips; one column when labels don't fit beside their keys), the Score preview card, and the palette tray (number, symbol, regions left or "done", colour bar; selected outlined in focus blue; left-handed reverses it).
  - **Wide** (≥ 1024 px wide, or landscape ≥ 800 px): the cards in rails beside the board (rails scroll when short).
  - **Stacked** (other windows): the four cards in rows under the board (up to four a row, min 224 px each).
  - **Phone portrait** (≤ 640 px wide): the Objective card above the board, Actions below it; Session and Score preview are left out (as in the browser build); no status text in the top bar.
  - **Short landscape** (≤ 500 px tall): 152 px rails with compact cards, the coach banner docked left of the board.
  The 3D view fills the window behind the UI and is framed into the playfield (`setViewOffset`); the page colour masks around it with 14 px rounded corners.
- **Dialogs** (modal, the board's clock stops under them): mode setup (facts; Practice difficulty select and hints/undo checkboxes; Challenge variant choices; Score chase seed text field and size select; Start / Back), journey map (40 stage buttons with drawn stars, open ring or lock; mastery stages outlined), results (headline, piece · mode · time, results art on completion when the window is taller than 500 px, the score breakdown table, unlocked achievements, local-board rank, platform-board line; Next stage or Play again, Replay, Leaderboard for ranked rounds, Home in a pinned footer), pause (Resume, Settings, Help, Leave round), settings, help (six cards incl. the eight drawn symbols), leaderboard (local board for the round's board id: rank, player, score, time, slips). Long dialogs scroll their body; their buttons stay pinned below.
- **Toasts**: the round's toast (hints, slips; 2.6 s), the page toast (invite copied, tutorial complete, signed out; 3.5 s), the caption strip when *Text cues for sounds* is on.

## 8. Art direction

**Palette (style tokens / `THEMES` / palettes):** background `#f6ead8`, panel `#fdf8ef`, panel edge `#e2d2b8`, ink `#3d332a`, soft ink `#7a6c5c`, accent coral `#d96f4e`, focus blue `#2f6fd0`, danger `#b5452e`. Five board themes set backdrop/table/frame/paper/key-light: Daybreak `#f6ead8/#e8d9c0/#b98d5e`, Meadow `#e4ecd8/#d2dfc0/#7d9a5c`, Harbor `#dde8ee/#c9d8e2/#5d7f95`, Dusk `#e6dcea/#d5c8dd/#7a5f8e`, Ember `#f0ddd2/#e2c9b8/#9e5f46`. Pigments: Coral `#e0604e`, Amber `#e8a33d`, Leaf `#5f9e52`, Sky `#5d9fd6`, Violet `#8e6cc9`, Rose `#d96f9e`, Teal `#3fa39a`, Cocoa `#8a6247`; CVD set (Okabe–Ito) `#e69f00 #56b4e9 #009e73 #f0e442 #0072b2 #d55e00 #cc79a7 #4d4d4d`. High contrast is the runtime's (it forces the UI's colours).


**Board.** Flat cut-paper layers: tiles are 0.94-unit boxes (bevelled with paper grain and a bump map on detailed looks) stacked 0.05 units per palette index; a 0.34-unit frame of four wooden slats; a 120-unit linen table. An orthographic camera 52° above the board at 1.55× the diagonal, the board fitted with an 8 % margin. Region numbers are drawn on one canvas overlay (42 % of the cell, bold, opaque ink; the symbol below), redrawn only for cells whose fill changed; filled tiles carry a light symbol watermark. Lights take the three.js intensities ÷ π: hemisphere 0.75 (0.3 with studio light), warm key directional 1.6 with soft shadows, cool rim 0.35; ACES tone mapping at 1.05 (0.92 with studio light). Studio light is `PMREMGenerator(renderer).fromScene(new RoomEnvironment(renderer), 0.04)` with the old per-material `envMapIntensity` (paper 0.3, frame 0.6, table 0.15). Post: `renderer.ao` (radius 0.45), `renderer.grade` (display-space warm grade, S-curve, +7 % saturation, 0.2 vignette), `renderer.antialias`. No bloom (pillar 1).

**Motion.** Fill: 260 ms ease-out drop with 10 pigment puffs; undo: 4 puffs; invalid: 300 ms wobble; complete: 6 bursts of 24 puffs; ambient: dust motes drift up through the light and the key light drifts and breathes. Reduced motion (the runtime's preference) drops tweens, puffs, ambient motion and the title petals and shortens the results delay.

**Graphics levels** (`native/quality.ts`; the runtime's Options choose the level, render scale, frame-rate limit; it holds shadow-map size and MSAA samples to the level). The old presets map to the runtime's quality tiers; counts scale within a tier with the level (×1.64 a level, ≤ 4×):

| | low | balanced | high | ultra |
|---|---|---|---|---|
| shadows | off | 1024 | 2048 | 4096 |
| ambient occlusion | off | off | on | high |
| grade / studio light / paper detail / ambient motion | off | on | on | on |
| anti-aliasing | off | FXAA | SMAA | MSAA |
| materials | Lambert | standard | standard | standard (the old Ultra paper sheen is not drawn by the engine) |
| grain px (paper / linen / wood) | 64/64/128 | 128/128/256 | 128/128/256 | 256/256/512 |
| bevel segments, overlay px per cell | 1, 64 | 1, 80 | 2, 96 | 3, 128 |
| puffs, motes (at the tier's first level) | 0, 12 | 300, 24 | 800, 36 | 1200, 60 |

## 9. Audio

`native/audio.ts`: the authored one-shots in `sfx/` mapped by `sfx/manifest.json` (ui tick, palette select, four paint strokes picked at random, paper undo, hint chime, invalid thud, level complete, moves exhausted, achievement chime, board unfold at round start, colour complete, tutorial page), the studio room tone (`ambience-studio.opus`) looping through a round (fades in over 1.2 s), and the pentatonic pad (C D E G A C': a note every 2.4 s, one to three voices as the picture fills) rendered once into clips. Buses: music → `music`, effects and ambience → `effects`, the menu tick → `interface`; volumes, mute and the voice limit are the runtime's Options; the old default bus levels (music 60 %, effects 80 %, ambience 40 %) are folded into the gains. Clips load one at a time once the mixer runs (in browsers after the first press). *Text cues for sounds* shows a caption strip and announces "♪ <cue>" for meaningful sounds (region filled, hint used, wrong region, colour complete, illustration complete, out of moves, achievement).

## 10. Localization

Nine locales (en-US, en-GB, es-419, es-ES, de-DE, fr-FR, fr-CA, pt-BR, it-IT); English text is the key (`js/strings.js`, regional tables carry differences; en-GB spelling derived). The locale follows the runtime's interface language (`preferences().language`: Options › Language, else the account's preferred language, else the device's) and switches live; account lines come from `js/platform-strings.js`. `tests/i18n.test.mjs` checks every key `native/*.ts`, the captions and the content use is translated with intact placeholders, and that no table keeps an unused key.

## 11. Accessibility

Every control is a UI widget with a name (palette buttons: "Color N, name, K regions left"; journey stages: "Stage N, title, best B, S stars" / "locked"), keyboard, pad and touch navigable with a visible focus ring; announcements for selection, focus moves, slips (assertive), colour completion, round start/end. Numbers never rely on colour: number + drawn symbol + swatch everywhere, and the colour-vision-safe palette (Settings) swaps the board's and tray's colours live. The runtime provides interface size, text size, high contrast and reduced motion (the UI follows them; high contrast hides the backdrop and petals). Left-handed tray and haptics (vibration on fills and slips) are game settings.

## 12. StarHermit integration

- **Save**: `{ v: 1, progress }` through `saves` (device at once, the account's cloud slot debounced by the runtime). Conflicts merge with `mergeProgress` (higher best and stars per stage, earliest unlock per achievement, every daily day, larger finished count, a finished tutorial, this device's guest id). An account save that replaced the device's is merged in.
- **Browser-build migration**: the old JS-SDK slot `game:color-haven` (a zip whose `save.json` is `{ progress }`) shows as a foreign save; `fromBrowserSave` reads it (a player with finished pictures counts as having done Learn, whose flag lived in the device's settings), merges it with this device's progress and saves with `replaceForeign`. The old per-player settings keys are read through `settings.legacyKeys()`: `captions`, `cvdPalette`, `leftHanded`, `haptics` carry over (unless set since); all known old keys (volumes, graphics, reduced motion, high contrast, larger text — now the runtime's) are removed. Guests' old browser localStorage (progress, settings, snapshot, local boards) cannot migrate.
- **Game settings** (`settings`, `game.<key>`, synced with the account): `captions`, `cvdPalette`, `leftHanded`, `haptics`.
- **Device storage** (`storage`): the round snapshot `colorhaven.snapshot.v2` and the local boards `colorhaven.board.<id>` (top 100 each, at most 40 boards, oldest played dropped; the replay envelope is not kept on the device).
- **Leaderboard**: a completed ranked round (Daily, Challenge, Score chase) is added to the local board for its id (results show "Leaderboard rank: #N (local board)") and, signed in, posts its total to the platform `high-score` board through `score-script.js` (a practice session whose socket carries `{ type: 'result', scores }`); the results then show the rank or "Score posted / not posted".
- **Player**: the profile line, the board name (display name, else "Guest <id>"), Invite a friend (copies the invite link; `clipboard`), Sign in (`requestSignIn`), a "signed out" toast when the session ends.
- **Clock**: the daily's date uses `serverNow()` once the platform's clock answered, else the device's UTC date. The round clock counts the runtime's fixed steps (60 a second) and stops under dialogs and while the window is suspended; the save is flushed on suspend.

## 13. Checks

- `npm test` = `test:unit` + `test:native`.
  - `tests/rules.test.mjs` (1421 assertions: RNG, generation/validation, journey, dailies, every command path, terminals, scoring, replay, tie-breaks).
  - `tests/store.test.mjs` (`node --test`): merge, the engine document, the browser cloud save as foreign text, settings keys, completion records and stars, journey map, snapshot round-trip and refusals, local boards (ranking, no envelope, board cap).
  - `tests/i18n.test.mjs`: translations complete and unused rows gone; the classic `js/i18n.js` switches locale.
  - `tests/native.mjs`: the committed web index matches the files, `tsc` (TypeScript 5.9, no skipLibCheck), `starhermit check .` with no warnings, then every `tests/native/*.play` as a guest `--render-check`: `learn.play` (Play → three lessons → results → title), `journey-first-stage.play` (map → stage 1 with a slip, undo and hint → results → stage 2), `challenge-ledger.play` (Strict ledger 16×16 → results → local leaderboard → Home), `screens.play` (settings toggles, help, pause and its dialogs, leave and Continue, Score chase with a typed seed, journey map closed by Escape). The board scripts are generated from the content by `tools/gen-play.mjs` (`npm run plays`).
- `npm run test:browser` (`tools/browser-play.mjs`): the packaged loader in headless Chrome at 1366×768, 390×844 and 844×390: title, Learn by keys, fill, hint, pause/resume, board and tray taps; fails on console errors/warnings or the runtime's error screen. `~/games/tools/engine-web-smoke.mjs` loads it at desktop and phone.
- `npm run test:server` (`tests/server.smoke.mjs`, against `node server.js 8091`): the dev server's board API.
- `npm run package` writes `index.html` + `starhermit-files.json` (run after the last change); `npm run css` converts the style sheet.

## 14. Asset inventory

| Path | Purpose | Source | Status |
|---|---|---|---|
| `coverart.png` (1200×675) | store cover: paper-cut sunrise + title | FLUX.2 klein seed 3601, text via ffmpeg drawtext, 256-colour PNG | shipped |
| `assets/title-backdrop.webp` (1536×864) | title-screen backdrop | FLUX.2 klein seed 3602 | shipped (title screen) |
| `assets/results-studio.webp` (768×512) | results illustration on completion | FLUX.2 klein seed 3603 | shipped (results dialog) |
| `icon.png` | platform icon | hand-authored | shipped |
| `sfx/ui-tick.opus` … `sfx/achievement-chime.opus` (12 clips) | event one-shots (table §9) | MOSS-SFX v2, 100 steps | shipped |
| `sfx/board-unfold.opus` | round start | MOSS-SFX v2 | shipped |
| `sfx/color-complete.opus` | colour finished | MOSS-SFX v2 | shipped |
| `sfx/tutorial-page.opus` | tutorial step | MOSS-SFX v2 | shipped |
| `sfx/ambience-studio.opus` (12 s loop) | round ambience | MOSS-SFX v2 | shipped |
| 3D models / character animation | — | — | not called for (procedural board, no characters) |

## 15. Known limitations

- Per-seed leaderboards are local to the device; the replay-validating board API in `server.js` is not called by the client. The platform `high-score` board is one board across all ranked modes and seeds.
- The round clock starts with the round's first command (the first command's elapsed delta is 0), as before.
- `replay(level, opts, commands, 0)` records no periodic hashes; no shipped caller passes 0.
- The number overlay is part of the ambient-occlusion pass (the engine has no per-object AO exclusion); Ultra's paper sheen is not drawn.
- The browser build's dev URL hooks (`?autostart=…`, `?screen=…`) and per-category graphics overrides are gone (the runtime's Options choose a graphics level; play scripts drive the screens).
