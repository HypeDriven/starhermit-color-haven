// The browser build's DOM shell (index.html + js/ui.js + css/style.css) as
// starhermit:ui, built every frame: the title over its paper-cut key art
// (with the drifting petals of js/title-fx.js), the round (the top bar, the
// Objective and Session cards, the playfield the paper board is framed
// into with the coach banner above it and the toast over it, the Actions
// and Score preview cards, the palette tray) and the dialogs (mode setup,
// the journey map, results with the score breakdown, pause, settings, help,
// the leaderboard), the page toast and the caption strip. The browser's
// media queries are layouts picked by the window's logical size: wide
// (≥ 1024 px: the rails docked beside the board), stacked (narrower: the
// cards in rows under the board), phone portrait (≤ 640 px wide: the
// Objective card above the board and Actions below it) and short landscape
// (≤ 500 px tall: narrow rails, the coach banner docked left of the board);
// the left-handed setting reverses the tray.
import { frame, openMenu } from "starhermit:engine";
import { bindingLabel, requestRebind } from "starhermit:input";
import * as draw from "starhermit:draw";
import * as ui from "starhermit:ui";
import { TextureLoader, type Texture } from "starhermit:scene";
import { listLegalActions } from "../js/rules.js";
import { TIERS, tierSpec } from "../js/content.js";
import * as S from "../js/store.js";
import { pt, tr } from "./i18n.ts";
import * as platform from "./platform.ts";
import * as render from "./render.ts";
import {
  app, boardId, closeOverlay, copyInvite, doHint, doUndo, formatMs, leaveRound, level, levelTitle, mode, modeLabel,
  openMode, openOverlay, palette, pauseGame, play, progress, ranked, readSnapshot, recenter, replayTutorial, restartRound,
  resultsNext, resumeGame, resumeSnapshot, selectColor, session, settings, showBoard, signIn, startFromSetup, startJourneyStage,
  today, toTitle, topOverlay, uiTick, type Mode,
} from "./main.ts";
import { PAPER } from "./style.ts";
import { symbolDraw } from "./symbols.ts";

// ------------------------------------------------------------------ layout
interface Layout { lw: number; lh: number; sc: number; ts: number; ox: number; oy: number; wide: boolean; stacked: boolean; phone: boolean; shortLand: boolean }
function layoutNow(): Layout {
  const f = frame();
  const pr = ui.preferences();
  const sc = pr.scale;
  const sa = f.safeArea;
  const lw = Math.max(1, (f.width - sa.left - sa.right) / sc), lh = Math.max(1, (f.height - sa.top - sa.bottom) / sc);
  const shortLand = lw > lh && lh <= 500;
  const phone = !shortLand && lw <= 640 && lh >= lw;
  // Side rails from 1024 px (the browser build's breakpoint), and on any landscape window from 800 px
  // (the stacked cards would leave the board a sliver there).
  const wide = !shortLand && !phone && (lw >= 1024 || (lw > lh && lw >= 800));
  return { lw, lh, sc, ts: pr.textScale, ox: sa.left / sc, oy: sa.top / sc, wide, stacked: !wide && !phone && !shortLand, phone, shortLand };
}
const lastHeight = new Map<string, number>();

function textWidth(text: string, style: string | readonly string[], kind?: "button" | "heading"): number {
  return ui.measureText(text, { ...(kind ? { kind } : {}), style: typeof style === "string" ? style : [...style] }).width / ui.preferences().scale;
}
const buttonWidth = (text: string, style: readonly string[]): number => textWidth(text, style, "button") + 2;

interface Btn { id: string; text: string; style?: string[]; disabled?: boolean; selected?: boolean; act: () => void; content?: () => void; width?: number }
const PLAIN = ["btn"];
/** A button `width` wide (null: its text's); a label too long for it wraps inside. */
function button(b: Btn, width: number | null = null): void {
  const style = b.style ?? PLAIN;
  const opts: ui.ButtonOptions = {};
  if (b.disabled) opts.disabled = true;
  if (b.selected !== undefined) opts.selected = b.selected;
  const s: ui.Style = width != null ? { width } : {};
  if (b.content) opts.content = b.content;
  else if (width != null && buttonWidth(b.text, style) > width) {
    const inner = Math.max(20, width - 24);
    opts.content = () => { ui.style({ text: { align: "center" } }).paragraph(b.text, inner); };
  }
  if (ui.style(...style, s).id(b.id).button(b.text, opts)) b.act();
}
/** Buttons at their own widths in rows that wrap at `width` (CSS flex-wrap). */
function flow(label: string, list: Btn[], width: number, align: "start" | "center" | "end" = "center", gap = 10): void {
  const rows: Btn[][] = [[]];
  let used = 0;
  for (const b of list) {
    const bw = Math.min(width, b.width ?? buttonWidth(b.text, b.style ?? PLAIN));
    if (rows[rows.length - 1]!.length && used + gap + bw > width) { rows.push([]); used = 0; }
    used += (rows[rows.length - 1]!.length ? gap : 0) + bw;
    rows[rows.length - 1]!.push(b);
  }
  ui.column(label, () => {
    rows.forEach((row, ri) => ui.row(`${label}-r${ri}`, () => {
      for (const b of row) button(b, b.width ?? (buttonWidth(b.text, b.style ?? PLAIN) > width ? width : null));
    }, { spacing: gap, align: "center" }));
  }, { spacing: gap, align, width });
}
/** Text up to `width` wide: one label when it fits, else a paragraph. */
function para(text: string, width: number, cls = "body", id?: string, center = false): void {
  if (!text) return;
  const styles: (string | ui.Style)[] = [cls];
  if (center) styles.push({ text: { align: "center" } });
  let u = ui.style(...styles);
  if (id) u = u.id(id);
  if (ui.measureText(text, { style: styles }).width / ui.preferences().scale <= width) u.label(text);
  else u.paragraph(text, width);
}
function heading(cls: string, text: string, width: number, id?: string, center = false): void {
  const styles: (string | ui.Style)[] = [cls];
  if (center) styles.push({ text: { align: "center" } });
  if (ui.measureText(text, { kind: "heading", style: styles }).width / ui.preferences().scale <= width) (id ? ui.id(id) : ui).style(...styles).heading(text);
  else ui.style(...styles).paragraph(text, width);
}
const upper = (s: string): string => s.toLocaleUpperCase();
const ARROWS: Record<string, string> = { "Arrow Left": "←", "Arrow Right": "→", "Arrow Up": "↑", "Arrow Down": "↓" };
function kbd(action: string): string { const l = bindingLabel(action, "keyboard"); return ARROWS[l] ?? l; }

// ------------------------------------------------------------------ glyphs (no emoji or symbol fonts)
function starPts(cx: number, cy: number, r: number): [number, number][] {
  const pts: [number, number][] = [];
  for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + (i * Math.PI) / 5; const rr = i % 2 ? r * 0.42 : r; pts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]); }
  return pts;
}
/** A row of `n` drawn stars (or a lock, an open ring, a dot) — the journey map's marks. */
function marks(kind: "stars" | "lock" | "open" | "none", n: number, cx: number, cy: number, r: number, color: string): void {
  if (kind === "stars") {
    const gap = r * 2.2, x0 = cx - ((n - 1) * gap) / 2;
    for (let i = 0; i < n; i++) draw.polygon(starPts(x0 + i * gap, cy, r), color);
  } else if (kind === "open") draw.strokeCircle(cx, cy, r * 0.8, color, Math.max(1, r * 0.28));
  else if (kind === "none") draw.circle(cx, cy, r * 0.3, color);
  else {
    draw.roundRect(cx - r, cy - r * 0.15, r * 2, r * 1.3, r * 0.25, color);
    draw.strokeArc(cx, cy - r * 0.15, r * 0.62, Math.PI, 2 * Math.PI, color, Math.max(1, r * 0.3));
  }
}
function alpha(hex: string, a: number): string { return hex + Math.round(Math.max(0, Math.min(1, a)) * 255).toString(16).padStart(2, "0"); }
const hexCss = (n: number): string => "#" + n.toString(16).padStart(6, "0");

