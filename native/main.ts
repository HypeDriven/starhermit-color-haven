// Color Haven on the StarHermit engine: the entry module (starhermit.txt
// engine.entry), played natively by the StarHermit client and in browsers
// by the engine's web runtime. The rules (js/rules.js), content
// (js/content.js), session with its replay envelope (js/session.js) and
// save model (js/store.js) are the browser build's, unchanged in what they
// decide; this module is what js/main.js did around them — the state
// machine (title → mode setup / journey map / learn → the round ⇄ pause →
// results → next stage / replay / home), the round lifecycle with its
// autosaved snapshot (Continue on the title), the event presentation (a
// sound, a toast or announcement and a board animation per rules event),
// the Learn lessons' coach banner driven by the same commands as play, the
// focus ring moved by keys and pads, taps on the board, the palette picks,
// Undo, Hint and Re-center, the results with stars, achievements, the
// local board and posting to the high-score board, and the lifecycle (a
// hidden window pauses the round, as the browser build's visibilitychange
// did). The screens and HUD are drawn by screens.ts (starhermit:ui), the
// paper board by render.ts (starhermit:scene).
//
// Time is the runtime's fixed steps (60 a second): the session's clock
// (GameSession.clock) counts them, so pauses, a hidden window and slow
// frames never cost time and play scripts replay exactly.
import { clipboard, frame, onFixedUpdate, onPreferencesChange, onRender, onResume, onStart, onSuspend, onUpdate, preferences, setFixedRate } from "starhermit:engine";
import { onAction, onPointerButton, onPointerMove, onTouch, vibrate } from "starhermit:input";
import * as ui from "starhermit:ui";
import { onSessionEnded, requestSignIn } from "starhermit:platform";
import { TERMINAL, hashString, listLegalActions } from "../js/rules.js";
import { THEMES, TIERS, dailyInfo, dailyLevel, generateLevel, journeyLevel, paletteFor, tierSpec, tutorialLessons } from "../js/content.js";
import { GameSession } from "../js/session.js";
import * as S from "../js/store.js";
import * as audio from "./audio.ts";
import { N, pt, tr } from "./i18n.ts";
import * as platform from "./platform.ts";
import { lookFor } from "./quality.ts";
import * as render from "./render.ts";
import { drawScreens } from "./screens.ts";
import { initStyles } from "./style.ts";

export type Level = ReturnType<typeof generateLevel>;
export type Session = GameSession;
export type Mode = "learn" | "journey" | "daily" | "practice" | "challenge" | "score";
export type OverlayName = "setup" | "journey" | "results" | "pause" | "settings" | "help" | "scores";
export type Stage = ReturnType<typeof S.nextJourneyStage>;
type Lesson = ReturnType<typeof tutorialLessons>[number];
type Achievement = ReturnType<typeof S.recordCompletion>[number];
export interface SetupConfig { mode: "daily" | "practice" | "challenge" | "score"; tier: number; hints: boolean; undo: boolean; variant: "moves" | "speed" | "elder"; seed: string }
export interface Tutorial { lesson: Lesson; lessons: Lesson[]; lessonIdx: number; stepIdx: number; count: number; done?: boolean }
export interface Results { session: Session; level: Level; mode: Mode; newAchievements: Achievement[]; rankRes: { ok: boolean; rank: number; local: boolean } | null }
export interface BoardEntry { name: string; score: number; elapsedMs: number; invalid: number; sessionId: string }

const STEP_MS = 1000 / 60;
let steps = 0;
(GameSession as unknown as { clock: (() => number) | null }).clock = () => steps * STEP_MS;

