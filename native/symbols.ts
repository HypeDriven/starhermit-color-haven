// The palette's region symbols (js/content.js SYMBOLS: ● ▲ ■ ◆ ★ ✚ ◐ ⬡),
// which reinforce each colour's number so it never relies on colour
// alone. As in the browser build they are font characters, drawn in the
// text's colour: a system face draws them where it has them, else the
// engine's StarHermit Emoji, which covers all eight (text style). The board's
// number overlay (a 2D canvas, baked once a cell changes) waits for that
// font first (symbolsReady); the tray, the help and the results draw them
// with starhermit:draw, which draws them once the font is in.
import * as draw from "starhermit:draw";
import { fonts, OffscreenCanvas, type OffscreenCanvasRenderingContext2D } from "starhermit:canvas";

export const SYMBOLS = ["●", "▲", "■", "◆", "★", "✚", "◐", "⬡"] as const;
const FONT = "sans-serif";
/** The glyph's ink box fills this share of the symbol's diameter (the old drawn shapes' size). */
const FILL = 0.9;
const REF = 100;

/** Settles once the faces the symbols need are in (the emoji font where no system face has them). */
export const symbolsReady: Promise<unknown> = fonts.load(`${REF}px ${FONT}`, SYMBOLS.join("")).catch(() => undefined);

interface Ink { scale: number; dx: number; dy: number; asc: number }
const inks = new Map<number, Ink>();
let probe: OffscreenCanvasRenderingContext2D | null = null;
/** Symbol `i`'s ink box at REF px: font size per unit of radius, and the centre's offset from (align center, alphabetic baseline). */
function ink(i: number): Ink {
  let m = inks.get(i);
  if (m) return m;
  probe ??= new OffscreenCanvas(4, 4).getContext("2d")!;
  probe.font = `${REF}px ${FONT}`;
  probe.textAlign = "center";
  probe.textBaseline = "alphabetic";
  const t = probe.measureText(SYMBOLS[i]!);
  const w = t.actualBoundingBoxLeft + t.actualBoundingBoxRight, h = t.actualBoundingBoxAscent + t.actualBoundingBoxDescent;
  const ext = Math.max(1, w, h);
  m = { scale: (2 * FILL * REF) / ext, dx: (t.actualBoundingBoxRight - t.actualBoundingBoxLeft) / 2 / REF, dy: (t.actualBoundingBoxDescent - t.actualBoundingBoxAscent) / 2 / REF, asc: t.fontBoundingBoxAscent / REF };
  if (fonts.check(`${REF}px ${FONT}`, SYMBOLS[i])) inks.set(i, m);
  return m;
}

/** Draws symbol `i` (0–7) centred at (cx, cy), `r` its radius, on a 2D canvas. */
export function symbolCanvas(ctx: OffscreenCanvasRenderingContext2D, i: number, cx: number, cy: number, r: number, color: string): void {
  const k = i % SYMBOLS.length, m = ink(k), size = m.scale * r;
  ctx.save();
  ctx.fillStyle = color;
  ctx.font = `${size}px ${FONT}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillText(SYMBOLS[k]!, cx - m.dx * size, cy - m.dy * size);
  ctx.restore();
}

/** Draws symbol `i` (0–7) centred at (cx, cy) in window pixels, `r` its radius, with starhermit:draw. */
export function symbolDraw(i: number, cx: number, cy: number, r: number, color: string): void {
  const k = i % SYMBOLS.length, m = ink(k), size = m.scale * r;
  // draw.text's y is the line box's top: the baseline sits the font's ascent below it.
  draw.text(SYMBOLS[k]!, cx - m.dx * size, cy - (m.dy + m.asc) * size, { size, font: FONT, color, align: "center" });
}