// ------------------------------------------------------------------ art
let backdrop: Texture | null = null;
let resultsArt: Texture | null = null;
let artAsked = false;
function loadArt(): void {
  if (artAsked) return;
  artAsked = true;
  const loader = new TextureLoader();
  // Decorative: a missing file just leaves the art out.
  loader.loadAsync("assets/title-backdrop.webp").then((t) => { backdrop = t; }, () => undefined);
  loader.loadAsync("assets/results-studio.webp").then((t) => { resultsArt = t; }, () => undefined);
}
/** Cover-fits a texture into the window rect (CSS background-size: cover), focus `fy` down. */
function coverImage(tex: Texture, x: number, y: number, w: number, h: number, fy: number): void {
  const tw = tex.width || 1600, th = tex.height || 900;
  const k = Math.max(w / tw, h / th);
  const sw = w / k, sh = h / k;
  draw.image(tex, x, y, w, h, { source: { x: (tw - sw) / 2, y: (th - sh) * fy, width: sw, height: sh } });
}
/** Art cover-fitted into a w × h box in the layout. */
function art(id: string, tex: Texture | null, w: number, h: number): void {
  if (!tex) return;
  const tw = tex.width || 1280, th = tex.height || 720;
  const k = Math.max(w / tw, h / th);
  const sw = w / k / tw, sh = h / k / th;
  const u0 = (1 - sw) / 2, v0 = (1 - sh) / 2;
  ui.column(`${id}-frame`, () => {
    ui.image("", tex, { width: w, height: h }, { min: [u0, v0], max: [u0 + sw, v0 + sh] });
  }, { style: "results-art", clip: true, padding: 0 });
}

// ------------------------------------------------------------------ title petals (js/title-fx.js)
const PETAL_COLORS = ["#e0604e", "#e8a33d", "#5f9e52", "#5d9fd6", "#8e6cc9", "#d96f9e", "#3fa39a"];
interface Petal { x: number; y: number; s: number; vy: number; sway: number; ph: number; rot: number; vr: number; c: string; a: number }
let petals: Petal[] = [];
let petalSize = [0, 0];
let petalTime = 0;
function petal(w: number, y: number): Petal {
  return {
    x: Math.random() * w, y, s: 7 + Math.random() * 9, vy: 12 + Math.random() * 18, sway: 10 + Math.random() * 18, ph: Math.random() * 6.28,
    rot: Math.random() * 6.28, vr: (Math.random() - 0.5) * 1.2, c: PETAL_COLORS[(Math.random() * PETAL_COLORS.length) | 0]!, a: 0.45 + Math.random() * 0.3,
  };
}
/** A few cut-paper petals drifting down behind the title card (on looks with ambient motion, without reduced motion or high contrast). */
function drawPetals(L: Layout): void {
  const w = L.lw, h = L.lh;
  if (petalSize[0] !== Math.round(w) || petalSize[1] !== Math.round(h)) {
    petalSize = [Math.round(w), Math.round(h)];
    const n = Math.round(Math.min(26, Math.max(10, (w * h) / 60000)));
    petals = Array.from({ length: n }, () => petal(w, Math.random() * h));
  }
  const dt = Math.min(0.05, frame().delta);
  petalTime += dt;
  const sc = L.sc;
  for (const p of petals) {
    p.y += p.vy * dt;
    p.rot += p.vr * dt;
    if (p.y > h + 20) Object.assign(p, petal(w, -20));
    const x = p.x + Math.sin(petalTime * 0.6 + p.ph) * p.sway;
    const c = Math.cos(p.rot), s = Math.sin(p.rot);
    const at = (px: number, py: number, dy = 0): [number, number] => [(L.ox + x + px * c - py * s) * sc, (L.oy + p.y + px * s + py * c + dy) * sc];
    // Two quadratic arcs from tip to tip.
    const pts: [number, number][] = [];
    for (let i = 0; i <= 8; i++) { const t = i / 8; pts.push([2 * (1 - t) * t * p.s * 0.8, -p.s + 2 * p.s * t]); }
    for (let i = 1; i < 8; i++) { const t = i / 8; pts.push([-2 * (1 - t) * t * p.s * 0.8, p.s - 2 * p.s * t]); }
    draw.polygon(pts.map(([px, py]) => at(px, py, 2)), alpha("#50381e", 0.1 * p.a));
    draw.polygon(pts.map(([px, py]) => at(px, py)), alpha(p.c, p.a));
    const a = at(0, -p.s * 0.7), b = at(0, p.s * 0.7);
    draw.line(a[0], a[1], b[0], b[1], alpha("#ffffff", 0.45 * p.a), Math.max(1, 0.8 * sc));
  }
}

// ------------------------------------------------------------------ the frame
export function drawScreens(): void {
  loadArt();
  const L = layoutNow();
  const f = frame();
  if (app.screen === "title" || !session) titleScreen(L);
  else gameScreen(L);
  overlays(L);
  toasts(L);
  if (app.focusNext) {
    const age = f.frame - app.openedFrame;
    if (age >= 1) ui.setFocus(app.focusNext);
    if (age >= 3) app.focusNext = null;
  }
}

/** A screen card, centred, scrolling when taller than the window. */
function screenCard(key: string, L: Layout, maxW: number, build: (w: number) => void): void {
  const avail = Math.max(80, L.lh);
  const pw = Math.max(200, Math.min(maxW, L.lw - 32));
  const narrow = L.lw <= 560;
  const padX = narrow ? 18 : 26, padY = narrow ? 18 : 26;
  const w = pw - 2 * padX - 2;
  const h = lastHeight.get(key) ?? 0;
  ui.place(`scr-${key}`, { anchor: "top-start", x: 0, y: 0 }, () => {
    const body = (): void => {
      const r = ui.column(`${key}-card`, () => build(w), { style: "screen-card", width: pw, spacing: 10, align: "center", padding: { top: padY, bottom: padY, start: padX, end: padX } });
      lastHeight.set(key, r.height / L.sc + 32);
    };
    if (h > avail) {
      ui.scrollArea(`${key}-scroll`, { width: L.lw, height: avail }, () => {
        ui.column(`${key}-scroll-col`, body, { width: L.lw - 12, align: "center", padding: { top: 16, bottom: 16 } });
      });
    } else ui.column(`${key}-center`, body, { height: avail, width: L.lw, justify: "center", align: "center" });
  }, { width: L.lw, height: avail });
}

