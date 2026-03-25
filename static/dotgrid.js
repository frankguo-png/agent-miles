/**
 * Ampliwork-style dot grid.
 * Uniform grid of round dots, all same size.
 * Radial gradient brightness from a focal center.
 * Cursor proximity lights up nearby dots interactively.
 * Phantom cursor drifts when real cursor is absent.
 */
class DotGrid {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');

    // Grid
    this.spacing = 20;
    this.dotSize = 2.0;

    // Cursor glow
    this.cursorRadius = 180;

    // Colors
    this.bg = '#0a0f1a';
    this.dotDim  = { r: 30, g: 65, b: 130 };
    this.dotLit  = { r: 80, g: 175, b: 255 };

    // State
    this.dots = [];
    this.mouse = { x: -9999, y: -9999, on: false };
    this.phantom = { x: 0, y: 0, tx: 0, ty: 0, timer: 0 };
    this.active = { x: 0, y: 0 };
    this.w = 0; this.h = 0;
    this.animId = null;

    this._init();
  }

  _init() {
    this._resize();
    this._makeDots();
    this.phantom.x = this.w * 0.6;
    this.phantom.y = this.h * 0.4;
    this._phantomPick();
    this.active.x = this.phantom.x;
    this.active.y = this.phantom.y;
    this._bind();
    this._loop();
  }

  _resize() {
    const dpr = window.devicePixelRatio || 1;
    const r = this.canvas.parentElement.getBoundingClientRect();
    this.w = r.width; this.h = r.height;
    this.canvas.width = this.w * dpr;
    this.canvas.height = this.h * dpr;
    this.canvas.style.width = this.w + 'px';
    this.canvas.style.height = this.h + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  _makeDots() {
    this.dots = [];
    const sp = this.spacing;
    const cols = Math.ceil(this.w / sp) + 1;
    const rows = Math.ceil(this.h / sp) + 1;
    // Center the grid
    const ox = (this.w - (cols - 1) * sp) / 2;
    const oy = (this.h - (rows - 1) * sp) / 2;

    // Focal center — slightly right of center, upper third
    const focalX = this.w * 0.62;
    const focalY = this.h * 0.35;
    const maxDist = Math.max(this.w, this.h) * 0.6;

    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const x = ox + col * sp;
        const y = oy + row * sp;

        // Radial gradient: brighter near focal, fading outward
        const dx = x - focalX;
        const dy = y - focalY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const t = Math.max(0, 1 - dist / maxDist);

        this.dots.push({
          x, y,
          // Static base alpha from radial gradient
          baseAlpha: 0.1 + t * t * 0.6,
          // Dynamic cursor brightness
          cb: 0,
        });
      }
    }
  }

  _phantomPick() {
    this.phantom.tx = this.w * 0.3 + Math.random() * this.w * 0.5;
    this.phantom.ty = this.h * 0.15 + Math.random() * this.h * 0.55;
    this.phantom.timer = 90 + Math.random() * 120;
  }

  _bind() {
    this.canvas.addEventListener('mousemove', (e) => {
      const r = this.canvas.getBoundingClientRect();
      this.mouse.x = e.clientX - r.left;
      this.mouse.y = e.clientY - r.top;
      this.mouse.on = true;
    });
    this.canvas.addEventListener('mouseleave', () => {
      this.mouse.on = false;
      this.phantom.x = this.active.x;
      this.phantom.y = this.active.y;
      this._phantomPick();
    });
    this._ro = new ResizeObserver(() => {
      this.ctx.setTransform(1, 0, 0, 1, 0, 0);
      this._resize();
      this._makeDots();
    });
    this._ro.observe(this.canvas.parentElement);

    // Continuously resize during sidebar transition for smooth expansion
    const sidebar = document.getElementById('sidebar');
    if (sidebar) {
      sidebar.addEventListener('transitionstart', () => {
        this._transitionResizing = true;
      });
      sidebar.addEventListener('transitionend', () => {
        this._transitionResizing = false;
        this.ctx.setTransform(1, 0, 0, 1, 0, 0);
        this._resize();
        this._makeDots();
      });
    }
  }

  _update() {
    if (this.mouse.on) {
      this.active.x += (this.mouse.x - this.active.x) * 0.15;
      this.active.y += (this.mouse.y - this.active.y) * 0.15;
    } else {
      this.phantom.x += (this.phantom.tx - this.phantom.x) * 0.025;
      this.phantom.y += (this.phantom.ty - this.phantom.y) * 0.025;
      if (--this.phantom.timer <= 0) this._phantomPick();
      this.active.x += (this.phantom.x - this.active.x) * 0.1;
      this.active.y += (this.phantom.y - this.active.y) * 0.1;
    }

    const cr = this.cursorRadius;
    const cr2 = cr * cr;
    const ax = this.active.x, ay = this.active.y;

    for (let i = 0, n = this.dots.length; i < n; i++) {
      const d = this.dots[i];
      const dx = d.x - ax, dy = d.y - ay;
      const dist2 = dx * dx + dy * dy;
      let t = 0;
      if (dist2 < cr2) {
        const ratio = 1 - Math.sqrt(dist2) / cr;
        t = ratio * ratio;
      }
      d.cb += (t - d.cb) * 0.1;
    }
  }

  _draw() {
    const ctx = this.ctx;
    ctx.fillStyle = this.bg;
    ctx.fillRect(0, 0, this.w, this.h);

    const dd = this.dotDim, dl = this.dotLit;
    const sz = this.dotSize;

    for (let i = 0, n = this.dots.length; i < n; i++) {
      const d = this.dots[i];
      const cb = d.cb;
      const alpha = Math.min(1, d.baseAlpha + cb * 0.7);

      if (alpha < 0.04) continue;

      // Color interpolation based on cursor brightness only
      const r  = dd.r + (dl.r - dd.r) * cb | 0;
      const g  = dd.g + (dl.g - dd.g) * cb | 0;
      const bl = dd.b + (dl.b - dd.b) * cb | 0;

      ctx.globalAlpha = alpha;
      ctx.fillStyle = `rgb(${r},${g},${bl})`;
      ctx.beginPath();
      ctx.arc(d.x, d.y, sz, 0, 6.2832);
      ctx.fill();

      // Soft glow halo for cursor-lit dots
      if (cb > 0.2) {
        ctx.globalAlpha = cb * 0.12;
        ctx.beginPath();
        ctx.arc(d.x, d.y, sz + 4 + cb * 3, 0, 6.2832);
        ctx.fill();
      }
    }

    // Subtle ambient light around cursor position
    const grd = ctx.createRadialGradient(
      this.active.x, this.active.y, 0,
      this.active.x, this.active.y, this.cursorRadius * 0.6
    );
    grd.addColorStop(0, 'rgba(43, 127, 255, 0.06)');
    grd.addColorStop(1, 'rgba(43, 127, 255, 0)');
    ctx.globalAlpha = 1;
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, this.w, this.h);

    ctx.globalAlpha = 1;
  }

  _loop() {
    // During sidebar transition, continuously resize to fill available space
    if (this._transitionResizing) {
      const r = this.canvas.parentElement.getBoundingClientRect();
      if (Math.abs(r.width - this.w) > 2 || Math.abs(r.height - this.h) > 2) {
        this.ctx.setTransform(1, 0, 0, 1, 0, 0);
        this._resize();
        this._makeDots();
      }
    }
    this._update();
    this._draw();
    this.animId = requestAnimationFrame(() => this._loop());
  }

  destroy() {
    if (this.animId) cancelAnimationFrame(this.animId);
    if (this._ro) this._ro.disconnect();
    this.animId = null;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const el = document.getElementById('dot-grid');
  if (el) window._dotGrid = new DotGrid(el);
});
