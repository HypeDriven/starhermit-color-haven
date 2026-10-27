// The palette's region symbols (js/content.js SYMBOLS: ● ▲ ■ ◆ ★ ✚ ◐ ⬡),
// which reinforce each colour's number so it never relies on colour
// alone. The browser build drew them as font characters; fonts here need
// not have them, so they are drawn as shapes: on the board's number
// overlay (a 2D canvas path) and in the tray, the help and the results
// (starhermit:draw).
import * as draw from "starhermit:draw";
import type { OffscreenCanvasRenderingContext2D } from "starhermit:canvas";

type Pt = [number, number];
const ring = (n: number, r: number, a0: number): Pt[] =>
  Array.from({ length: n }, (_, i) => { const a = a0 + (i / n) * Math.PI * 2; return [Math.cos(a) * r, Math.sin(a) * r] as Pt; });
const STAR: Pt[] = Array.from({ length: 10 }, (_, i) => {
  const a = -Math.PI / 2 + (i * Math.PI) / 5, r = i % 2 ? 0.42 : 1;
  return [Math.cos(a) * r, Math.sin(a) * r] as Pt;
});
const CROSS: Pt[] = [[-0.3, -0.95], [0.3, -0.95], [0.3, -0.3], [0.95, -0.3], [0.95, 0.3], [0.3, 0.3], [0.3, 0.95], [-0.3, 0.95], [-0.3, 0.3], [-0.95, 0.3], [-0.95, -0.3], [-0.3, -0.3]];

/** Symbol `i`'s shape in unit space (y down): filled polygons, filled circles, outlines. */
interface Shape { fill: Pt[][]; discs: [number, number, number][]; outline: { pts: Pt[] | null; circle: number; width: number } | null }
const SHAPES: Shape[] = [
  { fill: [], discs: [[0, 0, 0.82]], outline: null },                                      // ● disc
  { fill: [[[0, -0.95], [0.95, 0.75], [-0.95, 0.75]]], discs: [], outline: null },         // ▲ triangle
  { fill: [[[-0.78, -0.78], [0.78, -0.78], [0.78, 0.78], [-0.78, 0.78]]], discs: [], outline: null }, // ■ square
  { fill: [[[0, -1], [0.78, 0], [0, 1], [-0.78, 0]]], discs: [], outline: null },          // ◆ diamond
  { fill: [STAR], discs: [], outline: null },                                              // ★ star
  { fill: [CROSS], discs: [], outline: null },                                             // ✚ cross
  { fill: [[...ring(16, 0.82, Math.PI / 2).filter(([x]) => x <= 0.001), [0, -0.82]]], discs: [], outline: { pts: null, circle: 0.82, width: 0.16 } }, // ◐ half disc
  { fill: [], discs: [], outline: { pts: ring(6, 0.9, -Math.PI / 2), circle: 0, width: 0.2 } }, // ⬡ hexagon outline
];

/** Draws symbol `i` (0–7) at (cx, cy), `r` its radius, on a 2D canvas. */
export function symbolCanvas(ctx: OffscreenCanvasRenderingContext2D, i: number, cx: number, cy: number, r: number, color: string): void {
  const s = SHAPES[i % SHAPES.length]!;
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  for (const poly of s.fill) {
    ctx.beginPath();
    poly.forEach(([x, y], k) => (k ? ctx.lineTo(cx + x * r, cy + y * r) : ctx.moveTo(cx + x * r, cy + y * r)));
    ctx.closePath();
    ctx.fill();
  }
  for (const [x, y, rr] of s.discs) { ctx.beginPath(); ctx.arc(cx + x * r, cy + y * r, rr * r, 0, Math.PI * 2); ctx.fill(); }
  if (s.outline) {
    ctx.lineWidth = s.outline.width * r;
    ctx.beginPath();
    if (s.outline.pts) {
      s.outline.pts.forEach(([x, y], k) => (k ? ctx.lineTo(cx + x * r, cy + y * r) : ctx.moveTo(cx + x * r, cy + y * r)));
      ctx.closePath();
    } else ctx.arc(cx, cy, s.outline.circle * r, 0, Math.PI * 2);
    ctx.stroke();
  }
}

/** Draws symbol `i` (0–7) at (cx, cy) in window pixels, `r` its radius, with starhermit:draw. */
export function symbolDraw(i: number, cx: number, cy: number, r: number, color: string): void {
  const s = SHAPES[i % SHAPES.length]!;
  for (const poly of s.fill) draw.polygon(poly.map(([x, y]) => [cx + x * r, cy + y * r] as Pt), color);
  for (const [x, y, rr] of s.discs) draw.circle(cx + x * r, cy + y * r, rr * r, color);
  if (s.outline) {
    const w = s.outline.width * r;
    if (s.outline.pts) {
      const p = s.outline.pts;
      for (let k = 0; k < p.length; k++) {
        const a = p[k]!, b = p[(k + 1) % p.length]!;
        draw.line(cx + a[0] * r, cy + a[1] * r, cx + b[0] * r, cy + b[1] * r, color, w);
      }
    } else draw.strokeCircle(cx, cy, s.outline.circle * r, color, w);
  }
}
