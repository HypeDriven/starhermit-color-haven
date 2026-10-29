// The layered paper-art board on starhermit:scene, as the browser build's
// js/render.js drew it: the linen table, the four wooden frame slats, the
// paper tiles (one InstancedMesh, each region lifted by its palette index so
// the picture reads as stacked paper, bevelled with paper grain and a
// bump on the detailed looks), the number overlay (one transparent plane
// with a canvas of each region's number and symbol, a symbol watermark on
// filled ones), the keyboard focus ring in the selected colour with its
// ink edges, the hover ghost previewing a fill, pooled pigment puffs on
// fills, undos and the finished picture, the drifting dust motes and the
// slow sunlight drift. The camera is the authored orthographic view (52°
// above the board, the board fitted with an 8 % margin), framed into the
// playfield the HUD leaves (setViewOffset), as the browser build's canvas
// sat between its rails and tray.
//
// Gaps from three.js: none in the lights (the page's r160 values at minor 28); paper sheen
// (Ultra's MeshPhysicalMaterial) is not drawn by the engine; the post chain
// is renderer.ao / grade / antialias (its ambient occlusion also reads the
// number overlay, which the browser build's GTAO pass left out); the
// overlay's dark-ink re-weighting for linear blending is not needed (the
// engine blends the overlay as the canvas drew it).
import {
  ACESFilmicToneMapping, BoxGeometry, BufferAttribute, BufferGeometry, CanvasTexture, Color, DirectionalLight, DoubleSide,
  DynamicDrawUsage, Group, HemisphereLight, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial, MeshLambertMaterial,
  MeshStandardMaterial, OrthographicCamera, PMREMGenerator, Plane, PlaneGeometry, Points, PointsMaterial, Raycaster,
  RepeatWrapping, RingGeometry, RoomEnvironment, RoundedBoxGeometry, SRGBColorSpace, Vector3, pointerToNdc, renderer, scene,
  type Material, type Texture,
} from "starhermit:scene";
import { OffscreenCanvas } from "starhermit:canvas";
import type { Look } from "./quality.ts";
import { symbolCanvas } from "./symbols.ts";

const PI = Math.PI;
/* Authored framing constants (js/render.js CAMERA and TILE). */
const CAMERA = { TILT_DEG: 52, DIST_SCALE: 1.55, VIEW_MARGIN: 1.08 };
const TILE = { GAP: 0.06, HEIGHT: 0.16, LAYER_STEP: 0.05, FILL_LIFT: 0.06 };

export interface Level { id: string; w: number; h: number; targets: number[]; paletteSize: number }
export interface PaletteEntry { i: number; hex: number; name: string; symbol: string }
export interface Theme { id: string; bg: number; table: number; frame: number; paper: number; light: number; accent: number }
export interface BoardState { fills: number[]; selected: number | null; status: string }
export interface Ev { type: string; cell?: number }

const camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
renderer.toneMapping = ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

let look: Look | null = null;
let reducedMotion = false;
let ambientTime = 0;

// -- lights (js/render.js _buildLights), the page's three.js r160 intensities ---------------
const hemi = new HemisphereLight(0xffffff, 0x8a7a66, 0.75);
scene.add(hemi);
const KEY_INTENSITY = 1.6;
const key = new DirectionalLight(0xfff1d6, KEY_INTENSITY);
key.shadow.bias = -0.0004;
key.shadow.normalBias = 0.02;
key.shadow.radius = 3;
scene.add(key);
scene.add(key.target);
const keyBase = new Vector3(6, 12, 4);
const rim = new DirectionalLight(0xdde8ff, 0.35);
rim.position.set(-5, 6, -6);
scene.add(rim);
let envTex: Texture | null = null;

// -- the board --------------------------------------------------------------------------
interface Particle { life: number; ttl: number; x: number; y: number; z: number; vx: number; vy: number; vz: number }
interface Board {
  group: Group; level: Level; palette: PaletteEntry[]; theme: Theme; tiles: InstancedMesh;
  canvas: OffscreenCanvas; tex: CanvasTexture; drawn: number[]; ring: Mesh; ringMat: MeshBasicMaterial; ghost: Mesh; ghostMat: MeshBasicMaterial;
  particles: { mesh: InstancedMesh; data: Particle[]; cursor: number } | null;
  motes: { pts: Points; seeds: { x: number; y: number; z: number; p: number; v: number }[]; span: [number, number, number]; mat: PointsMaterial } | null;
}
let board: Board | null = null;
let lastState: BoardState | null = null;
let focusCell = -1;
let hoverCell = -1;
interface Anim { cell: number; t: number; dur: number; step: (t01: number) => void }
let anims: Anim[] = [];
const tmpM = new Matrix4();
const tmpC = new Color();

