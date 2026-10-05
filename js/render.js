/**
 * Color Haven — render module (Three.js).
 * Layered paper-art board: instanced paper tiles, a canvas-drawn number
 * overlay, selection ring + hover ghost, pooled pigment-puff particles.
 * Graphics settings (gfx.js) drive shadows, studio image-based lighting,
 * paper detail, an optional post chain (GTAO → colour grade → SMAA/FXAA),
 * ambient motion and adaptive resolution. No bloom: the art rules out glow.
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { detectPreset, resolve, describe, pixelRatio, SHADOW_MAP, PARTICLE_POOL } from './gfx.js';

/* Authored framing constants (no magic offsets scattered in code). */
export const CAMERA = {
  TILT_DEG: 52,          // elevation of the camera above the board plane
  DIST_SCALE: 1.55,      // camera distance as multiple of board diagonal
  VIEW_MARGIN: 1.08,     // orthographic frustum padding around the board
  INTRO_MS: 900,
  TRANSITION_MS: 450,
};

const TILE = {
  GAP: 0.06,             // fraction of cell used as visible paper gap
  HEIGHT: 0.16,          // base paper thickness
  LAYER_STEP: 0.05,      // height step per palette index (paper layering)
  FILL_LIFT: 0.06,       // extra lift when pigment is applied
  HOVER_LIFT: 0.10,
  SELECT_LIFT: 0.06,
};

