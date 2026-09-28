/**
 * Color Haven — title-screen ambience: a few cut-paper petals drifting down
 * behind the title card (2D canvas). Runs only while the title is visible,
 * Graphics → Ambient motion is on and reduced motion is off.
 */

const COLORS = ['#e0604e', '#e8a33d', '#5f9e52', '#5d9fd6', '#8e6cc9', '#d96f9e', '#3fa39a'];

export class TitlePetals {
  constructor(screen) {
    this.screen = screen;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'title-petals';
    this.canvas.setAttribute('aria-hidden', 'true');
    screen.prepend(this.canvas);
    this.enabled = false;
    this.petals = [];
    this._raf = 0;
    this._last = 0;
    this._obs = new MutationObserver(() => this._update());
    this._obs.observe(screen, { attributes: true, attributeFilter: ['hidden'] });
    document.addEventListener('visibilitychange', () => this._update());
  }

  setEnabled(on) {
    this.enabled = !!on;
    this._update();
  }

  _update() {
    const run = this.enabled && !this.screen.hidden && !document.hidden;
    this.canvas.hidden = !this.enabled;
    if (run && !this._raf) {
      this._last = performance.now();
      this._raf = requestAnimationFrame((t) => this._tick(t));
    } else if (!run && this._raf) {
      cancelAnimationFrame(this._raf);
      this._raf = 0;
    }
  }

  _seed(w, h) {
    const n = Math.round(Math.min(26, Math.max(10, (w * h) / 60000)));
    this.petals = Array.from({ length: n }, () => this._petal(w, h, Math.random() * h));
  }

  _petal(w, h, y) {
    return {
      x: Math.random() * w, y, s: 7 + Math.random() * 9,
      vy: 12 + Math.random() * 18, sway: 10 + Math.random() * 18, ph: Math.random() * 6.28,
      rot: Math.random() * 6.28, vr: (Math.random() - 0.5) * 1.2,
      c: COLORS[(Math.random() * COLORS.length) | 0], a: 0.45 + Math.random() * 0.3,
    };
  }

  _tick(now) {
    this._raf = 0;
    const dt = Math.min(0.05, (now - this._last) / 1000);
    this._last = now;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.screen.clientWidth, h = this.screen.clientHeight;
    const c = this.canvas;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
      this._seed(w, h);
    }
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const t = now / 1000;
    for (const p of this.petals) {
      p.y += p.vy * dt;
      p.rot += p.vr * dt;
      if (p.y > h + 20) Object.assign(p, this._petal(w, h, -20));
      const x = p.x + Math.sin(t * 0.6 + p.ph) * p.sway;
      ctx.save();
      ctx.translate(x, p.y);
      ctx.rotate(p.rot);
      ctx.globalAlpha = p.a;
      // Paper petal: two arcs, a soft drop shadow, a light crease.
      ctx.shadowColor = 'rgba(80,60,30,0.18)';
      ctx.shadowBlur = 3; ctx.shadowOffsetY = 2;
      ctx.fillStyle = p.c;
      ctx.beginPath();
      ctx.moveTo(0, -p.s);
      ctx.quadraticCurveTo(p.s * 0.8, 0, 0, p.s);
      ctx.quadraticCurveTo(-p.s * 0.8, 0, 0, -p.s);
      ctx.fill();
      ctx.shadowColor = 'transparent';
      ctx.strokeStyle = 'rgba(255,255,255,0.45)';
      ctx.lineWidth = 0.8;
      ctx.beginPath(); ctx.moveTo(0, -p.s * 0.7); ctx.lineTo(0, p.s * 0.7); ctx.stroke();
      ctx.restore();
    }
    this._update();
    if (!this._raf && this.enabled && !this.screen.hidden && !document.hidden) {
      this._raf = requestAnimationFrame((tt) => this._tick(tt));
    }
  }
}