/** Deterministic procedural textures (visual only; never touch game RNG). */
function texRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
/** Cut-paper grain: near-white fibres + soft deckled edge (multiplies instance colour). */
function paperCanvas(size: number): OffscreenCanvas {
  const c = new OffscreenCanvas(size, size);
  const ctx = c.getContext("2d");
  const r = texRng(0xC0101);
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    const x = i % size, y = (i / size) | 0;
    const edge = Math.min(x, y, size - 1 - x, size - 1 - y) / size;
    const v = Math.max(0, Math.min(255, 244 + r() * 11 - (edge < 0.05 ? (0.05 - edge) * 260 : 0)));
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  ctx.lineWidth = 0.7;
  for (let k = 0; k < 40; k++) {
    ctx.strokeStyle = r() < 0.5 ? "rgba(255,255,255,0.55)" : "rgba(150,135,115,0.16)";
    const x = r() * size, y = r() * size, a = r() * PI * 2, l = 4 + r() * 12;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.quadraticCurveTo(x + Math.cos(a + 0.6) * l * 0.5, y + Math.sin(a + 0.6) * l * 0.5, x + Math.cos(a) * l, y + Math.sin(a) * l);
    ctx.stroke();
  }
  return c;
}
/** Woven linen for the table (tiles seamlessly). */
function linenCanvas(size: number): OffscreenCanvas {
  const c = new OffscreenCanvas(size, size);
  const ctx = c.getContext("2d");
  const r = texRng(0x11AE7);
  ctx.fillStyle = "#f2f2f2";
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < size; i += 2) {
    ctx.fillStyle = `rgba(255,255,255,${0.25 + r() * 0.3})`; ctx.fillRect(0, i, size, 1);
    ctx.fillStyle = `rgba(120,105,90,${0.05 + r() * 0.08})`; ctx.fillRect(i, 0, 1, size);
  }
  for (let k = 0; k < 400; k++) {
    ctx.fillStyle = r() < 0.5 ? "rgba(255,255,255,0.35)" : "rgba(110,95,80,0.08)";
    ctx.fillRect((r() * size) | 0, (r() * size) | 0, 1 + ((r() * 3) | 0), 1);
  }
  return c;
}
/** Soft wood grain for the frame slats. */
function woodCanvas(w: number, h: number): OffscreenCanvas {
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext("2d");
  const r = texRng(0x3D0D);
  ctx.fillStyle = "#ededed";
  ctx.fillRect(0, 0, w, h);
  for (let k = 0; k < 26; k++) {
    const y0 = r() * h, amp = 1 + r() * 3, f = 0.01 + r() * 0.03;
    ctx.strokeStyle = r() < 0.5 ? `rgba(90,70,50,${0.08 + r() * 0.1})` : `rgba(255,255,255,${0.25 + r() * 0.2})`;
    ctx.lineWidth = 0.6 + r() * 1.4;
    ctx.beginPath();
    for (let x = 0; x <= w; x += 4) {
      const y = y0 + Math.sin(x * f + k) * amp;
      if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  return c;
}
let shared: { key: string; paper: Texture; linen: Texture; wood: Texture } | null = null;
/** The grain textures for the look (kept across boards, made again when the sizes change). */
function textures(): { paper: Texture; linen: Texture; wood: Texture } | null {
  if (!look || !look.detailed) return null;
  const b = look.budget;
  const k = `${b.paperTexture}|${b.linenTexture}|${b.woodTexture}`;
  if (shared && shared.key === k) return shared;
  if (shared) { shared.paper.dispose(); shared.linen.dispose(); shared.wood.dispose(); }
  const mk = (canvas: OffscreenCanvas, repeat?: [number, number]): Texture => {
    const t = new CanvasTexture(canvas);
    t.colorSpace = SRGBColorSpace;
    t.wrapS = t.wrapT = RepeatWrapping;
    if (repeat) t.repeat.set(repeat[0], repeat[1]);
    t.anisotropy = 4;
    return t;
  };
  shared = { key: k, paper: mk(paperCanvas(b.paperTexture)), linen: mk(linenCanvas(b.linenTexture), [48, 48]), wood: mk(woodCanvas(b.woodTexture, b.woodTexture / 4)) };
  return shared;
}

interface LitParams { color?: number; roughness: number; metalness?: number; map?: Texture | null; envMapIntensity: number; bumpMap?: Texture | null; bumpScale?: number }
/** Lit material for the look's budget: Lambert on Low, standard above. */
function lit(p: LitParams): Material {
  if (!look || look.budget.material === "lambert") return new MeshLambertMaterial({ ...(p.color != null ? { color: p.color } : {}), map: p.map ?? null });
  return new MeshStandardMaterial({
    ...(p.color != null ? { color: p.color } : {}), roughness: p.roughness, metalness: p.metalness ?? 0, map: p.map ?? null,
    // r160 scaled scene.environment by each material's envMapIntensity: give each its own envMap.
    envMap: look.studio ? envTex : null, envMapIntensity: p.envMapIntensity, bumpMap: p.bumpMap ?? null, bumpScale: p.bumpScale ?? 1,
  });
}

function cellXY(i: number, w: number): { x: number; y: number } { return { x: i % w, y: Math.floor(i / w) }; }
function cellTopY(i: number): number { return board!.level.targets[i]! * TILE.LAYER_STEP + TILE.HEIGHT / 2; }
function cellWorld(i: number): Vector3 {
  const b = board!;
  const { x, y } = cellXY(i, b.level.w);
  return new Vector3(x - (b.level.w - 1) / 2, cellTopY(i), y - (b.level.h - 1) / 2);
}

function disposeBoard(): void {
  if (!board) return;
  board.group.traverse((o) => {
    const m = o as Mesh;
    if (m.geometry) m.geometry.dispose();
    const mat = (m as { material?: Material | Material[] }).material;
    if (mat) for (const x of Array.isArray(mat) ? mat : [mat]) x.dispose();
  });
  board.tex.dispose();
  scene.remove(board.group);
  board = null;
  anims = [];
}

/** Builds the level's scene (js/render.js buildBoard): palette [{hex}], theme colours. */
export function buildBoard(level: Level, palette: PaletteEntry[], theme: Theme): void {
  disposeBoard();
  if (!look) { board = null; pending = { level, palette, theme }; return; }
  pending = null;
  const w = level.w, h = level.h, n = w * h;
  const g = new Group();
  scene.add(g);
  scene.background = new Color(theme.bg);
  key.color.set(theme.light);
  const detailed = look.detailed;
  const tex = textures();
  const bevel = look.budget.bevel;

  // Environment: the table under the board.
  const table = new Mesh(new PlaneGeometry(120, 120), lit({ color: theme.table, roughness: 0.95, map: tex ? tex.linen : null, envMapIntensity: 0.15 }));
  table.rotation.x = -PI / 2;
  table.position.y = -0.28;
  table.receiveShadow = true;
  g.add(table);

  // Frame: four paper slats around the board.
  const frameMat = lit({ color: theme.frame, roughness: detailed ? 0.62 : 0.8, map: tex ? tex.wood : null, envMapIntensity: 0.6 });
  const fw = w + 0.6, fh = h + 0.6, ft = 0.34;
  const slat = (sw: number, sh: number, x: number, z: number): void => {
    // Built long along x and turned when vertical, so the wood grain follows the slat.
    const turn = sh > sw;
    const L = turn ? sh : sw, D = turn ? sw : sh;
    const m = new Mesh(detailed ? new RoundedBoxGeometry(L, ft, D, bevel, 0.05) : new BoxGeometry(L, ft, D), frameMat);
    if (turn) m.rotation.y = PI / 2;
    m.position.set(x, -ft / 2 + 0.02, z);
    m.castShadow = true;
    m.receiveShadow = true;
    g.add(m);
  };
  slat(fw, 0.3, 0, -fh / 2 + 0.15); slat(fw, 0.3, 0, fh / 2 - 0.15);
  slat(0.3, fh, -fw / 2 + 0.15, 0); slat(0.3, fh, fw / 2 - 0.15, 0);

  // Paper tiles: one InstancedMesh, per-instance colour and matrix.
  const size = 1 - TILE.GAP;
  const geo = detailed ? new RoundedBoxGeometry(size, TILE.HEIGHT, size, bevel, 0.035) : new BoxGeometry(size, TILE.HEIGHT, size);
  const mat = lit({ roughness: 0.9, map: tex ? tex.paper : null, envMapIntensity: 0.3, bumpMap: detailed && tex ? tex.paper : null, bumpScale: detailed ? 1.2 : 0 });
  const tiles = new InstancedMesh(geo, mat, n);
  tiles.castShadow = true;
  tiles.receiveShadow = true;
  tiles.instanceMatrix.setUsage(DynamicDrawUsage);
  g.add(tiles);
  const paper = new Color(theme.paper);
  for (let i = 0; i < n; i++) {
    const { x, y } = cellXY(i, w);
    tmpM.makeTranslation(x - (w - 1) / 2, level.targets[i]! * TILE.LAYER_STEP, y - (h - 1) / 2);
    tiles.setMatrixAt(i, tmpM);
    tiles.setColorAt(i, paper);
  }
  tiles.instanceMatrix.needsUpdate = true;
  if (tiles.instanceColor) tiles.instanceColor.needsUpdate = true;

  // Number overlay: one transparent plane with a canvas texture.
  const px = Math.min(2048, Math.max(512, look.budget.overlayCell * w));
  const canvas = new OffscreenCanvas(px, px);
  const otex = new CanvasTexture(canvas);
  otex.colorSpace = SRGBColorSpace;
  otex.anisotropy = 4;
  const overlay = new Mesh(new PlaneGeometry(w, h), new MeshBasicMaterial({ map: otex, transparent: true, depthWrite: false }));
  overlay.rotation.x = -PI / 2;
  overlay.position.y = (palette.length - 1) * TILE.LAYER_STEP + TILE.HEIGHT / 2 + TILE.FILL_LIFT + 0.02;
  overlay.renderOrder = 2;
  g.add(overlay);

  // Selection ring with thin ink edges, and the hover ghost.
  const ringMat = new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, side: DoubleSide, depthWrite: false });
  const ring = new Mesh(new RingGeometry(0.42, 0.55, 32), ringMat);
  ring.rotation.x = -PI / 2;
  ring.visible = false;
  ring.renderOrder = 3;
  const edgeMat = new MeshBasicMaterial({ color: 0x3d332a, transparent: true, opacity: 0.6, side: DoubleSide, depthWrite: false });
  for (const [r0, r1] of [[0.55, 0.59], [0.38, 0.42]] as const) {
    const edge = new Mesh(new RingGeometry(r0, r1, 32), edgeMat);
    edge.renderOrder = 3;
    ring.add(edge);
  }
  g.add(ring);
  const ghostMat = new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, depthWrite: false });
  const ghost = new Mesh(new PlaneGeometry(size, size), ghostMat);
  ghost.rotation.x = -PI / 2;
  ghost.visible = false;
  ghost.renderOrder = 3;
  g.add(ghost);

  // Pooled pigment puffs.
  const pCount = look.budget.particles;
  let particles: Board["particles"] = null;
  if (pCount > 0) {
    const mesh = new InstancedMesh(new PlaneGeometry(0.12, 0.12), new MeshBasicMaterial({ transparent: true, opacity: 0.85, depthWrite: false }), pCount);
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    mesh.frustumCulled = false;
    const zero = new Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < pCount; i++) { mesh.setMatrixAt(i, zero); mesh.setColorAt(i, paper); }
    mesh.instanceMatrix.needsUpdate = true;
    g.add(mesh);
    particles = { mesh, data: Array.from({ length: pCount }, () => ({ life: 0, ttl: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 })), cursor: 0 };
  }

  // Ambient dust motes drifting in the sunlight.
  let motes: Board["motes"] = null;
  if (look.ambient && look.budget.motes > 0) {
    const count = look.budget.motes;
    const top = (palette.length - 1) * TILE.LAYER_STEP;
    const r = texRng(w * 131 + h);
    const pos = new Float32Array(count * 3);
    const seeds = [];
    for (let i = 0; i < count; i++) {
      const s = { x: (r() - 0.5) * (w + 2), y: top + 0.4 + r() * 3.5, z: (r() - 0.5) * (h + 2), p: r() * PI * 2, v: 0.06 + r() * 0.1 };
      seeds.push(s);
      pos[i * 3] = s.x; pos[i * 3 + 1] = s.y; pos[i * 3 + 2] = s.z;
    }
    const mgeo = new BufferGeometry();
    const attr = new BufferAttribute(pos, 3);
    attr.setUsage(DynamicDrawUsage);
    mgeo.setAttribute("position", attr);
    const mmat = new PointsMaterial({ color: 0xfff4dc, size: 2.5, sizeAttenuation: false, transparent: true, opacity: 0.3, depthWrite: false });
    const pts = new Points(mgeo, mmat);
    pts.frustumCulled = false;
    g.add(pts);
    motes = { pts, seeds, span: [w + 2, h + 2, top], mat: mmat };
  }

  board = { group: g, level, palette, theme, tiles, canvas, tex: otex, drawn: new Array(n).fill(-1), ring, ringMat, ghost, ghostMat, particles, motes };
  fitShadow();
  applyAmbient();
  hoverCell = -1;
  focusCell = -1;
  frameCamera();
}
let pending: { level: Level; palette: PaletteEntry[]; theme: Theme } | null = null;