// ------------------------------------------------------------------ title
function titleScreen(L: Layout): void {
  const f = frame();
  draw.rect(0, 0, f.width, f.height, PAPER.bg);
  const hc = ui.preferences().highContrast;
  if (backdrop && !hc) {
    coverImage(backdrop, 0, 0, f.width, f.height, 1);
    // The cream wash keeps the card and its text readable.
    draw.rect(0, 0, f.width, f.height * 0.5, alpha(PAPER.bg, 0.55));
    draw.rect(0, f.height * 0.5, f.width, f.height * 0.5, alpha(PAPER.bg, 0.42));
  }
  const reduce = ui.preferences().reducedMotion;
  if (!hc && !reduce && render.ambientLook()) drawPetals(L);
  const p = progress();
  screenCard("title", L, 544, (w) => {
    heading(L.lw <= 560 ? "game-title-small" : "game-title", "Color Haven", w, "title-h", true);
    para(tr("Fill numbered regions. Finish the paper picture. Breathe."), w, "tagline", "tagline", true);
    const wrap = readSnapshot();
    if (wrap) {
      const s = wrap.snap.state;
      const sub = tr("{title} · {filled}/{total} regions", { title: levelTitle(wrap.snap.level), filled: s.filled, total: s.total });
      const label = tr("Continue");
      if (ui.style("btn", "btn-primary", "btn-big").id("btn-continue").button(label, {
        content: () => ui.column("continue-face", () => {
          ui.style({ text: { color: "#ffffff", size: 21.6, weight: "650" } }).label(label);
          ui.style({ text: { color: "#ffffffd9", size: 11.5 } }).label(sub);
        }, { spacing: 0, align: "center" }),
      })) resumeSnapshot();
    }
    button({ id: "btn-play", text: tr("Play"), style: ["btn", "btn-primary", "btn-big"], act: play });
    // The mode grid: three columns (two on phones).
    const cols = w < 420 ? 2 : 3, gap = 10;
    const cw = (w - gap * (cols - 1)) / cols;
    const jp = S.journeyProgressSummary(p);
    const info = today();
    const modes: { m: Mode; name: string; sub: string }[] = [
      { m: "learn", name: tr("Learn"), sub: tr("Short guided lessons") },
      { m: "journey", name: tr("Journey"), sub: tr("{done}/{total} stages · {stars}★", jp) },
      { m: "daily", name: tr("Daily"), sub: tr("Today {date} · tier {tier}", { date: info.date, tier: info.tier }) },
      { m: "practice", name: tr("Practice"), sub: tr("Unrated, your pace") },
      { m: "challenge", name: tr("Challenge"), sub: tr("Limits and targets") },
      { m: "score", name: tr("Score chase"), sub: tr("Seeded leaderboards") },
    ];
    // Each row's buttons as tall as its tallest face.
    const faceH = (x: { name: string; sub: string }): number => {
      const pr = ui.preferences();
      const nh = ui.measureText(x.name, { style: ["mode-name"] }).height / pr.scale;
      const sh = ui.measureText(x.sub, { style: ["mode-sub"], width: cw - 20 }).height / pr.scale;
      return nh + sh + 30;
    };
    ui.column("mode-grid", () => {
      for (let i = 0; i < modes.length; i += cols) {
        const row = modes.slice(i, i + cols);
        const rh = Math.max(...row.map(faceH));
        ui.row(`mode-r${i}`, () => {
          for (const x of row) {
            if (ui.style("mode-btn", { width: cw, height: rh }).id(`mode-${x.m}`).button(x.name, {
              content: () => ui.column(`mode-${x.m}-face`, () => {
                ui.style("mode-name").label(x.name);
                para(x.sub, cw - 20, "mode-sub", undefined, true);
              }, { spacing: 2, align: "center" }),
            })) openMode(x.m);
          }
        }, { spacing: gap, align: "stretch" });
      }
    }, { spacing: gap, width: w });
    const nav: Btn[] = [
      { id: "btn-title-settings", text: tr("Settings"), style: ["btn", "btn-ghost"], act: () => { uiTick(); openOverlay("settings", "btn-settings-close"); } },
      { id: "btn-title-help", text: tr("Help"), style: ["btn", "btn-ghost"], act: () => { uiTick(); openOverlay("help", "btn-help-close"); } },
    ];
    if (platform.inviteLink()) nav.push({ id: "btn-title-invite", text: pt("invite"), style: ["btn", "btn-ghost"], act: copyInvite });
    if (!platform.signedIn()) nav.push({ id: "btn-title-signin", text: pt("signIn"), style: ["btn", "btn-ghost"], act: signIn });
    flow("title-links", nav, w);
    if (platform.signedIn()) {
      const st = platform.syncState();
      const sync = st === "synced" ? tr("progress synced") : st === "saving" ? tr("saving…") : tr("cloud sync pending");
      para(tr("Playing as {name} · {sync}", { name: platform.displayName() || "…", sync }), w, "small", "profile-line", true);
    } else para(tr("Local play · Guest {id}", { id: p.playerId ?? "" }), w, "small", "profile-line", true);
    para(tr("Achievements: {n}/5 · Illustrations finished: {done}", { n: Object.keys(p.achievements).length, done: p.gamesPlayed }), w, "small", "achievement-line", true);
  });
}