export const app = {
  screen: "title" as "title" | "game",
  /** Open dialogs, innermost last (Settings and Help open over Pause). */
  overlays: [] as OverlayName[],
  /** Frame the screen or top dialog opened on (the press that opened it must not also act on it). */
  openedFrame: 0,
  focusNext: null as string | null,
  setup: null as SetupConfig | null,
  /** The coach banner above the board: its text (re-read in the current language), tappable when it has an action. */
  banner: null as { text: () => string; action: (() => void) | null; until: number | null } | null,
  toast: null as { text: () => string; until: number } | null,
  pageToast: null as { text: () => string; until: number } | null,
  caption: null as { text: string; until: number } | null,
  results: null as Results | null,
  resultsAt: null as number | null,
  lb: null as { state: "lbPosting" | "lbRank" | "lbPosted" | "lbNotPosted"; rank?: number | null } | null,
  boardEntries: [] as BoardEntry[],
};
export const settings = platform.settings;
export let session: Session | null = null;
export let level: Level | null = null;
export let mode: Mode | null = null;
export let palette: ReturnType<typeof paletteFor> = [];
export let ranked = false;
export let boardId: string | null = null;
export let tutorial: Tutorial | null = null;
export let focusCell = -1;
let suspended = false;
export const now = (): number => frame().time;