/** Point the key light at the board and fit its shadow box tightly to it. */
function fitShadow(): void {
  const w = board ? board.level.w : 8, h = board ? board.level.h : 8;
  const half = Math.hypot(w + 1, h + 1) / 2 + 0.5;
  keyBase.copy(new Vector3(0.55, 0.66, 0.42).normalize()).multiplyScalar(half * 2 + 6);
  key.position.copy(keyBase);
  key.target.position.set(0, 0, 0);
  const cam = key.shadow.camera;
  Object.assign(cam, { left: -half, right: half, top: half, bottom: -half, near: 0.5, far: half * 4 + 12 });
  cam.updateProjectionMatrix();
}

// -- camera and playfield -------------------------------------------------------------------
let view = { x: 0, y: 0, w: 1, h: 1, W: 1, H: 1 };
function frameCamera(): void {
  const b = board;
  const w = b ? b.level.w : 8, h = b ? b.level.h : 8;
  const dist = Math.hypot(w, h) * CAMERA.DIST_SCALE;
  const tilt = (CAMERA.TILT_DEG * PI) / 180;
  camera.position.set(0, Math.sin(tilt) * dist, Math.cos(tilt) * dist);
  camera.lookAt(new Vector3(0, 0, 0));
  camera.near = 0.1;
  camera.far = dist * 3 + 20;
  const span = (Math.max(w, h) / 2) * CAMERA.VIEW_MARGIN;
  const aspect = view.w / view.h;
  let hw: number, hh: number;
  if (aspect >= 1) { hh = span; hw = span * aspect; } else { hw = span; hh = span / aspect; }
  camera.left = -hw; camera.right = hw; camera.top = hh; camera.bottom = -hh;
  camera.setViewOffset(view.w, view.h, -view.x, -view.y, view.W, view.H);
  camera.updateProjectionMatrix();
}
/** The playfield (window pixels) the board is framed into, within the W × H window. */
export function setPlayfield(x: number, y: number, w: number, h: number, W: number, H: number): void {
  const next = { x, y, w: Math.max(1, w), h: Math.max(1, h), W: Math.max(1, W), H: Math.max(1, H) };
  if (Object.entries(next).every(([k, v]) => Math.abs(v - (view as Record<string, number>)[k]!) < 0.5)) return;
  view = next;
  frameCamera();
}
/** Re-center (the C key): the authored framing again (the board always fits; nothing pans). */
export function resetCamera(): void { frameCamera(); }
/** Whether the board draws (only in a round: the title sits on its own art). */
export function setActive(on: boolean): void { renderer.camera = on ? camera : null; }