// ------------------------------------------------------------------ the round
function card(id: string, w: number, build: (inner: number) => void, tight = false): void {
  const padX = tight ? 8 : 13;
  ui.column(id, () => build(w - 2 * padX - 2), { style: tight ? "card-tight" : "card", width: w, spacing: 6 });
}
function statRow(id: string, label: string, value: string, w: number): void {
  ui.row(id, () => { ui.style("stat-dt").label(label); ui.spacer(); ui.style("stat-dd").id(`${id}-v`).label(value); }, { width: w, align: "center" });
}
function progressBar(w: number, value: number, pct: string): void {
  ui.row("progress-row", () => {
    const tw = Math.max(40, w - textWidth("100%", "pct") - 10);
    ui.widget(tr("Completion"), {
      role: "meter", value, min: 0, max: 1, size: { width: tw, height: 13 },
      draw: (r) => {
        const rad = r.height / 2;
        draw.roundRect(r.x, r.y, r.width, r.height, rad, PAPER.edge);
        if (value > 0) draw.roundRect(r.x, r.y, Math.max(r.height, r.width * value), r.height, rad, PAPER.accent);
      },
    });
    ui.style("pct").id("progress-pct").label(pct);
  }, { width: w, spacing: 10, align: "center" });
}
function objectiveCard(w: number, tight: boolean): void {
  const s = session!, l = level!, st = s.state;
  card("objective-card", w, (inner) => {
    para(upper(levelTitle(l)), inner, "card-h", "objective-title");
    const sub = `${tr(l.tierLabel)} · ${l.w}×${l.h} · ${tr("{n} colors", { n: palette.length })}` +
      (l.mechanics.moveLimit ? " · " + tr("move limit {n}", { n: l.mechanics.moveLimit as number }) : "");
    para(sub, inner, "muted", "objective-sub");
    const pct = Math.round(s.progress * 100);
    progressBar(inner, s.progress, pct + "%");
    para(st.remainingMoves != null ? tr("Moves left: {n}", { n: st.remainingMoves }) : tr("Par time: {time}", { time: formatMs(l.par.timeMs) }), inner, "muted", "objective-moves");
  }, tight);
}
function sessionCard(w: number, tight: boolean): void {
  const s = session!, st = s.state;
  card("stats-card", w, (inner) => {
    para(upper(tr("Session")), inner, "card-h");
    statRow("stat-time", tr("Time"), formatMs(s.elapsedNow()), inner);
    statRow("stat-filled", tr("Filled"), `${st.filled} / ${st.total}`, inner);
    statRow("stat-invalid", tr("Slips"), String(st.invalid), inner);
    statRow("stat-hints", tr("Hints"), String(st.hints), inner);
  }, tight);
}
function actionsCard(w: number, tight: boolean, oneColumn: boolean): void {
  const st = session!.state;
  const over = st.status !== "active";
  const acts: { id: string; text: string; key: string | null; disabled: boolean; act: () => void }[] = [
    { id: "btn-undo", text: tr("Undo"), key: kbd("undo"), disabled: !st.mechanics.undo || over, act: doUndo },
    { id: "btn-hint", text: tr("Hint"), key: kbd("hint"), disabled: !st.mechanics.hints || over, act: doHint },
    { id: "btn-camera", text: tr("Re-center"), key: kbd("recenter"), disabled: false, act: recenter },
    { id: "btn-restart", text: tr("Restart"), key: null, disabled: false, act: restartRound },
  ];
  card("actions-card", w, (inner) => {
    para(upper(tr("Actions")), inner, "card-h");
    const gap = 7;
    // Two columns while every label fits beside its key, else one (as the short-landscape rail).
    const need = Math.max(...acts.map((a) => textWidth(a.text, "act-btn", "button") + (a.key ? textWidth(a.key, "kbd") + 10 : 0)));
    const cols = oneColumn || need > (inner - gap) / 2 ? 1 : 2;
    const bw = (inner - gap * (cols - 1)) / cols;
    for (let i = 0; i < acts.length; i += cols) {
      ui.row(`act-r${i}`, () => {
        for (const a of acts.slice(i, i + cols)) {
          const kw = a.key ? textWidth(a.key, "kbd") + 6 : 0;
          const fits = textWidth(a.text, "act-btn", "button") + kw + 4 <= bw;
          if (ui.style("act-btn", { width: bw }).id(a.id).button(a.text, {
            disabled: a.disabled,
            content: () => ui.row(`${a.id}-face`, () => {
              if (fits) ui.label(a.text); else ui.style({ text: { align: "center" } }).paragraph(a.text, Math.max(30, bw - 22 - kw));
              if (a.key) ui.style("kbd").label(a.key);
            }, { spacing: 6, align: "center" }),
          })) { ui.setFocus(null); a.act(); }
        }
      }, { spacing: gap });
    }
  }, tight);
}
function scoreCard(w: number, tight: boolean): void {
  const sc = session!.scoreBreakdown;
  card("score-card", w, (inner) => {
    para(upper(tr("Score preview")), inner, "card-h");
    statRow("score-cells", tr("Regions"), String(sc.cells), inner);
    statRow("score-accuracy", tr("Accuracy"), String(sc.accuracy), inner);
    statRow("score-hints", tr("Hints"), String(sc.hintPenalty), inner);
    statRow("score-total", tr("Total"), String(sc.total), inner);
  }, tight);
}

function topbar(L: Layout): number {
  const r = ui.place("topbar", { anchor: "top-start", x: 0, y: 0 }, () => ui.row("topbar-row", () => {
    ui.row("brand", () => {
      ui.widget("", {
        role: "none", size: { width: 19, height: 19 },
        draw: (rc) => {
          const hw = rc.width / 2, hh = rc.height / 2;
          draw.roundRect(rc.x, rc.y, rc.width, rc.height, rc.width * 0.22, "#5d9fd6");
          draw.rect(rc.x + rc.width * 0.1, rc.y, hw - rc.width * 0.1, hh, "#e8a33d");
          draw.rect(rc.x + hw, rc.y, hw - rc.width * 0.1, hh, "#e0604e");
          draw.rect(rc.x + rc.width * 0.1, rc.y + hh, hw - rc.width * 0.1, hh, "#5f9e52");
          draw.rect(rc.x, rc.y + rc.height * 0.1, rc.width * 0.1, hh - rc.height * 0.1, "#e8a33d");
          draw.rect(rc.x, rc.y + hh, rc.width * 0.1, hh - rc.height * 0.1, "#5f9e52");
        },
      });
      if (!L.shortLand) ui.style("brand-name").label("Color Haven");
    }, { spacing: 8, align: "center" });
    if (!L.phone) {
      ui.spacer();
      const status = `${modeLabel(mode)} — ${levelTitle(level)}`;
      const top = ["btn", "btn-ghost", "btn-top"];
      const actW = [tr("Help"), tr("Settings"), tr("Pause")].reduce((a, t) => a + buttonWidth(t, top) + 6, 0);
      const room = L.lw - 28 - (L.shortLand ? 19 : 27 + textWidth("Color Haven", "brand-name")) - actW - 40;
      if (room > 80) para(textWidth(status, "topbar-status") > room ? status.slice(0, Math.max(8, Math.floor(room / 8))) + "…" : status, room, "topbar-status", "topbar-status");
    }
    ui.spacer();
    ui.row("topbar-actions", () => {
      const top = ["btn", "btn-ghost", "btn-top"];
      button({ id: "btn-help", text: tr("Help"), style: top, act: () => { uiTick(); openOverlay("help", "btn-help-close"); } });
      button({ id: "btn-settings", text: tr("Settings"), style: top, act: () => { uiTick(); openOverlay("settings", "btn-settings-close"); } });
      if (session && !session.isOver) button({ id: "btn-pause", text: tr("Pause"), style: top, act: () => { uiTick(); pauseGame(); } });
    }, { spacing: 6, align: "center" });
  }, { width: L.lw - 28, align: "center", spacing: 10 }), { style: "topbar", width: L.lw });
  return r.height / L.sc;
}

const TRAY = { w: 70, wPhone: 58, h: 54, gap: 10 };
function paletteButton(i: number, bw: number, remaining: number[]): void {
  const p = palette[i]!;
  const st = session!.state;
  const sel = st.selected === i;
  const left = remaining[i]!;
  const done = left === 0;
  const label = tr(left === 1 ? "Color {n}, {name}, {left} region left" : "Color {n}, {name}, {left} regions left", { n: i + 1, name: tr(p.name), left });
  const r = ui.id(`pal-${i + 1}`).widget(label, {
    role: "button", size: { width: bw, height: TRAY.h }, disabled: done, checked: sel,
    draw: (rc, s) => {
      const k = s.scale, a = done ? 0.45 : 1;
      const ink = alpha(PAPER.ink, a), soft = alpha(PAPER.soft, a);
      if (sel) draw.roundRect(rc.x - 3 * k, rc.y - 3 * k, rc.width + 6 * k, rc.height + 6 * k, 13 * k, alpha(PAPER.focus, 0.3));
      draw.roundRect(rc.x, rc.y, rc.width, rc.height, 10 * k, sel ? PAPER.focus : s.hovered && !done ? PAPER.accent : alpha(PAPER.edge, a));
      draw.roundRect(rc.x + 2 * k, rc.y + 2 * k, rc.width - 4 * k, rc.height - 4 * k, 8 * k, alpha(PAPER.panel, done ? 0.7 : 1));
      const ts = ui.preferences().textScale;
      const num = String(i + 1), numSize = 18.4 * k * ts;
      const nw = draw.measureText(num, { size: numSize, weight: "750" }).width;
      const symR = 6 * k * ts, gap = 6 * k;
      const total = nw + gap + symR * 2;
      const x0 = rc.x + (rc.width - total) / 2, cyTop = rc.y + 7 * k;
      draw.text(num, x0, cyTop, { size: numSize, weight: "750", color: ink });
      symbolDraw(p.i, x0 + nw + gap + symR, cyTop + numSize * 0.58, symR, ink);
      const countText = done ? tr("done") : String(left);
      const cs = 11.5 * k * ts;
      const cw = draw.measureText(countText, { size: cs }).width;
      const cy = rc.y + rc.height - 9 * k - cs * 1.25;
      draw.text(countText, rc.x + rc.width / 2, cy, { size: cs, color: soft, align: "center" });
      if (done) draw.line(rc.x + rc.width / 2 - cw / 2, cy + cs * 0.62, rc.x + rc.width / 2 + cw / 2, cy + cs * 0.62, soft, Math.max(1, k));
      draw.roundRect(rc.x + 2 * k, rc.y + rc.height - 8 * k, rc.width - 4 * k, 6 * k, 3 * k, alpha(hexCss(p.hex), a));
    },
  });
  if (r.activated && !done) { ui.setFocus(null); selectColor(i); }
}
function tray(L: Layout): number {
  const st = session!.state;
  const remaining = listLegalActions(st, level!).fillableFor;
  const n = palette.length;
  let bw = L.phone ? TRAY.wPhone : TRAY.w;
  const avail = L.lw - 26;
  if (n * bw + (n - 1) * TRAY.gap > avail) bw = Math.max(40, (avail - (n - 1) * TRAY.gap) / n);
  const order = Array.from({ length: n }, (_, i) => i);
  if (settings.leftHanded) order.reverse();
  const r = ui.place("palette-tray", { anchor: "bottom-start", x: 0, y: 0 }, () => {
    ui.row("palette-row", () => { for (const i of order) paletteButton(i, bw, remaining); }, { spacing: TRAY.gap, justify: "center", width: L.lw - 26 });
  }, { style: "tray", width: L.lw });
  return r.height / L.sc;
}