// Warm paper grade + vignette, applied in display space (after OutputPass).
// Adds a little contrast and saturation; never flattens pieces or numbers.
const GradeShader = {
  uniforms: { tDiffuse: { value: null }, uVignette: { value: 0.2 } },
  vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uVignette;
    varying vec2 vUv;
    void main() {
      vec4 src = texture2D(tDiffuse, vUv);
      vec3 c = clamp(src.rgb, 0.0, 1.0);
      c = mix(c, c * c * (3.0 - 2.0 * c), 0.14);                 // gentle S-curve
      float l = dot(c, vec3(0.299, 0.587, 0.114));
      c = mix(vec3(l), c, 1.07);                                  // a touch more saturation
      c *= mix(vec3(0.98, 0.99, 1.02), vec3(1.02, 1.0, 0.975), smoothstep(0.25, 0.85, l)); // warm highs, cool lows
      float d = length(vUv - 0.5);
      c *= 1.0 - uVignette * smoothstep(0.4, 0.9, d);
      gl_FragColor = vec4(clamp(c, 0.0, 1.0), src.a);
    }`,
};

// GTAO that ignores cosmetic layers (number overlay, markers, particles, motes)
// so ambient occlusion reads the paper geometry, not the flat overlay plane.
class PaperGTAOPass extends GTAOPass {
  overrideVisibility() {
    super.overrideVisibility();
    this.scene.traverse((o) => { if (o.userData.noAO) o.visible = false; });
  }
}

/* Deterministic procedural textures (visual only; never touch game RNG). */
function texRng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** Cut-paper grain: near-white fibres + soft deckled edge (multiplies instance colour). */
function paperCanvas(size = 128) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const r = texRng(0xC0101);
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    const x = i % size, y = (i / size) | 0;
    const edge = Math.min(x, y, size - 1 - x, size - 1 - y) / size;
    const v = 244 + r() * 11 - (edge < 0.05 ? (0.05 - edge) * 260 : 0);
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = Math.max(0, Math.min(255, v));
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  ctx.lineWidth = 0.7;
  for (let k = 0; k < 40; k++) {
    ctx.strokeStyle = r() < 0.5 ? 'rgba(255,255,255,0.55)' : 'rgba(150,135,115,0.16)';
    const x = r() * size, y = r() * size, a = r() * Math.PI * 2, l = 4 + r() * 12;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.quadraticCurveTo(x + Math.cos(a + 0.6) * l * 0.5, y + Math.sin(a + 0.6) * l * 0.5, x + Math.cos(a) * l, y + Math.sin(a) * l);
    ctx.stroke();
  }
  return c;
}

/** Woven linen for the table (tiles seamlessly). */
function linenCanvas(size = 128) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const r = texRng(0x11AE7);
  ctx.fillStyle = '#f2f2f2';
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < size; i += 2) {
    ctx.fillStyle = `rgba(255,255,255,${0.25 + r() * 0.3})`; ctx.fillRect(0, i, size, 1);
    ctx.fillStyle = `rgba(120,105,90,${0.05 + r() * 0.08})`; ctx.fillRect(i, 0, 1, size);
  }
  for (let k = 0; k < 400; k++) {
    ctx.fillStyle = r() < 0.5 ? 'rgba(255,255,255,0.35)' : 'rgba(110,95,80,0.08)';
    ctx.fillRect((r() * size) | 0, (r() * size) | 0, 1 + ((r() * 3) | 0), 1);
  }
  return c;
}

/** Soft wood grain for the frame slats. */
function woodCanvas(w = 256, h = 64) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  const r = texRng(0x3D0D);
  ctx.fillStyle = '#ededed';
  ctx.fillRect(0, 0, w, h);
  for (let k = 0; k < 26; k++) {
    const y0 = r() * h, amp = 1 + r() * 3, f = 0.01 + r() * 0.03;
    ctx.strokeStyle = r() < 0.5 ? `rgba(90,70,50,${0.08 + r() * 0.1})` : `rgba(255,255,255,${0.25 + r() * 0.2})`;
    ctx.lineWidth = 0.6 + r() * 1.4;
    ctx.beginPath();
    for (let x = 0; x <= w; x += 4) {
      const y = y0 + Math.sin(x * f + k) * amp;
      x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  return c;
}

function hexCss(hex) { return '#' + hex.toString(16).padStart(6, '0'); }

export class PaperRenderer {
  constructor(container, opts = {}) {
    this.container = container;
    this.reducedMotion = !!opts.reducedMotion;
    this.saved = opts.gfx || {};

    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
    this.camera.layers.enableAll(); // 0 env, 1 gameplay, 2 selection, 3 effects

    this.raycaster = new THREE.Raycaster();
    this._pointer = new THREE.Vector2();

    // Layers: 0 env, 1 gameplay, 2 selection/ghost, 3 effects.
    this._anims = [];        // active tile tweens
    this._cameraAnim = null;
    this._particles = null;
    this._board = null;      // per-level bundle
    this._lastState = null;
    this._hoverCell = -1;
    this._focusCell = -1;    // keyboard focus marker
    this._clockLast = performance.now();
    this._time = 0;
    this._running = false;
    this._disposed = false;

    // Graphics state.
    this.composer = null;
    this.postKey = null;
    this.postFailed = false;
    this.pixelRatio = 0;
    this.adaptiveScale = 1;
    this._frames = [];
    this._size = [0, 0];
    this.fps = 0;
    this._gfxListeners = [];

    this.q = resolve(this.saved, 'low');
    this._createRenderer(this.q.antialias === 'msaa' && !this.q.post);
    this.gpu = this._readGpu();
    const mobile = (window.matchMedia && matchMedia('(pointer: coarse)').matches && !matchMedia('(any-pointer: fine)').matches) ||
      /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '');
    this.detected = detectPreset(this.gpu, mobile);

    this._buildLights();
    this.setGraphics(this.saved);
    this._onResize = this.resize.bind(this);
    window.addEventListener('resize', this._onResize);
    // The host box also changes without a window resize (coach banner space,
    // chat sidebar, drawers): follow it directly.
    if (typeof ResizeObserver === 'function') {
      this._ro = new ResizeObserver(() => this.resize());
      this._ro.observe(this.container);
    }
  }

  /** (Re)create the WebGL renderer; canvas MSAA is a context-creation option. */
  _createRenderer(msaa) {
    const old = this.renderer;
    this._msaa = !!msaa;
    this.renderer = new THREE.WebGLRenderer({ antialias: this._msaa, alpha: false, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.setAttribute('aria-hidden', 'true');
    if (old) {
      this.composer?.dispose();
      this.composer = null;
      this.postKey = null;
      if (this._envRT) { this._envRT.dispose(); this._envRT = null; this.scene.environment = null; }
      this.container.replaceChild(this.renderer.domElement, old.domElement);
      old.dispose();
    } else {
      this.container.appendChild(this.renderer.domElement);
    }
    this.pixelRatio = 0; // force a resize on the next frame
  }

  _readGpu() {
    try {
      const gl = this.renderer.getContext();
      // Firefox exposes the unmasked name as RENDERER (and warns on the extension).
      if (/firefox/i.test(navigator.userAgent || '')) return String(gl.getParameter(gl.RENDERER) || '');
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) || '';
    } catch { return ''; }
  }

  /* -------------------------------------------------------------- */
  /* Lighting: one dominant key, soft environment fill, grounding.   */
  /* -------------------------------------------------------------- */
  _buildLights() {
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x8a7a66, 0.75);
    this.scene.add(this.hemi);
    this.key = new THREE.DirectionalLight(0xfff1d6, 1.6);
    this.key.position.set(6, 12, 4);
    this.key.shadow.bias = -0.0004;
    this.key.shadow.normalBias = 0.02;
    this.key.shadow.radius = 3;
    this.scene.add(this.key);
    this.scene.add(this.key.target);
    this._keyBase = new THREE.Vector3(6, 12, 4);
    this.rim = new THREE.DirectionalLight(0xdde8ff, 0.35);
    this.rim.position.set(-5, 6, -6);
    this.scene.add(this.rim);
  }

  /** Point the key light at the board and fit its shadow box tightly to it. */
  _fitShadow() {
    const b = this._board;
    const w = b ? b.level.w : 8, h = b ? b.level.h : 8;
    const half = Math.hypot(w + 1, h + 1) / 2 + 0.5;
    const dir = new THREE.Vector3(0.55, 0.66, 0.42).normalize();
    this._keyBase.copy(dir).multiplyScalar(half * 2 + 6);
    this.key.position.copy(this._keyBase);
    this.key.target.position.set(0, 0, 0);
    this.key.target.updateMatrixWorld();
    const cam = this.key.shadow.camera;
    Object.assign(cam, { left: -half, right: half, top: half, bottom: -half, near: 0.5, far: half * 4 + 12 });
    cam.updateProjectionMatrix();
  }

  /* -------------------------------------------------------------- */
  /* Board construction                                              */
  /* -------------------------------------------------------------- */

  /**
   * Build the level scene. palette: [{hex,name,symbol}], theme: theme object.
   */
  buildBoard(level, palette, theme) {
    this._disposeBoard();
    const w = level.w, h = level.h, n = w * h;
    const g = new THREE.Group();
    this.scene.add(g);

    // Environment: table + backdrop (env layer).
    this.scene.background = new THREE.Color(theme.bg);
    this.key.color.set(theme.light);
    const detailed = this.q.detail === 'detailed';
    const ptex = this._textures(detailed);
    const table = new THREE.Mesh(
      new THREE.PlaneGeometry(120, 120),
      new THREE.MeshStandardMaterial({ color: theme.table, roughness: 0.95, metalness: 0, map: ptex.linen, envMapIntensity: 0.15 })
    );
    table.rotation.x = -Math.PI / 2;
    table.position.y = -0.28;
    table.receiveShadow = true;
    table.layers.set(0);
    g.add(table);

    // Frame: four paper slats around the board.
    const frameMat = new THREE.MeshStandardMaterial({ color: theme.frame, roughness: detailed ? 0.62 : 0.8, map: ptex.wood, envMapIntensity: 0.6 });
    const fw = w + 0.6, fh = h + 0.6, ft = 0.34;
    const mkSlat = (sw, sh, x, z) => {
      // Build each slat long along x and turn the vertical ones, so wood grain follows the slat.
      const turn = sh > sw;
      const L = turn ? sh : sw, D = turn ? sw : sh;
      const m = new THREE.Mesh(detailed ? new RoundedBoxGeometry(L, ft, D, 2, 0.05) : new THREE.BoxGeometry(L, ft, D), frameMat);
      if (turn) m.rotation.y = Math.PI / 2;
      m.position.set(x, -ft / 2 + 0.02, z);
      m.castShadow = true;
      m.receiveShadow = true;
      m.layers.set(0);
      g.add(m);
    };
    mkSlat(fw, 0.3, 0, -fh / 2 + 0.15); mkSlat(fw, 0.3, 0, fh / 2 - 0.15);
    mkSlat(0.3, fh, -fw / 2 + 0.15, 0); mkSlat(0.3, fh, fw / 2 - 0.15, 0);

    // Paper tiles: one InstancedMesh; per-instance color + matrix.
    const size = 1 - TILE.GAP;
    const geo = detailed ? new RoundedBoxGeometry(size, TILE.HEIGHT, size, 2, 0.035) : new THREE.BoxGeometry(size, TILE.HEIGHT, size);
    const mat = new THREE.MeshStandardMaterial({
      roughness: 0.9, metalness: 0, envMapIntensity: 0.3,
      map: ptex.paper, bumpMap: detailed ? ptex.paper : null, bumpScale: detailed ? 1.2 : 0,
    });
    const tiles = new THREE.InstancedMesh(geo, mat, n);
    tiles.castShadow = true;
    tiles.receiveShadow = true;
    tiles.layers.set(1);
    tiles.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    g.add(tiles);

    const paper = new THREE.Color(theme.paper);
    const m4 = new THREE.Matrix4();
    for (let i = 0; i < n; i++) {
      const { x, y } = this._cellXY(i, w);
      const layerY = level.targets[i] * TILE.LAYER_STEP;
      m4.makeTranslation(x - (w - 1) / 2, layerY, y - (h - 1) / 2);
      tiles.setMatrixAt(i, m4);
      tiles.setColorAt(i, paper);
    }
    tiles.instanceColor.needsUpdate = true;

    // Number overlay: single transparent plane with canvas texture.
    const canvas = document.createElement('canvas');
    const px = Math.min(2048, Math.max(512, 96 * w));
    canvas.width = canvas.height = px;
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    const overlay = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false })
    );
    overlay.rotation.x = -Math.PI / 2;
    const maxLayer = (palette.length - 1) * TILE.LAYER_STEP;
    overlay.position.y = maxLayer + TILE.HEIGHT / 2 + TILE.FILL_LIFT + 0.02;
    overlay.layers.set(1);
    overlay.renderOrder = 2;
    overlay.userData.noAO = true;
    // The post chain blends in linear light, which thins anti-aliased dark
    // glyphs. Re-weight dark texels' coverage so numbers keep the weight they
    // have when blended on the canvas (a' = 1 − (1 − a)^2.2 for dark ink).
    const linBlend = { value: 0 };
    overlay.material.userData.linBlend = linBlend;
    overlay.material.onBeforeCompile = (shader) => {
      shader.uniforms.uLinBlend = linBlend;
      shader.fragmentShader = 'uniform float uLinBlend;\n' + shader.fragmentShader.replace('#include <map_fragment>',
        '#include <map_fragment>\n  float inkLum = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));\n' +
        '  diffuseColor.a = mix(diffuseColor.a, 1.0 - pow(1.0 - diffuseColor.a, 2.2), uLinBlend * (1.0 - clamp(inkLum * 2.0, 0.0, 1.0)));');
    };
    g.add(overlay);

    // Invisible pick plane (only raycast target — cosmetic layers never pick).
    const pick = new THREE.Mesh(new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({ visible: false }));
    pick.rotation.x = -Math.PI / 2;
    pick.position.y = 0;
    pick.name = 'pick-plane';
    pick.layers.set(1); // explicit interaction layer; cosmetics never intercept
    g.add(pick);

    // Selection ring + hover ghost (selection layer).
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.42, 0.55, 32),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.visible = false;
    ring.layers.set(2);
    ring.renderOrder = 3;
    ring.userData.noAO = true;
    // Thin ink edges keep the ring readable over a tile of its own colour.
    const edgeMat = new THREE.MeshBasicMaterial({ color: 0x3d332a, transparent: true, opacity: 0.6, side: THREE.DoubleSide, depthWrite: false });
    for (const [r0, r1] of [[0.55, 0.59], [0.38, 0.42]]) {
      const edge = new THREE.Mesh(new THREE.RingGeometry(r0, r1, 32), edgeMat);
      edge.layers.set(2);
      edge.renderOrder = 3;
      edge.userData.noAO = true;
      ring.add(edge);
    }
    g.add(ring);
    const ghost = new THREE.Mesh(
      new THREE.PlaneGeometry(size, size),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, depthWrite: false })
    );
    ghost.rotation.x = -Math.PI / 2;
    ghost.visible = false;
    ghost.layers.set(2);
    ghost.renderOrder = 3;
    ghost.userData.noAO = true;
    g.add(ghost);

    // Pooled pigment puffs (effects layer, never raycastable).
    const pCount = PARTICLE_POOL[this.q.particles] || 0;
    let particles = null;
    if (pCount > 0) {
      const pGeo = new THREE.PlaneGeometry(0.12, 0.12);
      const pMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.85, depthWrite: false });
      particles = {
        mesh: new THREE.InstancedMesh(pGeo, pMat, pCount),
        data: Array.from({ length: pCount }, () => ({ life: 0, ttl: 1, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, color: new THREE.Color() })),
        cursor: 0,
      };
      particles.mesh.layers.set(3);
      particles.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      particles.mesh.frustumCulled = false;
      particles.mesh.userData.noAO = true;
      const zero = new THREE.Matrix4().makeScale(0, 0, 0);
      for (let i = 0; i < pCount; i++) particles.mesh.setMatrixAt(i, zero);
      g.add(particles.mesh);
    }

    // Ambient dust motes drifting in the sunlight (effects layer; points skip AO).
    const motes = this._buildMotes(w, h, maxLayer);
    g.add(motes);

    this._board = { group: g, level, palette, theme, tiles, canvas, tex, overlay, pick, ring, ghost, particles, motes, mats: [table.material, frameMat, mat], cellColor: new THREE.Color(), tmpM: new THREE.Matrix4() };
    this._fitShadow();
    this._applyAmbient();
    this._hoverCell = -1;
    this._focusCell = -1;
    this._anims.length = 0;

    this._frameCamera(true);
    this.resize();
    // Prewarm shader variants before play starts.
    this.renderer.compile(this.scene, this.camera);
  }

  /** Shared procedural textures (plain: none). Kept across board rebuilds. */
  _textures(detailed) {
    if (!detailed) return { paper: null, linen: null, wood: null };
    if (!this._tex) {
      const mk = (canvas, repeat) => {
        const t = new THREE.CanvasTexture(canvas);
        t.colorSpace = THREE.SRGBColorSpace;
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        if (repeat) t.repeat.set(repeat[0], repeat[1]);
        t.anisotropy = 4;
        t.userData.shared = true;
        return t;
      };
      this._tex = { paper: mk(paperCanvas()), linen: mk(linenCanvas(), [48, 48]), wood: mk(woodCanvas(), [1, 1]) };
    }
    return this._tex;
  }

  _buildMotes(w, h, top) {
    const count = 36;
    const r = texRng(w * 131 + h);
    const pos = new Float32Array(count * 3);
    const seeds = [];
    for (let i = 0; i < count; i++) {
      const s = { x: (r() - 0.5) * (w + 2), y: top + 0.4 + r() * 3.5, z: (r() - 0.5) * (h + 2), p: r() * Math.PI * 2, v: 0.06 + r() * 0.1 };
      seeds.push(s);
      pos[i * 3] = s.x; pos[i * 3 + 1] = s.y; pos[i * 3 + 2] = s.z;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({ color: 0xfff4dc, size: 2.5, sizeAttenuation: false, transparent: true, opacity: 0.3, depthWrite: false });
    const pts = new THREE.Points(geo, mat);
    pts.layers.set(3);
    pts.frustumCulled = false;
    pts.userData.noAO = true;
    pts.userData.seeds = seeds;
    pts.userData.span = [w + 2, h + 2, top];
    return pts;
  }

  _cellXY(i, w) { return { x: i % w, y: Math.floor(i / w) }; }

  _cellTopY(i) {
    const b = this._board;
    return b.level.targets[i] * TILE.LAYER_STEP + TILE.HEIGHT / 2;
  }

  _cellWorldPos(i) {
    const b = this._board;
    const { x, y } = this._cellXY(i, b.level.w);
    return new THREE.Vector3(x - (b.level.w - 1) / 2, this._cellTopY(i), y - (b.level.h - 1) / 2);
  }

  /* -------------------------------------------------------------- */
  /* Camera                                                          */
  /* -------------------------------------------------------------- */

  _frameCamera(immediate) {
    const b = this._board;
    if (!b) return;
    const w = b.level.w, h = b.level.h;
    const diag = Math.hypot(w, h);
    const dist = diag * CAMERA.DIST_SCALE;
    const tilt = THREE.MathUtils.degToRad(CAMERA.TILT_DEG);
    const target = new THREE.Vector3(0, 0, 0);
    const pos = new THREE.Vector3(0, Math.sin(tilt) * dist, Math.cos(tilt) * dist);
    const apply = () => {
      this.camera.position.copy(pos);
      this.camera.lookAt(target);
    };
    if (immediate || this.reducedMotion) { apply(); return; }
    // Authored, interruptible transition (never cumulative lerp).
    const fromPos = this.camera.position.clone();
    const fromQuat = this.camera.quaternion.clone();
    const toPos = pos.clone();
    const tmpCam = this.camera.clone();
    tmpCam.position.copy(pos); tmpCam.lookAt(target);
    const toQuat = tmpCam.quaternion.clone();
    const start = performance.now();
    this._cameraAnim = {
      step: (now) => {
        const t = Math.min(1, (now - start) / CAMERA.INTRO_MS);
        const e = 1 - Math.pow(1 - t, 3); // ease-out cubic
        this.camera.position.lerpVectors(fromPos, toPos, e);
        this.camera.quaternion.slerpQuaternions(fromQuat, toQuat, e);
        if (t >= 1) this._cameraAnim = null;
      },
    };
  }

  /** Public camera reset (keyboard `C` / HUD button). */
  resetCamera() { this._frameCamera(false); }

  resize() {
    if (this._disposed) return;
    const cw = this.container.clientWidth || 1;
    const ch = this.container.clientHeight || 1;
    this._applySize(cw, ch);
    const b = this._board;
    const span = b ? (Math.max(b.level.w, b.level.h) / 2) * CAMERA.VIEW_MARGIN : 5;
    const aspect = cw / ch;
    let hw, hh;
    if (aspect >= 1) { hh = span; hw = span * aspect; } else { hw = span; hh = span / aspect; }
    this.camera.left = -hw; this.camera.right = hw;
    this.camera.top = hh; this.camera.bottom = -hh;
    this.camera.updateProjectionMatrix();
  }

  /* -------------------------------------------------------------- */
  /* Picking (interaction layer only)                                */
  /* -------------------------------------------------------------- */

  pick(clientX, clientY) {
    const b = this._board;
    if (!b) return -1;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this._pointer.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    );
    this.raycaster.setFromCamera(this._pointer, this.camera);
    this.raycaster.layers.set(1);
    const hits = this.raycaster.intersectObject(b.pick, false);
    if (!hits.length) return -1;
    const p = hits[0].point;
    const cx = Math.round(p.x + (b.level.w - 1) / 2);
    const cy = Math.round(p.z + (b.level.h - 1) / 2);
    if (cx < 0 || cx >= b.level.w || cy < 0 || cy >= b.level.h) return -1;
    return cy * b.level.w + cx;
  }

  /* -------------------------------------------------------------- */
  /* State sync + event animation                                    */
  /* -------------------------------------------------------------- */

  /**
   * Apply an immutable snapshot: set final tile colors and redraw numbers,
   * then queue cosmetic animations for the given events.
   */
  syncState(state, events = []) {
    const b = this._board;
    if (!b) return;
    this._lastState = state;
    const { level, palette, tiles } = b;
    const color = b.cellColor;
    const paper = new THREE.Color(b.theme.paper);
    let colorsDirty = false;
    for (let i = 0; i < level.targets.length; i++) {
      const targetColor = palette[level.targets[i]].hex;
      const want = state.fills[i] ? color.set(targetColor) : color.copy(paper);
      tiles.setColorAt(i, want);
      colorsDirty = true;
      // Settle every tile into its exact deterministic end state first.
      this._setTileFinal(i, state);
    }
    if (colorsDirty) tiles.instanceColor.needsUpdate = true;
    tiles.instanceMatrix.needsUpdate = true;
    this._drawNumbers(state);

    for (const ev of events) {
      if (ev.type === 'fill' || ev.type === 'hint') this._animateFill(ev.cell);
      if (ev.type === 'undo') this._animateUndo(ev.cell);
      if (ev.type === 'invalid') this._animateInvalid(ev.cell);
      if (ev.type === 'complete') this._celebrate();
    }
    this._updateSelectionMarkers(state);
  }

  _setTileFinal(i, state) {
    const b = this._board;
    const { x, y } = this._cellXY(i, b.level.w);
    const base = b.level.targets[i] * TILE.LAYER_STEP;
    const lift = state.fills[i] ? TILE.FILL_LIFT : 0;
    b.tmpM.makeTranslation(x - (b.level.w - 1) / 2, base + lift, y - (b.level.h - 1) / 2);
    b.tiles.setMatrixAt(i, b.tmpM);
    this._anims = this._anims.filter(a => a.cell !== i); // end state wins
  }

  _animateFill(cell) {
    if (this.reducedMotion) return;
    const b = this._board;
    const from = this._cellTopY(cell) - TILE.FILL_LIFT + 0.35;
    const to = this._cellTopY(cell);
    const start = performance.now();
    this._anims.push({
      cell,
      step: (now) => {
        const t = Math.min(1, (now - start) / 260);
        const e = 1 - Math.pow(1 - t, 3);
        const yy = from + (to - from) * e;
        const { x, y } = this._cellXY(cell, b.level.w);
        b.tmpM.makeTranslation(x - (b.level.w - 1) / 2, yy, y - (b.level.h - 1) / 2);
        b.tiles.setMatrixAt(cell, b.tmpM);
        b.tiles.instanceMatrix.needsUpdate = true;
        return t < 1;
      },
    });
    this._spawnPuff(cell, 10);
  }

  _animateUndo(cell) {
    if (this.reducedMotion) return;
    this._spawnPuff(cell, 4);
  }

  _animateInvalid(cell) {
    if (this.reducedMotion) return;
    const b = this._board;
    const start = performance.now();
    const base = this._cellTopY(cell) - TILE.FILL_LIFT;
    const { x, y } = this._cellXY(cell, b.level.w);
    this._anims.push({
      cell,
      step: (now) => {
        const t = Math.min(1, (now - start) / 300);
        const wobble = Math.sin(t * Math.PI * 4) * (1 - t) * 0.05;
        b.tmpM.makeTranslation(x - (b.level.w - 1) / 2 + wobble, base, y - (b.level.h - 1) / 2);
        b.tiles.setMatrixAt(cell, b.tmpM);
        b.tiles.instanceMatrix.needsUpdate = true;
        return t < 1;
      },
    });
  }

  _celebrate() {
    const b = this._board;
    if (!b) return;
    if (!this.reducedMotion) {
      for (let k = 0; k < 6; k++) {
        const cell = Math.floor(Math.random() * b.level.targets.length);
        this._spawnPuff(cell, 24);
      }
    }
  }

  _spawnPuff(cell, count) {
    const b = this._board;
    const p = b && b.particles;
    if (!p) return;
    const origin = this._cellWorldPos(cell);
    const c = b.cellColor.set(b.palette[b.level.targets[cell]].hex);
    for (let k = 0; k < count; k++) {
      const d = p.data[p.cursor];
      d.life = 0; d.ttl = 0.5 + Math.random() * 0.5;
      d.x = origin.x; d.y = origin.y + 0.15; d.z = origin.z;
      const a = Math.random() * Math.PI * 2, sp = 0.6 + Math.random() * 1.4;
      d.vx = Math.cos(a) * sp; d.vz = Math.sin(a) * sp; d.vy = 1.2 + Math.random() * 1.6;
      d.color.copy(c);
      p.mesh.setColorAt(p.cursor, d.color);
      p.cursor = (p.cursor + 1) % p.data.length;
    }
    if (p.mesh.instanceColor) p.mesh.instanceColor.needsUpdate = true;
  }

  /** Hover preview (legal targets preview before commit). */
  setHover(cell, state) {
    const b = this._board;
    if (!b) return;
    this._hoverCell = cell;
    const show = cell >= 0 && state && !state.fills[cell] && state.selected != null &&
      state.status === 'active';
    b.ghost.visible = show;
    if (show) {
      const pos = this._cellWorldPos(cell);
      b.ghost.position.set(pos.x, pos.y + TILE.FILL_LIFT + 0.03, pos.z);
      b.ghost.material.color.set(b.palette[b.level.targets[cell]].hex);
      b.ghost.material.opacity = b.level.targets[cell] === state.selected ? 0.45 : 0.15;
    }
  }

  /** Keyboard/gamepad focus marker. */
  setFocusCell(cell) {
    const b = this._board;
    if (!b) return;
    this._focusCell = cell;
    if (cell >= 0) {
      const pos = this._cellWorldPos(cell);
      b.ring.position.set(pos.x, pos.y + TILE.FILL_LIFT + 0.04, pos.z);
      b.ring.visible = true;
    }
  }

  _updateSelectionMarkers(state) {
    const b = this._board;
    if (!b) return;
    if (this._focusCell >= 0 && state.status === 'active') {
      this.setFocusCell(this._focusCell);
      b.ring.material.color.set(state.selected != null ? b.palette[state.selected].hex : 0xffffff);
    } else if (state.status !== 'active') {
      b.ring.visible = false;
      b.ghost.visible = false;
    }
  }

  clearFocus() {
    const b = this._board;
    if (b) { b.ring.visible = false; this._focusCell = -1; }
  }

  /** Screen-space position of a cell (for DOM label alignment). */
  cellToScreen(cell) {
    const b = this._board;
    if (!b) return null;
    const v = this._cellWorldPos(cell).project(this.camera);
    const rect = this.renderer.domElement.getBoundingClientRect();
    return {
      x: rect.left + (v.x + 1) / 2 * rect.width,
      y: rect.top + (-v.y + 1) / 2 * rect.height,
    };
  }

  /* -------------------------------------------------------------- */
  /* Number overlay                                                  */
  /* -------------------------------------------------------------- */

  _drawNumbers(state) {
    const b = this._board;
    const { canvas, level, palette } = b;
    const ctx = canvas.getContext('2d');
    const w = level.w, h = level.h;
    const cellPx = canvas.width / w;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < level.targets.length; i++) {
      const { x, y } = this._cellXY(i, w);
      const cx = (x + 0.5) * cellPx, cy = (y + 0.5) * cellPx;
      const t = level.targets[i];
      if (!state.fills[i]) {
        // Number + symbol on bare paper.
        ctx.fillStyle = 'rgba(70,58,48,0.85)';
        ctx.font = `600 ${cellPx * 0.42}px system-ui, sans-serif`;
        ctx.fillText(String(t + 1), cx, cy - cellPx * 0.10);
        ctx.font = `${cellPx * 0.22}px system-ui, sans-serif`;
        ctx.fillStyle = 'rgba(70,58,48,0.55)';
        ctx.fillText(palette[t].symbol, cx, cy + cellPx * 0.26);
      } else {
        // Filled: small symbol watermark keeps color non-color-coded.
        ctx.fillStyle = 'rgba(255,255,255,0.35)';
        ctx.font = `${cellPx * 0.34}px system-ui, sans-serif`;
        ctx.fillText(palette[t].symbol, cx, cy);
      }
    }
    b.tex.needsUpdate = true;
  }

  /* -------------------------------------------------------------- */
  /* Frame loop                                                      */
  /* -------------------------------------------------------------- */

  start() {
    if (this._running) return;
    this._running = true;
    this._clockLast = performance.now();
    const loop = (now) => {
      if (!this._running) return;
      this._frame(now);
      this._raf = requestAnimationFrame(loop);
    };
    this._raf = requestAnimationFrame(loop);
  }

  stop() {
    this._running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
  }

  _frame(now) {
    const dt = Math.min(0.1, (now - this._clockLast) / 1000);
    this._clockLast = now;
    if (this._cameraAnim) this._cameraAnim.step(now);
    if (this._anims.length) {
      this._anims = this._anims.filter(a => {
        try { return a.step(now); } catch { return false; }
      });
    }
    this._stepParticles(dt);
    this._stepAmbient(dt);
    const rescale = this._adapt(dt * 1000);
    if (rescale) this.resize();
    const key = this._postKey();
    if (key !== this.postKey) {
      this.postKey = key;
      this._buildPost();
    }
    if (this._board) this._board.overlay.material.userData.linBlend.value = this.composer ? 1 : 0;
    if (this.composer) this.composer.render(dt);
    else this.renderer.render(this.scene, this.camera);
  }

  /** Canvas size × (dpr cap · preset scale · render scale · adaptive scale). */
  _applySize(cw, ch) {
    // × UIScale: the board host sits inside the zoomed #app, so its CSS size is zoomed on large screens.
    const ratio = pixelRatio(this.q, window.devicePixelRatio || 1, this.adaptiveScale) * ((window.UIScale && window.UIScale.value) || 1);
    if (cw === this._size[0] && ch === this._size[1] && ratio === this.pixelRatio) return;
    this._size = [cw, ch];
    this.pixelRatio = ratio;
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(cw, ch, false);
    if (this.composer) {
      this.composer.setPixelRatio(ratio);
      this.composer.setSize(cw, ch);
      if (this._fxaa) this._fxaa.material.uniforms.resolution.value.set(1 / (cw * ratio), 1 / (ch * ratio));
    }
  }

  /** Ambient motion: drifting dust motes + a slow sunlight drift (off with reduced motion). */
  _applyAmbient() {
    const osReduce = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
    const on = this.q.ambient === 'on' && !this.reducedMotion && !osReduce;
    this._ambientOn = on;
    if (this._board && this._board.motes) this._board.motes.visible = on;
    if (!on) { this.key.position.copy(this._keyBase); this.key.intensity = 1.6; }
  }

  _stepAmbient(dt) {
    if (!this._ambientOn) return;
    this._time += dt;
    const t = this._time;
    // Sunlight through a window: the key drifts a little and breathes in strength.
    this.key.position.set(
      this._keyBase.x + Math.sin(t * 0.07) * 1.2,
      this._keyBase.y,
      this._keyBase.z + Math.cos(t * 0.05) * 0.9);
    this.key.intensity = 1.6 + Math.sin(t * 0.31) * 0.04 + Math.sin(t * 0.83) * 0.02;
    const m = this._board && this._board.motes;
    if (!m) return;
    const pos = m.geometry.attributes.position;
    const [sw, sh, top] = m.userData.span;
    m.userData.seeds.forEach((s, i) => {
      s.y += s.v * dt * 0.35;
      s.x += Math.sin(t * 0.4 + s.p) * 0.12 * dt;
      s.z += Math.cos(t * 0.3 + s.p) * 0.1 * dt;
      if (s.y > top + 4) s.y = top + 0.3;
      if (s.x > sw / 2) s.x -= sw; else if (s.x < -sw / 2) s.x += sw;
      if (s.z > sh / 2) s.z -= sh; else if (s.z < -sh / 2) s.z += sh;
      pos.setXYZ(i, s.x, s.y, s.z);
    });
    pos.needsUpdate = true;
    m.material.opacity = 0.26 + Math.sin(t * 0.5) * 0.06;
  }

  /* -------------------------------------------------------------- */
  /* Graphics settings                                               */
  /* -------------------------------------------------------------- */

  /** Apply saved graphics settings live (settings.gfx; `{}` = Auto). */
  setGraphics(saved) {
    this.saved = saved || {};
    const prev = this.q;
    const g = resolve(this.saved, this.detected);
    this.q = g;
    const wantMsaa = g.antialias === 'msaa' && !g.post;
    if (wantMsaa !== this._msaa) this._createRenderer(wantMsaa);

    const size = SHADOW_MAP[g.shadows];
    this.renderer.shadowMap.enabled = size > 0;
    this.key.castShadow = size > 0;
    if (size > 0 && this.key.shadow.mapSize.x !== size) {
      this.key.shadow.mapSize.set(size, size);
      if (this.key.shadow.map) { this.key.shadow.map.dispose(); this.key.shadow.map = null; }
    }
    this.key.shadow.radius = g.shadows === 'high' ? 4 : 3;

    // Studio lighting: image-based room light from RoomEnvironment (PMREM).
    if (g.lighting === 'studio') {
      if (!this._envRT) {
        const pmrem = new THREE.PMREMGenerator(this.renderer);
        const room = new RoomEnvironment(this.renderer);
        this._envRT = pmrem.fromScene(room, 0.04);
        room.dispose();
        pmrem.dispose();
      }
      this.scene.environment = this._envRT.texture;
      this.hemi.intensity = 0.3;
      this.renderer.toneMappingExposure = 0.92;
    } else {
      this.scene.environment = null;
      this.hemi.intensity = 0.75;
      this.renderer.toneMappingExposure = 1.05;
    }

    this.adaptiveScale = 1;
    this._frames = [];
    this.postKey = null; // rebuild the post chain on the next frame
    this._fpsVisible(g.showFps);
    this._applyAmbient();
    const rebuild = this._board && prev && (prev.detail !== g.detail || prev.particles !== g.particles);
    if (rebuild) {
      const b = this._board;
      const focus = this._focusCell;
      this.buildBoard(b.level, b.palette, b.theme);
      if (focus >= 0) this.setFocusCell(focus);
      if (this._lastState) this.syncState(this._lastState, []);
    } else if (this._board) {
      // Materials pick up shadow-map changes on recompile.
      for (const m of this._board.mats) m.needsUpdate = true;
    }
    this.pixelRatio = 0;
    this.resize();
    const el = this.renderer.domElement;
    el.dataset.gfxPreset = g.preset;
    document.body.dataset.gfxPreset = g.preset;
    for (const fn of this._gfxListeners) fn();
  }

  /** Called whenever graphics info changes (summary line in the panel). */
  onGraphicsChange(fn) { this._gfxListeners.push(fn); }

  /** What the Graphics panel shows: GPU, auto choice, resolved tiers, cost, frame rate. */
  graphicsInfo(phrases) {
    const px = [Math.round(this._size[0] * this.pixelRatio), Math.round(this._size[1] * this.pixelRatio)];
    return {
      gpu: this.gpu || '',
      detected: this.detected,
      resolved: this.q,
      summary: describe(this.q, px, phrases),
      pixels: px,
      fps: Math.round(this.fps || 0),
      adaptiveScale: Math.round(this.adaptiveScale * 100) / 100,
      postFailed: !!this.postFailed,
    };
  }

  _fpsVisible(on) {
    let el = document.getElementById('fps-meter');
    if (on && !el) {
      el = document.createElement('div');
      el.id = 'fps-meter';
      el.className = 'fps-meter';
      el.setAttribute('aria-hidden', 'true');
      el.textContent = '… fps';
      document.body.append(el);
    }
    if (el) el.hidden = !on;
  }

  _postKey() {
    const g = this.q;
    return g.post && !this.postFailed ? [g.ao, g.grade, g.antialias].join('|') : 'none';
  }

  _buildPost() {
    const g = this.q;
    if (this.composer) { this.composer.dispose(); this.composer = null; }
    this._fxaa = null;
    if (!g.post || this.postFailed) return;
    const [w, h] = this._size;
    const pr = this.pixelRatio || 1;
    try {
      const target = new THREE.WebGLRenderTarget(Math.max(1, w * pr), Math.max(1, h * pr), {
        type: THREE.HalfFloatType, samples: g.antialias === 'msaa' ? 4 : 0,
      });
      const composer = new EffectComposer(this.renderer, target);
      composer.setPixelRatio(pr);
      composer.setSize(w, h);
      composer.addPass(new RenderPass(this.scene, this.camera));
      if (g.ao !== 'off') {
        const ao = new PaperGTAOPass(this.scene, this.camera, w * pr, h * pr);
        ao.output = GTAOPass.OUTPUT.Default;
        ao.blendIntensity = g.ao === 'high' ? 0.85 : 0.7;
        ao.updateGtaoMaterial({ radius: 0.45, distanceExponent: 1.4, thickness: 0.6, scale: 1.0, samples: g.ao === 'high' ? 16 : 8 });
        ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: g.ao === 'high' ? 6 : 4, rings: 2, samples: g.ao === 'high' ? 16 : 8 });
        composer.addPass(ao);
      }
      composer.addPass(new OutputPass());
      if (g.grade === 'on') composer.addPass(new ShaderPass(GradeShader));
      if (g.antialias === 'smaa') composer.addPass(new SMAAPass(w * pr, h * pr));
      if (g.antialias === 'fxaa') {
        const fxaa = new ShaderPass(FXAAShader);
        fxaa.material.uniforms.resolution.value.set(1 / (w * pr), 1 / (h * pr));
        composer.addPass(fxaa);
        this._fxaa = fxaa;
      }
      this.composer = composer;
    } catch {
      // Post-processing is an enhancement: render directly and say so in the panel.
      this.postFailed = true;
      this.composer = null;
      for (const fn of this._gfxListeners) fn();
    }
  }

  /** Adaptive resolution: ~90-frame average; >26 ms steps down 0.1 (min 0.6), <14 ms back up 0.05. */
  _adapt(ms) {
    const f = this._frames;
    f.push(ms);
    if (f.length < 90) return false;
    const avg = f.reduce((a, b) => a + b, 0) / f.length;
    f.length = 0;
    this.fps = 1000 / avg;
    const el = document.getElementById('fps-meter');
    if (el && !el.hidden) el.textContent = `${Math.round(this.fps)} fps · ${Math.round(this.pixelRatio * 100) / 100}×`;
    if (!this.q.adaptive) return false;
    const before = this.adaptiveScale;
    if (avg > 26) this.adaptiveScale = Math.max(0.6, Math.round((this.adaptiveScale - 0.1) * 100) / 100);
    else if (avg < 14 && this.adaptiveScale < 1) this.adaptiveScale = Math.min(1, Math.round((this.adaptiveScale + 0.05) * 100) / 100);
    return before !== this.adaptiveScale;
  }

  _stepParticles(dt) {
    const b = this._board;
    const p = b && b.particles;
    if (!p) return;
    let any = false;
    const m = b.tmpM;
    for (let i = 0; i < p.data.length; i++) {
      const d = p.data[i];
      if (d.ttl <= 0) continue;
      d.life += dt;
      if (d.life >= d.ttl) { d.ttl = 0; m.makeScale(0, 0, 0); p.mesh.setMatrixAt(i, m); any = true; continue; }
      d.x += d.vx * dt; d.y += d.vy * dt; d.z += d.vz * dt;
      d.vy -= 3.2 * dt;
      const s = 1 - d.life / d.ttl;
      m.makeScale(s, s, s).setPosition(d.x, d.y, d.z);
      p.mesh.setMatrixAt(i, m);
      any = true;
    }
    if (any) p.mesh.instanceMatrix.needsUpdate = true;
  }

  /* -------------------------------------------------------------- */
  /* Quality / motion / disposal                                     */
  /* -------------------------------------------------------------- */

  setReducedMotion(on) {
    this.reducedMotion = !!on;
    if (on) { this._anims.length = 0; this._cameraAnim = null; }
    this._applyAmbient();
  }

  _disposeBoard() {
    if (!this._board) return;
    const g = this._board.group;
    g.traverse(obj => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const m of mats) { if (m.map && !m.map.userData.shared) m.map.dispose(); m.dispose(); }
      }
    });
    this.scene.remove(g);
    this._board = null;
  }

  dispose() {
    this._disposed = true;
    this.stop();
    window.removeEventListener('resize', this._onResize);
    this._disposeBoard();
    if (this.composer) this.composer.dispose();
    if (this._envRT) this._envRT.dispose();
    if (this._tex) for (const t of Object.values(this._tex)) t.dispose();
    this.renderer.dispose();
    if (this.renderer.domElement.parentNode) {
      this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
    }
  }
}

export function isWebGLAvailable() {
  try {
    const c = document.createElement('canvas');
    return !!(window.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl')));
  } catch {
    return false;
  }
}