const ray = new Raycaster();
const ground = new Plane(new Vector3(0, 1, 0), 0);
const hit = new Vector3();
/** The cell under a window pixel, or −1 (js/render.js pick: the board plane at y = 0). */
export function pick(x: number, y: number): number {
  const b = board;
  if (!b || !renderer.camera || x < view.x || y < view.y || x > view.x + view.w || y > view.y + view.h) return -1;
  ray.setFromCamera(pointerToNdc(x, y), camera);
  if (!ray.ray.intersectPlane(ground, hit)) return -1;
  const cx = Math.round(hit.x + (b.level.w - 1) / 2);
  const cy = Math.round(hit.z + (b.level.h - 1) / 2);
  if (cx < 0 || cx >= b.level.w || cy < 0 || cy >= b.level.h) return -1;
  return cy * b.level.w + cx;
}

// -- state sync and animations --------------------------------------------------------------
/** Applies a state: final tile colours and heights, the numbers, then the events' animations. */
export function syncState(state: BoardState, events: Ev[] = []): void {
  const b = board;
  lastState = state;
  if (!b) return;
  const paper = new Color(b.theme.paper);
  for (let i = 0; i < b.level.targets.length; i++) {
    b.tiles.setColorAt(i, state.fills[i] ? tmpC.set(b.palette[b.level.targets[i]!]!.hex) : paper);
    setTileFinal(i, state);
  }
  if (b.tiles.instanceColor) b.tiles.instanceColor.needsUpdate = true;
  b.tiles.instanceMatrix.needsUpdate = true;
  drawNumbers(state);
  for (const ev of events) {
    if ((ev.type === "fill" || ev.type === "hint") && ev.cell != null) animateFill(ev.cell);
    if (ev.type === "undo" && ev.cell != null && !reducedMotion) spawnPuff(ev.cell, 4);
    if (ev.type === "invalid" && ev.cell != null) animateInvalid(ev.cell);
    if (ev.type === "complete") celebrate();
  }
  updateMarkers(state);
}
function setTileFinal(i: number, state: BoardState): void {
  const b = board!;
  const { x, y } = cellXY(i, b.level.w);
  const lift = state.fills[i] ? TILE.FILL_LIFT : 0;
  tmpM.makeTranslation(x - (b.level.w - 1) / 2, b.level.targets[i]! * TILE.LAYER_STEP + lift, y - (b.level.h - 1) / 2);
  b.tiles.setMatrixAt(i, tmpM);
  anims = anims.filter((a) => a.cell !== i); // the end state wins
}
function animateFill(cell: number): void {
  if (reducedMotion) return;
  const b = board!;
  const base = b.level.targets[cell]! * TILE.LAYER_STEP;
  const from = base + 0.35, to = base + TILE.FILL_LIFT;
  const { x, y } = cellXY(cell, b.level.w);
  anims.push({
    cell, t: 0, dur: 0.26,
    step: (t) => {
      const e = 1 - Math.pow(1 - t, 3);
      tmpM.makeTranslation(x - (b.level.w - 1) / 2, from + (to - from) * e, y - (b.level.h - 1) / 2);
      b.tiles.setMatrixAt(cell, tmpM);
      b.tiles.instanceMatrix.needsUpdate = true;
    },
  });
  spawnPuff(cell, 10);
}
function animateInvalid(cell: number): void {
  if (reducedMotion) return;
  const b = board!;
  const base = b.level.targets[cell]! * TILE.LAYER_STEP;
  const { x, y } = cellXY(cell, b.level.w);
  anims.push({
    cell, t: 0, dur: 0.3,
    step: (t) => {
      const wobble = Math.sin(t * PI * 4) * (1 - t) * 0.05;
      tmpM.makeTranslation(x - (b.level.w - 1) / 2 + wobble, base, y - (b.level.h - 1) / 2);
      b.tiles.setMatrixAt(cell, tmpM);
      b.tiles.instanceMatrix.needsUpdate = true;
    },
  });
}
function celebrate(): void {
  const b = board;
  if (!b || reducedMotion) return;
  for (let k = 0; k < 6; k++) spawnPuff(Math.floor(Math.random() * b.level.targets.length), 24);
}
function spawnPuff(cell: number, count: number): void {
  const b = board;
  const p = b && b.particles;
  if (!b || !p) return;
  const o = cellWorld(cell);
  tmpC.set(b.palette[b.level.targets[cell]!]!.hex);
  for (let k = 0; k < count; k++) {
    const d = p.data[p.cursor]!;
    d.life = 0; d.ttl = 0.5 + Math.random() * 0.5;
    d.x = o.x; d.y = o.y + 0.15; d.z = o.z;
    const a = Math.random() * PI * 2, sp = 0.6 + Math.random() * 1.4;
    d.vx = Math.cos(a) * sp; d.vz = Math.sin(a) * sp; d.vy = 1.2 + Math.random() * 1.6;
    p.mesh.setColorAt(p.cursor, tmpC);
    p.cursor = (p.cursor + 1) % p.data.length;
  }
  if (p.mesh.instanceColor) p.mesh.instanceColor.needsUpdate = true;
}