/** The coach banner (a button while it waits on a tap): returns its height. */
function coachBanner(id: string, w: number, center: boolean): void {
  const b = app.banner;
  if (!b) return;
  const text = b.text();
  const inner = Math.max(60, w - 30);
  if (b.action) {
    const act = b.action;
    if (ui.style("hud-banner-btn", { width: w }).id(id).button(text, {
      content: () => ui.style({ text: { align: center ? "center" : "start" } }).paragraph(text, inner),
    })) { ui.setFocus(null); act(); }
  } else {
    ui.column(id, () => ui.style({ text: { align: center ? "center" : "start" } }).paragraph(text, inner), { style: "hud-banner", width: w });
  }
}

function gameScreen(L: Layout): void {
  const f = frame();
  const sc = L.sc;
  const topH = topbar(L);
  const trayH = tray(L);
  const pad = L.phone || L.shortLand ? 6 : 11, gap = L.phone || L.shortLand ? 6 : 11;
  let x0 = pad, x1 = L.lw - pad, y0 = topH + pad, y1 = L.lh - trayH - pad;
  if (L.wide || L.shortLand) {
    const rw = L.wide ? (L.lw >= 1024 ? Math.max(220, Math.min(272, L.lw * 0.2)) : 200) : 152;
    const railH = y1 - y0;
    const tight = L.shortLand;
    for (const [side, x] of [["rail-left", x0], ["rail-right", x1 - rw]] as const) {
      const key = side;
      const h = lastHeight.get(key) ?? 0;
      ui.place(side, { anchor: "top-start", x, y: y0 }, () => {
        const build = (): void => {
          const r = ui.column(`${side}-col`, () => {
            if (side === "rail-left") { objectiveCard(rw - (h > railH ? 12 : 0), tight); sessionCard(rw - (h > railH ? 12 : 0), tight); }
            else { actionsCard(rw - (h > railH ? 12 : 0), tight, L.shortLand); scoreCard(rw - (h > railH ? 12 : 0), tight); }
          }, { spacing: gap });
          lastHeight.set(key, r.height / sc);
        };
        if (h > railH) ui.scrollArea(`${side}-scroll`, { width: rw, height: railH }, build);
        else build();
      }, { width: rw });
    }
    x0 += rw + gap; x1 -= rw + gap;
  } else if (L.phone) {
    const t = ui.place("rail-top", { anchor: "top-start", x: pad, y: y0 }, () => objectiveCard(L.lw - 2 * pad, true), { width: L.lw - 2 * pad });
    y0 += t.height / sc + gap;
    const b = ui.place("rail-bottom", { anchor: "bottom-start", x: pad, y: trayH + pad }, () => actionsCard(L.lw - 2 * pad, true, false), { width: L.lw - 2 * pad });
    y1 -= b.height / sc + gap;
  } else {
    // Stacked: the four cards in rows under the board (CSS flex-wrap at 14rem).
    const w = L.lw - 2 * pad;
    const per = Math.max(1, Math.min(4, Math.floor((w + gap) / (224 + gap))));
    const cw = (w - gap * (per - 1)) / per;
    const cards = [(cw2: number) => objectiveCard(cw2, true), (cw2: number) => sessionCard(cw2, true), (cw2: number) => actionsCard(cw2, true, false), (cw2: number) => scoreCard(cw2, true)];
    const b = ui.place("rails", { anchor: "bottom-start", x: pad, y: trayH + pad }, () => {
      for (let i = 0; i < cards.length; i += per) ui.row(`rails-r${i}`, () => { for (const c of cards.slice(i, i + per)) c(cw); }, { spacing: gap, align: "stretch" });
    }, { width: w, spacing: gap });
    y1 -= b.height / sc + gap;
  }
  // The coach banner: its own band above the board (beside it, docked left, on short landscape).
  let fx = x0, fy = y0;
  const fw = x1 - x0;
  if (app.banner) {
    if (L.shortLand) {
      const bw = Math.min(fw * 0.3, 256);
      const r = ui.place("coach", { anchor: "top-start", x: x0, y: y0 }, () => coachBanner("hud-banner", bw, false), { width: bw });
      if (r.height > 0) fx = x0 + bw + 8;
    } else {
      const bw = Math.min(fw * 0.94, 544);
      const r = ui.place("coach", { anchor: "top-start", x: x0 + (fw - bw) / 2, y: y0 }, () => ui.column("coach-col", () => coachBanner("hud-banner", bw, true), { width: bw, align: "center" }), { width: bw });
      fy = y0 + r.height / sc + 8;
    }
  }
  const pw = Math.max(40, x1 - fx), ph = Math.max(40, y1 - fy);
  const X = (L.ox + fx) * sc, Y = (L.oy + fy) * sc, Wd = pw * sc, Hd = ph * sc;
  render.setPlayfield(X, Y, Wd, Hd, f.width, f.height);
  // The page around the playfield (the 3D view fills the window behind the UI), its corners rounded.
  const bg = PAPER.bg;
  draw.rect(0, 0, f.width, Y, bg);
  draw.rect(0, Y + Hd, f.width, f.height - Y - Hd, bg);
  draw.rect(0, Y, X, Hd, bg);
  draw.rect(X + Wd, Y, f.width - X - Wd, Hd, bg);
  roundCorners(X, Y, Wd, Hd, 14 * sc, bg);
  if (app.toast) {
    const text = app.toast.text();
    const tw = Math.min(pw * 0.9, 480);
    ui.place("hud-toast", { anchor: "top-start", x: fx + (pw - Math.min(tw, textWidth(text, "hud-toast") + 30)) / 2, y: fy + ph - 54 }, () => {
      if (textWidth(text, "hud-toast") + 30 <= tw) ui.style("hud-toast").id("hud-toast").label(text);
      else ui.style("hud-toast").id("hud-toast").paragraph(text, tw - 28);
    });
  }
}
/** Masks the playfield's square corners into rounded ones (the browser build's border-radius). */
function roundCorners(x: number, y: number, w: number, h: number, r: number, color: string): void {
  const corner = (cx: number, cy: number, px: number, py: number, a0: number): void => {
    const pts: [number, number][] = [[px, py]];
    for (let i = 0; i <= 6; i++) { const a = a0 + (i / 6) * (Math.PI / 2); pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]); }
    draw.polygon(pts, color);
  };
  corner(x + r, y + r, x, y, Math.PI);
  corner(x + w - r, y + r, x + w, y, -Math.PI / 2);
  corner(x + w - r, y + h - r, x + w, y + h, 0);
  corner(x + r, y + h - r, x, y + h, Math.PI / 2);
}

