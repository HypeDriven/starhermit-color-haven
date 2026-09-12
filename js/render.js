/**
 * Color Haven — render module (Three.js).
 * Layered paper-art board: instanced paper tiles, a canvas-drawn number
 * overlay, selection ring + hover ghost, pooled pigment-puff particles,
 * tiered quality, deterministic visual seed. No post-processing: hierarchy
 * comes from depth, rim light, and grounded markers.
 */

import * as THREE from 'three';

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

const QUALITY_TIERS = {
  low:    { dpr: 1,   shadows: false, particles: 0,   envDetail: 0 },
  medium: { dpr: 1.5, shadows: false, particles: 400, envDetail: 1 },
  high:   { dpr: 2,   shadows: true,  particles: 1200, envDetail: 2 },
};

function hexCss(hex) { return '#' + hex.toString(16).padStart(6, '0'); }

export class PaperRenderer {
  constructor(container, opts = {}) {
    this.container = container;
    this.reducedMotion = !!opts.reducedMotion;
    this.quality = QUALITY_TIERS[opts.quality] || QUALITY_TIERS.medium;
    this.qualityName = QUALITY_TIERS[opts.quality] ? opts.quality : 'medium';

    this.renderer = new THREE.WebGLRenderer({ antialias: this.qualityName !== 'low', alpha: false });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.quality.dpr));
    if (this.quality.shadows) {
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    }
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.display = 'block';

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
    this._hoverCell = -1;
    this._focusCell = -1;    // keyboard focus marker
    this._clockLast = performance.now();
    this._running = false;
    this._disposed = false;

    this._buildLights();
    this._onResize = this.resize.bind(this);
    window.addEventListener('resize', this._onResize);
    // The host box also changes without a window resize (coach banner space,
    // chat sidebar, drawers): follow it directly.
    if (typeof ResizeObserver === 'function') {
      this._ro = new ResizeObserver(() => this.resize());
      this._ro.observe(this.container);
    }
  }

  /* -------------------------------------------------------------- */
  /* Lighting: one dominant key, soft environment fill, grounding.   */
  /* -------------------------------------------------------------- */
  _buildLights() {
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x8a7a66, 0.75);
    this.scene.add(this.hemi);
    this.key = new THREE.DirectionalLight(0xfff1d6, 1.6);
    this.key.position.set(6, 12, 4);
    this.key.castShadow = this.quality.shadows;
    if (this.quality.shadows) {
      this.key.shadow.mapSize.set(1024, 1024);
      this.key.shadow.radius = 4;
      this.key.shadow.bias = -0.0005;
    }
    this.scene.add(this.key);
    this.rim = new THREE.DirectionalLight(0xdde8ff, 0.35);
    this.rim.position.set(-5, 6, -6);
    this.scene.add(this.rim);
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
    const table = new THREE.Mesh(
      new THREE.PlaneGeometry(120, 120),
      new THREE.MeshStandardMaterial({ color: theme.table, roughness: 0.95, metalness: 0 })
    );
    table.rotation.x = -Math.PI / 2;
    table.position.y = -0.28;
    table.receiveShadow = this.quality.shadows;
    table.layers.set(0);
    g.add(table);

    // Frame: four paper slats around the board.
    const frameMat = new THREE.MeshStandardMaterial({ color: theme.frame, roughness: 0.8 });
    const fw = w + 0.6, fh = h + 0.6, ft = 0.34;
    const mkSlat = (sw, sh, x, z) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(sw, ft, sh), frameMat);
      m.position.set(x, -ft / 2 + 0.02, z);
      m.receiveShadow = this.quality.shadows;
      m.layers.set(0);
      g.add(m);
    };
    mkSlat(fw, 0.3, 0, -fh / 2 + 0.15); mkSlat(fw, 0.3, 0, fh / 2 - 0.15);
    mkSlat(0.3, fh, -fw / 2 + 0.15, 0); mkSlat(0.3, fh, fw / 2 - 0.15, 0);

    // Paper tiles: one InstancedMesh; per-instance color + matrix.
    const size = 1 - TILE.GAP;
    const geo = new THREE.BoxGeometry(size, TILE.HEIGHT, size);
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0 });
    const tiles = new THREE.InstancedMesh(geo, mat, n);
    tiles.castShadow = this.quality.shadows;
    tiles.receiveShadow = this.quality.shadows;
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
    g.add(ring);
    const ghost = new THREE.Mesh(
      new THREE.PlaneGeometry(size, size),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, depthWrite: false })
    );
    ghost.rotation.x = -Math.PI / 2;
    ghost.visible = false;
    ghost.layers.set(2);
    ghost.renderOrder = 3;
    g.add(ghost);

    // Pooled pigment puffs (effects layer, never raycastable).
    const pCount = this.quality.particles;
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
      const zero = new THREE.Matrix4().makeScale(0, 0, 0);
      for (let i = 0; i < pCount; i++) particles.mesh.setMatrixAt(i, zero);
      g.add(particles.mesh);
    }

    this._board = { group: g, level, palette, theme, tiles, canvas, tex, overlay, pick, ring, ghost, particles, cellColor: new THREE.Color(), tmpM: new THREE.Matrix4() };
    this._hoverCell = -1;
    this._focusCell = -1;
    this._anims.length = 0;

    this._frameCamera(true);
    this.resize();
    // Prewarm shader variants before play starts.
    this.renderer.compile(this.scene, this.camera);
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
    this.renderer.setSize(cw, ch, false);
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
    this.renderer.render(this.scene, this.camera);
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

  setQuality(name) {
    if (!QUALITY_TIERS[name] || name === this.qualityName) return;
    this.qualityName = name;
    this.quality = QUALITY_TIERS[name];
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.quality.dpr));
    this.renderer.shadowMap.enabled = this.quality.shadows;
    this.key.castShadow = this.quality.shadows;
    if (this._board) this.buildBoard(this._board.level, this._board.palette, this._board.theme);
  }

  setReducedMotion(on) {
    this.reducedMotion = !!on;
    if (on) { this._anims.length = 0; this._cameraAnim = null; }
  }

  _disposeBoard() {
    if (!this._board) return;
    const g = this._board.group;
    g.traverse(obj => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const m of mats) { if (m.map) m.map.dispose(); m.dispose(); }
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