/** Hover preview: the cell's colour ghosted over it while a colour is selected. */
export function setHover(cell: number): void {
  const b = board, state = lastState;
  if (!b) return;
  hoverCell = cell;
  const show = cell >= 0 && !!state && !state.fills[cell] && state.selected != null && state.status === "active";
  b.ghost.visible = show;
  if (show) {
    const pos = cellWorld(cell);
    b.ghost.position.set(pos.x, pos.y + TILE.FILL_LIFT + 0.03, pos.z);
    b.ghostMat.color.set(b.palette[b.level.targets[cell]!]!.hex);
    b.ghostMat.opacity = b.level.targets[cell] === state!.selected ? 0.45 : 0.15;
  }
}
export function hovered(): number { return hoverCell; }
/** Keyboard / gamepad focus ring (−1: none). */
export function setFocusCell(cell: number): void {
  const b = board;
  focusCell = cell;
  if (!b) return;
  if (cell >= 0) {
    const pos = cellWorld(cell);
    b.ring.position.set(pos.x, pos.y + TILE.FILL_LIFT + 0.04, pos.z);
    b.ring.visible = !lastState || lastState.status === "active";
  } else b.ring.visible = false;
}
function updateMarkers(state: BoardState): void {
  const b = board!;
  if (focusCell >= 0 && state.status === "active") {
    setFocusCell(focusCell);
    b.ringMat.color.set(state.selected != null ? b.palette[state.selected]!.hex : 0xffffff);
  } else if (state.status !== "active") {
    b.ring.visible = false;
    b.ghost.visible = false;
  }
  if (hoverCell >= 0) setHover(hoverCell);
}