// ------------------------------------------------------------------ dialogs
/** A modal card: a scrolling body when taller than the window, a pinned footer (its buttons stay clickable). */
function dialogFrame(label: string, L: Layout, maxW: number, build: (w: number) => void, footer: ((w: number) => void) | null, onClose: () => void = () => closeOverlay()): void {
  const w = Math.min(maxW, L.lw - 24) - 48;
  const fh = footer ? (lastHeight.get(`dlg-${label}-foot`) ?? 56) + 12 : 0;
  const avail = Math.max(80, L.lh - 24 - 48 - fh);
  const h = lastHeight.get(`dlg-${label}`) ?? 0;
  const body = (): void => {
    const r = ui.column(`${label}-body`, () => build(w), { spacing: 10, width: w });
    lastHeight.set(`dlg-${label}`, r.height / L.sc);
  };
  // A dialog opens at its top (heading visible), whatever it focuses.
  const fresh = frame().frame - app.openedFrame <= 4;
  const open = ui.dialog(label, "", true, () => {
    if (h > avail) ui.scrollArea(`${label}-scroll`, { width: w + 14, height: avail }, body, fresh ? { scrollTo: { top: 0 } } : undefined);
    else body();
    if (footer) {
      const r = ui.column(`${label}-foot`, () => footer(w), { width: w, spacing: 8, padding: { top: 12 } });
      lastHeight.set(`dlg-${label}-foot`, r.height / L.sc - 12);
    }
  });
  // The Escape (or East) that opened it must not close it the same frame.
  if (!open && frame().frame !== app.openedFrame) onClose();
}
function overlays(L: Layout): void {
  const o = topOverlay();
  if (!o) return; // input reaches only the innermost; the outer one shows again when it closes
  switch (o) {
    case "setup": setupDialog(L); break;
    case "journey": journeyDialog(L); break;
    case "results": resultsDialog(L); break;
    case "pause": pauseDialog(L); break;
    case "settings": settingsDialog(L); break;
    case "help": helpDialog(L); break;
    case "scores": scoresDialog(L); break;
  }
}
function facts(rows: [string, string][], w: number): void {
  ui.column("setup-facts", () => {
    rows.forEach(([k, v], i) => ui.row(`fact-${i}`, () => {
      para(k, w * 0.42, "setup-dt");
      ui.spacer();
      para(v, w * 0.55, "setup-dd");
    }, { width: w, align: "start" }));
  }, { spacing: 5, width: w });
}
function setupDialog(L: Layout): void {
  const cfg = app.setup;
  if (!cfg) { closeOverlay(); return; }
  dialogFrame("overlay-setup", L, 544, (w) => {
    if (cfg.mode === "daily") {
      const info = today();
      const t = tierSpec(info.tier);
      heading("h1", tr("Daily challenge"), w, "setup-h");
      facts([
        [tr("Date (UTC)"), info.date],
        [tr("Board"), tr("{w}×{h}, {n} colors", { w: t.size, h: t.size, n: t.colors })],
        [tr("Move limit"), String(Math.ceil(t.size * t.size * 1.2))],
        [tr("Ruleset"), tr("Hints + undo allowed")],
        [tr("Ranked"), tr("Yes — same seed for everyone today")],
        [tr("Expected"), tr("~{n} min", { n: Math.round((t.size * t.size * t.timePerCellMs) / 60000) })],
      ], w);
    } else if (cfg.mode === "practice") {
      heading("h1", tr("Practice"), w, "setup-h");
      facts([[tr("Ranked"), tr("No — relax")], [tr("Restart / undo"), tr("Always available")]], w);
      const opts = TIERS.map((t) => tr("{tier} — {w}×{h}, {n} colors", { tier: tr(t.label), w: t.size, h: t.size, n: t.colors }));
      ui.row("setup-tier-row", () => {
        para(tr("Difficulty"), Math.max(80, w * 0.3), "body");
        ui.spacer();
        const next = ui.id("setup-tier").select(tr("Difficulty"), cfg.tier - 1, opts);
        if (next !== cfg.tier - 1) cfg.tier = next + 1;
      }, { width: w, align: "center", spacing: 10 });
      const h = ui.id("setup-hints").checkbox(tr("Allow hints"), cfg.hints);
      if (h !== cfg.hints) cfg.hints = h;
      const u = ui.id("setup-undo").checkbox(tr("Allow undo"), cfg.undo);
      if (u !== cfg.undo) cfg.undo = u;
    } else if (cfg.mode === "challenge") {
      heading("h1", tr("Challenge"), w, "setup-h");
      facts([[tr("Ranked"), tr("Yes — per-variant boards")], [tr("Assists"), tr("Depends on variant")]], w);
      const variants: [SetupVariant, string][] = [
        ["moves", tr("Strict ledger — tier 3, only 5% spare moves, no hints")],
        ["speed", tr("Steady hands — tier 3, beat the par clock, no undo")],
        ["elder", tr("Elder trial — tier 5, no hints, no undo")],
      ];
      ui.column("setup-choices", () => {
        for (const [v, text] of variants) {
          if (ui.style("choice", { width: w }).id(`chvar-${v}`).button(text, {
            selected: cfg.variant === v,
            content: () => ui.style({ text: { align: "start" } }).paragraph(text, w - 26),
          })) cfg.variant = v;
        }
      }, { spacing: 6, width: w });
    } else {
      heading("h1", tr("Score chase"), w, "setup-h");
      facts([[tr("Ranked"), tr("Yes — one board per seed")], [tr("Fair play"), tr("Same seed + ruleset for every entry")]], w);
      ui.row("setup-seed-row", () => {
        para(tr("Seed"), Math.max(60, w * 0.25), "body");
        ui.spacer();
        cfg.seed = ui.textField("setup-seed", cfg.seed, { maxChars: 40, width: Math.min(260, w * 0.65) });
      }, { width: w, align: "center", spacing: 10 });
      const opts = TIERS.map((t) => tr("{tier} — {w}×{h}", { tier: tr(t.label), w: t.size, h: t.size }));
      ui.row("setup-size-row", () => {
        para(tr("Size"), Math.max(60, w * 0.25), "body");
        ui.spacer();
        const next = ui.id("setup-score-tier").select(tr("Size"), cfg.tier - 1, opts);
        if (next !== cfg.tier - 1) cfg.tier = next + 1;
      }, { width: w, align: "center", spacing: 10 });
    }
  }, (w) => flow("setup-buttons", [
    { id: "btn-setup-start", text: tr("Start"), style: ["btn", "btn-primary"], act: () => { uiTick(); startFromSetup(); } },
    { id: "btn-setup-back", text: tr("Back"), style: ["btn", "btn-ghost"], act: () => closeOverlay() },
  ], w, "start"));
}
type SetupVariant = "moves" | "speed" | "elder";