// ------------------------------------------------------------------ text helpers
export function formatMs(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
/** A level's title in the game language (level data keeps the English title). */
export function levelTitle(l: { id: string; title: string } | null): string {
  if (!l) return "";
  const id = String(l.id || "");
  if (id.startsWith("daily-")) return tr("Daily — {date}", { date: id.slice(6) });
  const ch = /^challenge-(moves|speed|elder)$/.exec(id);
  if (ch) return tr("Challenge — {variant}", { variant: tr(({ moves: N("moves"), speed: N("speed"), elder: N("elder") } as Record<string, string>)[ch[1]!]!) });
  if (id.startsWith("score-")) return tr("Seed “{seed}”", { seed: id.slice(6) });
  return tr(l.title);
}
export function modeLabel(m: Mode | null): string {
  const L: Record<string, string> = { learn: N("Learn"), journey: N("Journey"), daily: N("Daily"), practice: N("Practice"), challenge: N("Challenge"), score: N("Score chase") };
  return m && L[m] ? tr(L[m]!) : String(m ?? "");
}
export function announce(text: string, assertive = false): void {
  if (text) ui.announce(text.slice(0, 500), { politeness: assertive ? "assertive" : "polite" });
}
/** The round's toast (2.6 s), over the board; `text` re-reads in the current language. */
export function toast(text: () => string, seconds = 2.6): void { app.toast = { text, until: now() + seconds }; }
/** A short confirmation on any screen (3.5 s). */
export function pageToast(text: () => string): void { app.pageToast = { text, until: now() + 3.5 }; announce(text()); }
export function banner(text: (() => string) | null, seconds: number | null = null, action: (() => void) | null = null): void {
  app.banner = text ? { text, action, until: seconds == null ? null : now() + seconds } : null;
}
function haptic(ms: number): void { if (settings.haptics) vibrate(ms); }
export function progress(): platform.Progress { return platform.progress(); }
export function today(): ReturnType<typeof dailyInfo> { return dailyInfo(platform.nowMs()); }

// ------------------------------------------------------------------ navigation
export function topOverlay(): OverlayName | null { return app.overlays[app.overlays.length - 1] ?? null; }
export function openOverlay(name: OverlayName, focus: string | null = null): void {
  if (app.overlays.includes(name)) return;
  app.overlays.push(name);
  app.openedFrame = frame().frame;
  app.focusNext = focus;
  ui.setFocus(null);
}
export function closeOverlay(name?: OverlayName): void {
  const o = name ?? topOverlay();
  if (!o) return;
  app.overlays = app.overlays.filter((x) => x !== o);
  app.openedFrame = frame().frame;
  if (!app.overlays.length && app.screen === "game") ui.setFocus(null);
}
export function toTitle(): void {
  teardownRound();
  app.overlays = [];
  app.screen = "title";
  app.openedFrame = frame().frame;
  app.focusNext = readSnapshot() ? "btn-continue" : "btn-play";
  ui.setFocus(null);
  render.clear();
  render.setActive(false);
}
export function uiTick(): void { audio.play("uiTick"); }

// ------------------------------------------------------------------ mode setup
export function openMode(m: Mode): void {
  uiTick();
  switch (m) {
    case "learn": startLearn(); return;
    case "journey": openOverlay("journey", null); return;
    case "daily": app.setup = { mode: "daily", tier: today().tier, hints: true, undo: true, variant: "moves", seed: "" }; break;
    case "practice": app.setup = { mode: "practice", tier: 2, hints: true, undo: true, variant: "moves", seed: "" }; break;
    case "challenge": app.setup = { mode: "challenge", tier: 3, hints: false, undo: true, variant: "moves", seed: "" }; break;
    case "score": app.setup = { mode: "score", tier: 3, hints: true, undo: true, variant: "moves", seed: "gallery-" + String(hashString(String(platform.nowMs())) % 100000) }; break;
  }
  openOverlay("setup", "btn-setup-start");
}
export function startFromSetup(): void {
  const cfg = app.setup;
  if (!cfg) return;
  app.overlays = [];
  switch (cfg.mode) {
    case "daily": {
      const info = today();
      startGame(dailyLevel(platform.nowMs()), "daily", { ranked: true, boardId: "daily-" + info.date });
      break;
    }
    case "practice": {
      const seed = "practice/" + platform.nowMs().toString(36);
      const l = generateLevel({ id: "practice-" + seed, seed, tier: cfg.tier, mechanics: { hints: cfg.hints, undo: cfg.undo }, title: "Practice piece" });
      startGame(l, "practice", { ranked: false });
      break;
    }
    case "challenge": {
      let spec: { tier: number; mechanics: Record<string, unknown> };
      if (cfg.variant === "moves") spec = { tier: 3, mechanics: { hints: false, undo: true, moveLimit: Math.ceil(tierSpec(3).size ** 2 * 1.05) } };
      else if (cfg.variant === "speed") spec = { tier: 3, mechanics: { hints: true, undo: false } };
      else spec = { tier: 5, mechanics: { hints: false, undo: false } };
      const l = generateLevel({ id: "challenge-" + cfg.variant, seed: "challenge/" + cfg.variant, tier: spec.tier, mechanics: spec.mechanics, title: "Challenge — " + cfg.variant });
      startGame(l, "challenge", { ranked: true, boardId: "challenge-" + cfg.variant });
      break;
    }
    case "score": {
      const seed = cfg.seed.trim() || "gallery";
      const l = generateLevel({ id: "score-" + seed, seed: "score/" + seed, tier: cfg.tier, title: "Seed “" + seed + "”" });
      startGame(l, "score", { ranked: true, boardId: "score-" + seed });
      break;
    }
  }
}
/** Title › Play: the lessons first, then the next journey stage. */
export function play(): void {
  uiTick();
  if (!progress().tutorialDone) { startLearn(); return; }
  startJourneyStage(S.nextJourneyStage(progress()));
}
export function startLearn(): void {
  const lessons = tutorialLessons();
  startLesson(lessons[0]!, lessons, 0);
}
function startLesson(lesson: Lesson, lessons: Lesson[], lessonIdx: number): void {
  // startGame() tears the previous round down (which clears the tutorial), so the lesson is installed after.
  startGame(lesson.level, "learn", { ranked: false });
  tutorial = { lesson, lessons, lessonIdx, stepIdx: 0, count: 0 };
  tutorialStep();
}
export function startJourneyStage(stage: Stage): void {
  startGame(journeyLevel(stage), "journey", { ranked: false });
}

// ------------------------------------------------------------------ the round
const theme = (l: Level): typeof THEMES[number] => THEMES.find((t) => t.id === l.theme) || THEMES[0]!;
function buildBoard(): void {
  if (!level || !session) return;
  render.buildBoard(level, palette, theme(level));
  render.syncState(session.state, []);
  render.setFocusCell(focusCell);
}
export function startGame(l: Level, m: Mode, opts: { ranked?: boolean; boardId?: string | null; session?: Session | null } = {}): void {
  teardownRound();
  app.overlays = [];
  app.results = null;
  app.resultsAt = null;
  app.lb = null;
  level = l;
  mode = m;
  ranked = !!opts.ranked;
  boardId = opts.boardId ?? null;
  session = opts.session ?? new GameSession(l, { mode: m });
  palette = paletteFor(l, settings.cvdPalette);
  focusCell = Math.floor(l.targets.length / 2);
  app.screen = "game";
  app.openedFrame = frame().frame;
  app.focusNext = null;
  ui.setFocus(null);
  render.setActive(true);
  buildBoard();
  const s = session;
  s.onChange((state: Session["state"], events: { type: string; [k: string]: unknown }[]) => onSessionChange(s, state, events));
  if (m !== "learn") banner(() => tr("Fill every numbered region. No timer, no losing."), 2.6);
  audio.startRound();
  audio.setMusicIntensity(0.2);
  audio.play("roundStart");
  saveSnapshot();
  announce(tr("Started {title}. {n} colors. Pick a color in the tray.", { title: levelTitle(l), n: palette.length }));
}
function teardownRound(): void {
  session = null;
  tutorial = null;
  app.banner = null;
  app.toast = null;
  audio.stopRound();
}
export function restartRound(): void {
  if (!level || !mode) return;
  uiTick();
  if (mode === "learn" && tutorial) { startLesson(tutorial.lesson, tutorial.lessons, tutorial.lessonIdx); return; }
  startGame(level, mode, { ranked, boardId });
}
export function leaveRound(): void {
  saveSnapshot();
  toTitle();
}
export function pauseGame(): void {
  if (app.screen !== "game" || !session || session.isOver || app.overlays.length) return;
  openOverlay("pause", "btn-resume");
  announce(tr("Paused"));
}
export function resumeGame(): void {
  app.overlays = [];
  app.openedFrame = frame().frame;
  ui.setFocus(null);
  announce(tr("Resumed"));
}
/** The session's clock stops under any dialog and while the window is hidden (the browser build paused it there). */
function syncPause(): void {
  if (!session || session.isOver) return;
  const want = suspended || app.overlays.length > 0;
  if (session.paused !== want) session.setPaused(want);
}

// ------------------------------------------------------------------ the snapshot
function saveSnapshot(): void {
  if (!session || session.isOver || mode === "learn") return;
  S.saveSnapshot(platform.ls, { ranked, boardId, session });
}
export function readSnapshot(): { ranked: boolean; boardId: string | null; snap: { level: Level; state: { filled: number; total: number } } } | null {
  return S.readSnapshot(platform.ls);
}
/** Resume the autosaved round. */
export function resumeSnapshot(): void {
  uiTick();
  const wrap = readSnapshot();
  const s = wrap && GameSession.restore(wrap.snap);
  if (!wrap || !s || s.isOver) { S.clearSnapshot(platform.ls); return; }
  startGame(s.level, s.mode as Mode, { ranked: !!wrap.ranked, boardId: wrap.boardId || null, session: s });
  const st = s.state;
  banner(() => tr("Resumed — {filled} of {total} regions already filled.", { filled: st.filled, total: st.total }), 2.6);
  announce(tr("Round resumed."));
}

// ------------------------------------------------------------------ session events
function onSessionChange(s: Session, state: Session["state"], events: { type: string; [k: string]: unknown }[]): void {
  if (s !== session || !level) return;
  render.syncState(state, events as render.Ev[]);
  audio.setMusicIntensity(0.2 + s.progress * 0.8);
  saveSnapshot();
  for (const ev of events) {
    switch (ev.type) {
      case "select": {
        audio.play("select");
        const c = ev.color as number;
        announce(tr("Color {n}, {name} selected", { n: c + 1, name: tr(palette[c]!.name) }));
        break;
      }
      case "fill":
        audio.play("fill");
        haptic(12);
        checkColorComplete(state, ev.color as number);
        break;
      case "hint":
        audio.play("hint");
        toast(() => tr("Hint placed a region for you (−25 pts)"));
        checkColorComplete(state, ev.color as number);
        break;
      case "undo":
        audio.play("undo");
        break;
      case "invalid": {
        audio.play("invalid");
        haptic(60);
        const need = ev.need as number;
        const text = (): string => tr("That region needs color {n} ({name})", { n: need + 1, name: tr(palette[need]!.name) });
        toast(text);
        announce(text(), true);
        break;
      }
      case "complete":
        audio.play("complete");
        endRound();
        break;
      case "ended":
        audio.play("movesExhausted");
        endRound();
        break;
    }
    if (tutorial) tutorialEvent(ev);
  }
}
/** The fill that just landed emptied its colour: cue it. */
function checkColorComplete(state: Session["state"], color: number): void {
  if (state.status !== "active" || color == null || !level) return;
  if (listLegalActions(state, level).fillableFor[color] === 0) {
    audio.play("colorComplete");
    announce(tr("Color {n}, {name} complete", { n: color + 1, name: tr(palette[color]!.name) }));
  }
}

function endRound(): void {
  const s = session!, l = level!, m = mode!;
  const st = s.state;
  const sc = s.scoreBreakdown;
  S.clearSnapshot(platform.ls);
  const newAch = S.recordCompletion(progress(), {
    mode: m, level: l, state: st, scoreTotal: sc.total, dateIso: m === "daily" ? today().date : null,
    nowIso: new Date(platform.nowMs()).toISOString(),
  });
  platform.persist();
  if (newAch.length) audio.play("achievement");
  let rankRes: Results["rankRes"] = null;
  const completed = st.terminalReason === TERMINAL.COMPLETED;
  if (ranked && completed && boardId) {
    const p = progress();
    const name = platform.signedIn() ? platform.displayName() : "Guest " + (p.playerId || "anon"); // stored board name (not localized)
    rankRes = S.submitScore(platform.ls, boardId, {
      name, playerId: platform.userId() ?? undefined, score: sc.total, elapsedMs: st.elapsedMs, invalid: st.invalid,
      sessionId: s.sessionId, levelId: l.id, contentV: l.v, seed: l.seed,
      assists: { hints: st.mechanics.hints, undo: st.mechanics.undo },
    });
  }
  app.results = { session: s, level: l, mode: m, newAchievements: newAch, rankRes };
  postToLeaderboard(ranked && completed, sc.total);
  announce(completed ? tr("Complete! Score {n}.", { n: sc.total }) : tr("Out of moves."), true);
  app.resultsAt = now() + (preferences().reducedMotion ? 0.2 : 1.2);
}
/** Signed in only: a completed ranked round posts its total; the results show the rank. */
function postToLeaderboard(eligible: boolean, total: number): void {
  app.lb = null;
  if (!eligible || !platform.signedIn()) return;
  const line = { state: "lbPosting" as const };
  app.lb = line;
  void platform.postLeaderboard(total).then((r) => {
    if (app.lb !== line) return;
    app.lb = { state: !r.posted ? "lbNotPosted" : r.rank ? "lbRank" : "lbPosted", rank: r.rank };
  });
}
export function showBoard(): void {
  if (!boardId) return;
  uiTick();
  app.boardEntries = S.fetchBoard(platform.ls, boardId) as BoardEntry[];
  openOverlay("scores", "btn-scores-close");
}
export function resultsNext(): void {
  uiTick();
  if (mode === "journey") startJourneyStage(S.nextJourneyStage(progress()));
  else if (mode === "learn" && tutorial) {
    const next = tutorial.lessonIdx + 1;
    if (next < tutorial.lessons.length) startLesson(tutorial.lessons[next]!, tutorial.lessons, next);
    else {
      progress().tutorialDone = true;
      platform.persist();
      toTitle();
      pageToast(() => tr("Tutorial complete — Journey is ready."));
    }
  } else {
    const m = mode;
    toTitle();
    if (m) openMode(m === "learn" ? "journey" : m);
  }
}

// ------------------------------------------------------------------ the Learn lessons
function tutorialStep(): void {
  const t = tutorial;
  if (!t) return;
  const step = t.lesson.steps[t.stepIdx];
  if (!step) return;
  tutorialBanner();
  if (t.stepIdx > 0) audio.play("tutorialStep"); // step 0 lands with the board-unfold cue
  announce(tr(step.text));
}
function tutorialBanner(): void {
  const t = tutorial;
  if (!t) return;
  if (t.done) { banner(() => tr("Lesson complete! Tap to continue."), null, () => resultsNext()); return; }
  const step = t.lesson.steps[t.stepIdx];
  if (!step) return;
  const ack = step.require == null;
  banner(() => tr(step.text) + (ack ? "  " + tr("(tap this message to continue)") : ""), null, ack ? () => tutorialAdvance() : null);
}
function tutorialAdvance(): void {
  const t = tutorial;
  if (!t) return;
  const finished = t.lesson.steps[t.stepIdx];
  t.stepIdx++;
  t.count = 0;
  if (t.stepIdx >= t.lesson.steps.length) {
    // Lesson done: its completion arrives via the 'complete' event, or it ends here
    // when the closing note was already acknowledged (don't ask twice).
    if (session && !session.isOver) {
      if (finished && finished.require == null) resultsNext();
      else { t.done = true; tutorialBanner(); }
    }
    return;
  }
  tutorialStep();
}
function tutorialEvent(ev: { type: string; [k: string]: unknown }): void {
  const t = tutorial;
  if (!t || !session || !level) return;
  const step = t.lesson.steps[t.stepIdx];
  if (!step || !step.require) return;
  const r = step.require as { type: string; color?: number; count?: number | "all" };
  let ok = false;
  if (r.type === "select" && ev.type === "select" && ev.color === r.color) ok = true;
  if (r.type === "invalid" && ev.type === "invalid") ok = true;
  if (r.type === "fill" && ev.type === "fill" && (r.color == null || ev.color === r.color)) {
    if (r.count === "all") {
      const remaining = session.state.total - session.state.filled;
      ok = listLegalActions(session.state, level).fillableFor[r.color!] === 0 || remaining === 0;
    } else if (typeof r.count === "number") { t.count++; ok = t.count >= r.count; }
    else ok = true;
  }
  if (r.type === "complete" && ev.type === "complete") ok = true;
  // Optional steps also advance on the intended follow-up action.
  if ((step as { optional?: boolean }).optional && r.type === "invalid" && ev.type === "fill") ok = true;
  if (ok) tutorialAdvance();
}

// ------------------------------------------------------------------ commands
export function canAct(): boolean { return !!session && app.screen === "game" && !app.overlays.length && !session.isOver && !session.paused; }
export function selectColor(c: number): void {
  if (!canAct() || c < 0 || c >= palette.length) return;
  session!.selectColor(c);
}
export function fillCell(cell: number): void {
  if (!canAct() || cell < 0) return;
  focusCell = cell;
  render.setFocusCell(cell);
  session!.fillCell(cell);
}
export function doUndo(): void { if (canAct()) session!.undo(); }
export function doHint(): void { if (canAct()) session!.hint(); }
export function recenter(): void { if (session) { uiTick(); render.resetCamera(); } }
function stepColor(dir: number): void {
  if (!canAct()) return;
  const st = session!.state;
  const rem = listLegalActions(st, level!).fillableFor;
  const n = palette.length;
  let c = st.selected ?? (dir > 0 ? -1 : 0);
  for (let k = 0; k < n; k++) {
    c = (((c + dir) % n) + n) % n;
    if (rem[c]! > 0) { selectColor(c); return; }
  }
}
function moveFocus(dx: number, dy: number): void {
  if (!level || !session) return;
  const w = level.w, h = level.h;
  let x = focusCell % w, y = Math.floor(focusCell / w);
  x = (x + dx + w) % w;
  y = (y + dy + h) % h;
  focusCell = y * w + x;
  render.setFocusCell(focusCell);
  const target = level.targets[focusCell]!;
  announce(tr(session.state.fills[focusCell] ? "Region {n}, needs color {color} {name}, filled" : "Region {n}, needs color {color} {name}",
    { n: focusCell + 1, color: target + 1, name: tr(palette[target]!.name) }));
}

// ------------------------------------------------------------------ settings and platform
/** The colour-vision-safe palette changed: the round's board takes the other colours. */
platform.onSettingsChange(() => {
  if (!session || !level) return;
  const next = paletteFor(level, settings.cvdPalette);
  if (next[0] && palette[0] && next[0].hex === palette[0].hex) return;
  palette = next;
  buildBoard();
});
export function replayTutorial(): void { app.overlays = []; startLearn(); }
export function copyInvite(): void {
  uiTick();
  const link = platform.inviteLink();
  let ok = false;
  if (link) { try { clipboard.writeText(link); ok = true; } catch { ok = false; } }
  pageToast(() => (ok ? pt("inviteCopied") : pt("inviteFailed")));
}
export function signIn(): void { void requestSignIn().catch(() => undefined); }

// ------------------------------------------------------------------ input
onAction((e) => {
  if (!e.pressed) return;
  const fresh = frame().frame !== app.openedFrame;
  if (app.overlays.length) return; // dialogs take their own keys (Escape closes the innermost; the pause menu resumes)
  if (app.screen !== "game" || !session) return;
  if (e.action === "cancel") { if (fresh) pauseGame(); return; }
  if (e.action === "pause") { pauseGame(); return; }
  if (!canAct()) return;
  switch (e.action) {
    case "left": ui.setFocus(null); moveFocus(-1, 0); break;
    case "right": ui.setFocus(null); moveFocus(1, 0); break;
    case "up": ui.setFocus(null); moveFocus(0, -1); break;
    case "down": ui.setFocus(null); moveFocus(0, 1); break;
    case "fill":
      // A focused widget (a tray button, the coach banner) acts by itself.
      if (ui.focused()) break;
      fillCell(focusCell);
      break;
    case "undo": doUndo(); break;
    case "hint": doHint(); break;
    case "recenter": recenter(); break;
    case "color_prev": stepColor(-1); break;
    case "color_next": stepColor(1); break;
    default: {
      const m = /^color([1-8])$/.exec(e.action);
      if (m) selectColor(Number(m[1]) - 1);
    }
  }
});

// Board taps fill a region (a tap, not a drag: within 12 px and 500 ms); the pointer's hover previews it.
let down: { x: number; y: number; at: number } | null = null;
let lastTouch = -1e9;
function boardDown(x: number, y: number): void { down = canAct() && !ui.pointerOver() ? { x, y, at: now() } : null; }
function boardUp(x: number, y: number): void {
  const d = down;
  down = null;
  if (!d || !canAct()) return;
  if (Math.hypot(x - d.x, y - d.y) > 12 * frame().scale || now() - d.at > 0.5) return;
  const cell = render.pick(x, y);
  if (cell >= 0) { ui.setFocus(null); fillCell(cell); }
}
onPointerButton((e) => {
  if (e.button !== 0 || now() - lastTouch < 0.6) return;
  if (e.pressed) boardDown(e.x, e.y); else boardUp(e.x, e.y);
});
onPointerMove((x, y) => {
  if (app.screen !== "game" || !session) return;
  render.setHover(canAct() && !ui.pointerOver() ? render.pick(x, y) : -1);
});
onTouch((e) => {
  if (!e.primary || e.control) return;
  lastTouch = now();
  if (e.phase === "start") boardDown(e.x, e.y);
  else if (e.phase === "end") boardUp(e.x, e.y);
  else if (e.phase === "cancel") down = null;
});

// ------------------------------------------------------------------ boot and lifecycle
let lookKey = "";
function applyLook(): void {
  const f = frame();
  const k = `${f.quality}:${f.levelIndex}`;
  if (k === lookKey) return;
  lookKey = k;
  render.applyLook(lookFor(f.quality, f.levelIndex));
}

onStart(() => {
  setFixedRate(60);
  initStyles();
  platform.initPlatform();
  const p = progress();
  if (!p.playerId) { p.playerId = String(hashString(String(platform.nowMs()) + Math.random()).toString(16).slice(0, 6)); platform.persist(); }
  audio.loadSfx();
  audio.onCaption((text) => {
    if (!settings.captions) return;
    app.caption = { text, until: now() + 2.5 };
    announce("♪ " + tr(text));
  });
  render.setReducedMotion(preferences().reducedMotion);
  applyLook();
  toTitle();
});
onPreferencesChange((p) => render.setReducedMotion(p.reducedMotion));
onSessionEnded(() => pageToast(() => pt("signedOut")));
onSuspend(() => { suspended = true; syncPause(); platform.flush(); });
onResume(() => { suspended = false; });

onFixedUpdate(() => {
  if (suspended) return;
  steps++;
});

let frameDt = 0;
onUpdate((dt) => {
  frameDt = dt;
  applyLook();
  audio.update();
  syncPause();
  const t = now();
  if (app.toast && app.toast.until < t) app.toast = null;
  if (app.pageToast && app.pageToast.until < t) app.pageToast = null;
  if (app.caption && app.caption.until < t) app.caption = null;
  if (app.banner && app.banner.until != null && app.banner.until < t) app.banner = null;
  if (app.resultsAt != null && t >= app.resultsAt) {
    app.resultsAt = null;
    app.overlays = [];
    openOverlay("results", "btn-results-next");
  }
});
onRender(() => {
  drawScreens();
  render.update(frameDt);
});

export { TIERS, tierSpec };