/** The number overlay: each region's number and symbol on bare paper, a light symbol watermark once filled. Only changed cells are redrawn. */
function drawNumbers(state: BoardState): void {
  const b = board!;
  const { canvas, level, palette } = b;
  const ctx = canvas.getContext("2d");
  const w = level.w;
  const cellPx = canvas.width / w;
  let dirty = false;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (let i = 0; i < level.targets.length; i++) {
    const f = state.fills[i] ? 1 : 0;
    if (b.drawn[i] === f) continue;
    b.drawn[i] = f;
    dirty = true;
    const { x, y } = cellXY(i, w);
    const cx = (x + 0.5) * cellPx, cy = (y + 0.5) * cellPx;
    const t = level.targets[i]!;
    ctx.clearRect(x * cellPx, y * cellPx, cellPx, cellPx);
    if (!f) {
      // The browser build re-weighted dark ink for its linear-light post chain so the numbers kept their
      // weight; here the ink is drawn fully opaque and a step bolder for the same effect.
      ctx.fillStyle = "rgb(70,58,48)";
      ctx.font = `700 ${cellPx * 0.42}px sans-serif`;
      ctx.fillText(String(t + 1), cx, cy - cellPx * 0.1);
      symbolCanvas(ctx, palette[t]!.i, cx, cy + cellPx * 0.26, cellPx * 0.085, "rgba(70,58,48,0.7)");
    } else {
      symbolCanvas(ctx, palette[t]!.i, cx, cy, cellPx * 0.13, "rgba(255,255,255,0.35)");
    }
  }
  if (dirty) b.tex.needsUpdate = true;
}