function journeyDialog(L: Layout): void {
  const p = progress();
  dialogFrame("overlay-journey", L, 768, (w) => {
    heading("h1", tr("Journey"), w, "journey-h");
    para(tr("One new idea at a time. Every 8th stage is a mastery test."), w, "muted");
    const min = 74, gap = 8;
    const cols = Math.max(1, Math.floor((w + gap) / (min + gap)));
    const bw = (w - gap * (cols - 1)) / cols;
    const map = S.journeyMap(p);
    for (let i = 0; i < map.length; i += cols) {
      ui.row(`journey-r${i}`, () => {
        for (const { stage, done, unlocked } of map.slice(i, i + cols)) {
          const title = tr(stage.title);
          const label = done ? tr("Stage {n}, {title}, best {best}, {stars} stars", { n: stage.n, title, best: done.best, stars: done.stars })
            : unlocked ? tr("Stage {n}, {title}", { n: stage.n, title }) : tr("Stage {n}, {title}, locked", { n: stage.n, title });
          const r = ui.id(`stage-${stage.n}`).widget(label, {
            role: "button", size: { width: bw, height: 52 }, disabled: !unlocked,
            style: stage.mastery ? ["stage-btn", "stage-mastery"] : ["stage-btn"],
            draw: (rc, s) => {
              const k = s.scale, ts = ui.preferences().textScale, a = unlocked ? 1 : 0.4;
              const size = 16 * k * ts;
              draw.text(String(stage.n), rc.x + rc.width / 2, rc.y + 8 * k, { size, weight: "700", color: alpha(PAPER.ink, a), align: "center" });
              const my = rc.y + rc.height - 13 * k;
              if (done) marks(done.stars ? "stars" : "none", done.stars, rc.x + rc.width / 2, my, 4.5 * k, PAPER.accent);
              else marks(unlocked ? "open" : "lock", 0, rc.x + rc.width / 2, my, 4.5 * k, alpha(PAPER.accent, a));
            },
          });
          if (r.activated && unlocked) { uiTick(); app.overlays = []; startJourneyStage(stage); }
        }
      }, { spacing: gap });
    }
  }, (w) => flow("journey-buttons", [{ id: "btn-journey-back", text: tr("Back"), style: ["btn", "btn-ghost"], act: () => closeOverlay() }], w, "start"));
}

function resultsDialog(L: Layout): void {
  const r = app.results;
  if (!r) { closeOverlay(); return; }
  const st = r.session.state;
  const sc = r.session.scoreBreakdown;
  const complete = st.terminalReason === "completed";
  dialogFrame("overlay-results", L, 544, (w) => {
    heading("h1", complete ? tr("Illustration complete") : tr("Round over"), w, "results-h");
    para(`${levelTitle(r.level)} · ${modeLabel(r.mode)}` + (complete ? " · " + tr("finished in {time}", { time: formatMs(st.elapsedMs) }) : " · " + tr("moves exhausted")), w, "muted", "results-sub");
    if (complete && resultsArt && L.lh > 500) art("results-art", resultsArt, w, Math.min(176, L.lh * (L.phone ? 0.14 : 0.24), w / 2.6));
    const rows: [string, string, number][] = [
      [tr("Regions filled"), `${st.filled} / ${st.total}`, sc.cells],
      [tr("Completion"), complete ? tr("yes") : "—", sc.completion],
      [tr("Accuracy"), tr(st.invalid === 1 ? "{n} slip" : "{n} slips", { n: st.invalid }), sc.accuracy],
      [tr("Pace"), formatMs(st.elapsedMs), sc.timeBonus],
      [tr("Hints used"), String(st.hints), sc.hintPenalty],
      [tr("Undos"), String(st.undos), sc.undoPenalty],
    ];
    const c1 = w * 0.45, c2 = w * 0.3;
    ui.column("results-table", () => {
      rows.forEach(([k, d, v], i) => ui.row(`res-${i}`, () => {
        ui.column(`res-${i}-a`, () => para(k, c1 - 8, "score-cell"), { width: c1 });
        ui.column(`res-${i}-b`, () => para(d, c2 - 8, "score-cell"), { width: c2 });
        ui.style("score-cell").label(String(v));
      }, { style: "score-row", width: w, align: "center" }));
      ui.row("res-total", () => {
        ui.column("res-total-a", () => ui.style("score-cell").label(tr("Total")), { width: c1 + c2 });
        ui.style("score-total").id("results-total").label(String(sc.total));
      }, { style: "score-row", width: w, align: "center" });
    }, { spacing: 0, width: w });
    for (const a of r.newAchievements) {
      ui.column(`ach-${a.key}`, () => para(tr("Achievement unlocked: {name} — {desc}", { name: tr(a.name), desc: tr(a.desc) }), w - 26, "ach-item-text"), { style: "ach-item", width: w });
    }
    const res = r.rankRes;
    const rankInfo = !res ? "" : res.ok ? (res.local ? tr("Leaderboard rank: #{rank} (local board)", { rank: res.rank }) : tr("Leaderboard rank: #{rank}", { rank: res.rank }))
      : tr("Score saved locally; board submission unavailable.");
    para(rankInfo, w, "muted", "results-compare");
    if (app.lb) para(app.lb.state === "lbRank" ? pt("lbRank", { rank: app.lb.rank ?? "" }) : pt(app.lb.state), w, "muted", "results-lb");
  }, (w) => {
    const btns: Btn[] = [
      { id: "btn-results-next", text: r.mode === "journey" ? tr("Next stage") : tr("Play again"), style: ["btn", "btn-primary"], act: resultsNext },
      { id: "btn-results-replay", text: tr("Replay"), style: ["btn", "btn-ghost"], act: restartRound },
    ];
    if (ranked && boardId) btns.push({ id: "btn-results-scores", text: tr("Leaderboard"), style: ["btn", "btn-ghost"], act: showBoard });
    btns.push({ id: "btn-results-home", text: tr("Home"), style: ["btn", "btn-ghost"], act: () => { uiTick(); toTitle(); } });
    flow("results-buttons", btns, w, "start");
  }, () => { /* the results stay until a choice is made */ app.openedFrame = frame().frame; });
}

function pauseDialog(L: Layout): void {
  dialogFrame("overlay-pause", L, 380, (w) => {
    heading("h1", tr("Paused"), w, "pause-h");
    ui.column("pause-col", () => {
      button({ id: "btn-resume", text: tr("Resume"), style: ["btn", "btn-primary"], act: () => { uiTick(); resumeGame(); } }, w);
      button({ id: "btn-pause-settings", text: tr("Settings"), style: ["btn", "btn-ghost"], act: () => { uiTick(); openOverlay("settings", "btn-settings-close"); } }, w);
      button({ id: "btn-pause-help", text: tr("Help"), style: ["btn", "btn-ghost"], act: () => { uiTick(); openOverlay("help", "btn-help-close"); } }, w);
      button({ id: "btn-pause-leave", text: tr("Leave round"), style: ["btn", "btn-danger"], act: () => { uiTick(); leaveRound(); } }, w);
    }, { spacing: 10, width: w });
  }, null, resumeGame);
}