// -- the look ---------------------------------------------------------------------------------
function applyAmbient(): void {
  const on = !!look && look.ambient && !reducedMotion;
  if (board && board.motes) board.motes.pts.visible = on;
  if (!on) { key.position.copy(keyBase); key.intensity = KEY_INTENSITY; }
}
export function applyLook(next: Look): void {
  if (look && JSON.stringify(look) === JSON.stringify(next)) return;
  look = next;
  const shadows = next.shadows > 0;
  renderer.shadowMap.enabled = shadows;
  key.castShadow = shadows;
  if (shadows) key.shadow.mapSize = next.shadows;
  key.shadow.radius = next.shadows >= 4096 ? 4 : 3;
  if (next.studio) {
    if (!envTex) {
      try { envTex = new PMREMGenerator(renderer).fromScene(new RoomEnvironment(renderer), 0.04).texture; }
      catch (e) { console.warn("environment:", e instanceof Error ? e.message : String(e)); }
    }
    scene.environment = envTex;
    hemi.intensity = 0.3;
    renderer.toneMappingExposure = 0.92;
  } else {
    scene.environment = null;
    hemi.intensity = 0.75;
    renderer.toneMappingExposure = 1.05;
  }
  renderer.ao = next.ao === "off" ? null : {
    blendIntensity: next.ao === "high" ? 0.85 : 0.7, radius: 0.45, distanceExponent: 1.4, thickness: 0.6, scale: 1.0,
    samples: next.ao === "high" ? 16 : 8, resolution: next.budget.aoRes,
    denoise: { lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: next.ao === "high" ? 6 : 4, rings: 2, samples: next.ao === "high" ? 16 : 8, radiusExponent: 2 },
  };
  // The browser build's warm paper grade (display space): a gentle S-curve,
  // a touch more saturation, cool lows / warm highs, the 0.2 vignette.
  renderer.grade = next.grade ? {
    space: "display", contrast: 0.07, saturation: 1.07,
    shadows: [0.98, 0.99, 1.02], highlights: [1.02, 1.0, 0.975], split: [0.25, 0.85],
    vignette: { amount: 0.2, inner: 0.4, outer: 0.9 },
  } : null;
  renderer.antialias = next.antialias;
  // Asset variants (materials, grain, bevels, overlay size, pools) live in the board: build it again.
  const b = board ?? (pending ? { level: pending.level, palette: pending.palette, theme: pending.theme } : null);
  if (b) {
    const focus = focusCell;
    buildBoard(b.level, b.palette, b.theme);
    if (focus >= 0) setFocusCell(focus);
    if (lastState) syncState(lastState, []);
  }
}
/** Whether the look has ambient motion (the title's petals follow it). */
export function ambientLook(): boolean { return !!look && look.ambient; }
export function setReducedMotion(on: boolean): void {
  reducedMotion = on;
  if (on && board) {
    for (const a of anims) a.step(1);
    anims = [];
  }
  applyAmbient();
}
/** Leaves the round: nothing on the table. */
export function clear(): void { disposeBoard(); pending = null; lastState = null; focusCell = -1; hoverCell = -1; }