function check(key: "captions" | "cvdPalette" | "leftHanded" | "haptics", label: string): void {
  const cur = !!settings[key];
  const next = ui.id(`set-${key}`).checkbox(label, cur);
  if (next !== cur) platform.setSetting(key, next);
}
function fieldset(id: string, legend: string, w: number, build: (inner: number) => void): void {
  ui.column(id, () => { ui.style("legend").label(legend); build(w - 28); }, { style: "fieldset", width: w, spacing: 8 });
}
function settingsDialog(L: Layout): void {
  dialogFrame("overlay-settings", L, 768, (w) => {
    heading("h1", tr("Settings"), w, "settings-h");
    const cols = w >= 600 ? 2 : 1, gap = 16;
    const cw = (w - gap * (cols - 1)) / cols;
    const sets = [
      () => fieldset("fs-audio", tr("Audio"), cw, (inner) => {
        para(tr("Music, effects and voice volumes and mute are set in the StarHermit Options (F1)."), inner, "muted");
        button({ id: "btn-options", text: tr("Open Options"), act: () => openMenu() });
        check("captions", tr("Text cues for sounds"));
      }),
      () => fieldset("fs-display", tr("Display"), cw, (inner) => {
        para(tr("Reduced motion, high contrast, text size and graphics quality are set in the StarHermit Options (F1)."), inner, "muted");
      }),
      () => fieldset("fs-a11y", tr("Accessibility"), cw, (inner) => {
        check("cvdPalette", tr("Color-vision-safe palette"));
        check("leftHanded", tr("Left-handed tray"));
        check("haptics", tr("Haptics (vibration)"));
        flow("a11y-buttons", [
          { id: "btn-replay-tutorial", text: tr("Replay tutorial"), style: ["btn", "btn-ghost"], act: () => { uiTick(); replayTutorial(); } },
          { id: "btn-rebind", text: tr("Change keys and buttons"), style: ["btn", "btn-ghost"], act: () => requestRebind() },
        ], inner, "start");
      }),
    ];
    for (let i = 0; i < sets.length; i += cols) ui.row(`set-r${i}`, () => { for (const s of sets.slice(i, i + cols)) s(); }, { spacing: gap, align: "stretch" });
  }, (w) => flow("settings-buttons", [{ id: "btn-settings-close", text: tr("Done"), style: ["btn", "btn-primary"], act: () => closeOverlay("settings") }], w, "start"));
}

function helpDialog(L: Layout): void {
  dialogFrame("overlay-help", L, 768, (w) => {
    heading("h1", tr("How to play"), w, "help-h");
    const k = kbd;
    const cards: { h: string; ps: string[]; symbols?: boolean }[] = [
      { h: tr("The loop"), ps: [tr("Pick a numbered color in the tray."), tr("Fill every region showing that number."), tr("Finish the picture — there is no timer and no way to lose.")] },
      { h: tr("Mouse / touch"), ps: [tr("Tap a region to fill it with the selected color."), tr("Hover previews the result before you commit."), tr("Drag to pan nothing — the board always fits.")] },
      {
        h: tr("Keyboard"), ps: [
          tr("{keys} — move between regions", { keys: `${k("left")} ${k("right")} ${k("up")} ${k("down")}` }), tr("{key} — fill focused region", { key: k("fill") }),
          tr("{from}–{to} — pick a color", { from: k("color1"), to: k("color8") }),
          tr("{undo} — undo, {hint} — hint, {recenter} — re-center camera, {cancel} / {pause} — pause", { undo: k("undo"), hint: k("hint"), recenter: k("recenter"), cancel: k("cancel"), pause: k("pause") }),
        ],
      },
      { h: tr("Gamepad"), ps: [tr("D-pad / left stick — move focus"), tr("A — fill, X — undo, Y — hint"), tr("LB / RB — previous / next color"), tr("Start — pause")] },
      { h: tr("Scoring"), ps: [tr("Regions filled and accuracy earn points."), tr("Finishing quickly adds a pace bonus."), tr("Hints and undos cost a little. Slips cost more.")] },
      { h: tr("Symbols"), ps: [tr("Every color also has a symbol, so numbers never rely on color alone. A color-vision-safe palette is in Settings.")], symbols: true },
    ];
    const cols = w >= 460 ? 2 : 1, gap = 12;
    const cw = (w - gap * (cols - 1)) / cols;
    for (let i = 0; i < cards.length; i += cols) {
      ui.row(`help-r${i}`, () => {
        cards.slice(i, i + cols).forEach((c, j) => ui.column(`help-${i + j}`, () => {
          para(c.h, cw - 28, "help-h");
          for (const p of c.ps) para(p, cw - 28, "help-p");
          if (c.symbols) {
            ui.widget(tr("Symbols"), {
              role: "image", size: { width: cw - 28, height: 22 },
              draw: (rc, s) => { for (let n = 0; n < 8; n++) symbolDraw(n, rc.x + (10 + n * 26) * s.scale, rc.y + rc.height / 2, 7 * s.scale, PAPER.soft); },
            });
          }
        }, { style: "help-card", width: cw, spacing: 4 }));
      }, { spacing: gap, align: "stretch" });
    }
  }, (w) => flow("help-buttons", [{ id: "btn-help-close", text: tr("Close"), style: ["btn", "btn-primary"], act: () => closeOverlay("help") }], w, "start"));
}

function scoresDialog(L: Layout): void {
  const entries = app.boardEntries;
  dialogFrame("overlay-scores", L, 544, (w) => {
    heading("h1", tr("Leaderboard"), w, "scores-h");
    para(`${boardId ?? ""} · ${tr(entries.length === 1 ? "{n} entry" : "{n} entries", { n: entries.length })}`, w, "muted", "scores-sub");
    if (!entries.length) { para(tr("No scores yet — be the first."), w, "body", "scores-empty"); return; }
    const cols = [w * 0.1, w * 0.4, w * 0.2, w * 0.15, w * 0.15];
    const row = (id: string, cells: string[], cls: string): void => {
      ui.row(id, () => cells.forEach((c, i) => ui.column(`${id}-${i}`, () => para(c, cols[i]! - 6, cls), { width: cols[i]! })), { style: "score-row", width: w, align: "center" });
    };
    row("scores-head", ["#", tr("Player"), tr("Score"), tr("Time"), tr("Slips")], "score-total");
    entries.slice(0, 20).forEach((e, i) => row(`score-${i}`, [String(i + 1), e.name || tr("Guest"), String(e.score), formatMs(e.elapsedMs || 0), String(e.invalid || 0)], "score-cell"));
  }, (w) => flow("scores-buttons", [{ id: "btn-scores-close", text: tr("Close"), style: ["btn", "btn-primary"], act: () => closeOverlay("scores") }], w, "start"));
}

// ------------------------------------------------------------------ toasts and captions
function toasts(L: Layout): void {
  if (app.caption) {
    const text = "♪ " + tr(app.caption.text);
    ui.place("captions", { anchor: "top", y: 60 }, () => ui.style("captions").id("caption-text").label(text.replace("♪ ", "")), { style: "captions" });
  }
  if (!app.pageToast) return;
  const text = app.pageToast.text();
  const w = Math.min(L.lw - 32, 512);
  ui.place("page-toast", { anchor: "bottom", y: 20 }, () => {
    if (textWidth(text, "page-toast") + 40 <= w) ui.style("page-toast").id("page-toast").label(text);
    else ui.style("page-toast").id("page-toast").paragraph(text, w - 34);
  }, { width: w, align: "center" });
}