// -- the frame --------------------------------------------------------------------------------
/** Cosmetic animation, `dt` seconds: tile drops and wobbles, puffs, motes and the drifting sunlight. */
export function update(dtIn: number): void {
  const dt = Math.min(0.1, Math.max(0, dtIn));
  for (let i = anims.length - 1; i >= 0; i--) {
    const a = anims[i]!;
    a.t += dt;
    const t01 = Math.min(1, a.t / a.dur);
    a.step(t01);
    if (t01 >= 1) anims.splice(i, 1);
  }
  const b = board;
  if (!b) return;
  const p = b.particles;
  if (p) {
    let any = false;
    for (let i = 0; i < p.data.length; i++) {
      const d = p.data[i]!;
      if (d.ttl <= 0) continue;
      d.life += dt;
      any = true;
      if (d.life >= d.ttl) { d.ttl = 0; tmpM.makeScale(0, 0, 0); p.mesh.setMatrixAt(i, tmpM); continue; }
      d.x += d.vx * dt; d.y += d.vy * dt; d.z += d.vz * dt;
      d.vy -= 3.2 * dt;
      const s = 1 - d.life / d.ttl;
      tmpM.makeScale(s, s, s).setPosition(d.x, d.y, d.z);
      p.mesh.setMatrixAt(i, tmpM);
    }
    if (any) p.mesh.instanceMatrix.needsUpdate = true;
  }
  if (!look || !look.ambient || reducedMotion) return;
  ambientTime += dt;
  const t = ambientTime;
  // Sunlight through a window: the key drifts a little and breathes in strength.
  key.position.set(keyBase.x + Math.sin(t * 0.07) * 1.2, keyBase.y, keyBase.z + Math.cos(t * 0.05) * 0.9);
  key.intensity = (1.6 + Math.sin(t * 0.31) * 0.04 + Math.sin(t * 0.83) * 0.02);
  const m = b.motes;
  if (!m) return;
  const pos = m.pts.geometry.getAttribute("position") as BufferAttribute;
  const [sw, sh, top] = m.span;
  m.seeds.forEach((s, i) => {
    s.y += s.v * dt * 0.35;
    s.x += Math.sin(t * 0.4 + s.p) * 0.12 * dt;
    s.z += Math.cos(t * 0.3 + s.p) * 0.1 * dt;
    if (s.y > top + 4) s.y = top + 0.3;
    if (s.x > sw / 2) s.x -= sw; else if (s.x < -sw / 2) s.x += sw;
    if (s.z > sh / 2) s.z -= sh; else if (s.z < -sh / 2) s.z += sh;
    pos.setXYZ(i, s.x, s.y, s.z);
  });
  pos.needsUpdate = true;
  m.mat.opacity = 0.26 + Math.sin(t * 0.5) * 0.06;
}
