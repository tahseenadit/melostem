/**
 * The stage: a line of glowing dots. Kicks launch waves from both ends; when the first pair
 * collides the dots start dancing. Each dot also follows its own slice of the spectrum (bass in
 * the middle, treble at the ends), so the line moves with every note. The middle dots are the
 * lips of a face.
 */
interface Dot { y: number; v: number; lev: number }
interface Pair { t0: number; dur: number; amp: number; first: boolean }
interface Burst { t0: number; amp: number }
interface Pt { x: number; y: number; b: number; h: number; nr?: boolean }

export interface StageInput { bins: Uint8Array; hz: number; active: boolean }

const RM = matchMedia('(prefers-reduced-motion: reduce)').matches, AMP = RM ? 0.4 : 1;

function sprite(c: string) {
  const s = document.createElement('canvas'); s.width = s.height = 64;
  const x = s.getContext('2d')!, g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, c); g.addColorStop(1, 'rgba(0,0,0,0)'); x.fillStyle = g; x.fillRect(0, 0, 64, 64);
  return s;
}

export class Stage {
  private g: CanvasRenderingContext2D;
  private W = 0; private H = 0; private N = 0; private dots: Dot[] = [];
  private glowW = sprite('rgba(255,236,220,.9)'); private glowR = sprite('rgba(255,40,40,1)');
  private pairs: Pair[] = []; private bursts: Burst[] = [];
  private dancing = false; private parity = 0; private flash = 0; private beat = 0; private brow = 0; private blinkAt = 3;
  private hist: number[] = []; private prevLo = 0; private lastK = 0;
  private prevT = performance.now();
  kicks = 0;

  constructor(private cv: HTMLCanvasElement) {
    this.g = cv.getContext('2d')!;
    new ResizeObserver(() => this.resize()).observe(cv);
    this.resize();
  }

  reset() { this.dancing = false; this.pairs = []; this.bursts = []; this.kicks = 0; this.hist = []; }

  private resize() {
    const r = this.cv.getBoundingClientRect(), d = Math.min(devicePixelRatio || 1, 2);
    this.W = r.width; this.H = r.height; this.cv.width = (this.W * d) | 0; this.cv.height = (this.H * d) | 0;
    this.g.setTransform(d, 0, 0, d, 0, 0);
    const n = Math.max(24, Math.min(96, Math.round(this.W / 17)));
    if (n !== this.N) { this.N = n; this.dots = Array.from({ length: n }, () => ({ y: 0, v: 0, lev: 0 })); }
  }

  /** Kick = sudden rise of 40–100 Hz energy above its recent statistics (tuned to be very sensitive). */
  private detectKick(now: number, bins: Uint8Array, hz: number) {
    const a = Math.max(1, Math.round(40 / hz)), b = Math.round(100 / hz);
    let lo = 0; for (let i = a; i <= b; i++) lo += bins[i]; lo /= b - a + 1;
    const rise = Math.max(0, lo - this.prevLo); this.prevLo = lo;
    this.hist.push(rise); if (this.hist.length > 60) this.hist.shift();
    const avg = this.hist.reduce((x, y) => x + y, 0) / this.hist.length;
    const sd = Math.sqrt(this.hist.reduce((x, y) => x + (y - avg) ** 2, 0) / this.hist.length);
    if (rise > avg + sd * 1.2 + 4 && lo > 90 && now - this.lastK > 0.27) { this.lastK = now; return true; }
    return false;
  }

  frame(inp: StageInput) {
    const ms = performance.now(), dt = Math.min(0.05, (ms - this.prevT) / 1000); this.prevT = ms;
    const now = ms / 1000, { W, H, N, g } = this;
    const k = inp.active && this.detectKick(now, inp.bins, inp.hz);
    if (k) {
      this.kicks++;
      if (this.dancing) { this.parity ^= 1; this.pairs.push({ t0: now, dur: 0.5, amp: 0.85, first: false }); this.beat = 1; }
      else this.pairs.push({ t0: now, dur: 1.1, amp: 1, first: this.pairs.length === 0 && this.bursts.length === 0 });
    }
    this.beat *= Math.pow(0.03, dt);
    if (!inp.active && this.dancing) this.reset();
    const cx = W / 2, sx = W / (N + 1), y0 = H * 0.55, sig = sx * 2.4;
    for (let i = this.pairs.length - 1; i >= 0; i--) {
      const p = this.pairs[i];
      if (now - p.t0 >= p.dur) {
        this.bursts.push({ t0: now, amp: p.amp * (this.dancing ? 1 : 1.6) });
        this.flash = Math.max(this.flash, this.dancing ? 0.55 : 1);
        this.pairs.splice(i, 1); this.dancing = true;
      }
    }
    this.bursts = this.bursts.filter((b) => now - b.t0 < 1.6);
    this.flash *= Math.pow(0.02, dt);
    g.clearRect(0, 0, W, H);
    if (this.flash > 0.01) {
      const gr = g.createRadialGradient(cx, y0, 0, cx, y0, W * 0.6);
      gr.addColorStop(0, `rgba(227,38,47,${0.35 * this.flash})`); gr.addColorStop(1, 'rgba(227,38,47,0)');
      g.fillStyle = gr; g.fillRect(0, 0, W, H);
    }
    g.strokeStyle = 'rgba(241,236,230,.07)'; g.lineWidth = 1; g.beginPath(); g.moveTo(0, y0 + 0.5); g.lineTo(W, y0 + 0.5); g.stroke();
    const pts: Pt[] = [];
    for (let i = 0; i < N; i++) {
      const d = this.dots[i], x = sx * (i + 1), kk = Math.abs(i - (N - 1) / 2) / ((N - 1) / 2 || 1);
      let lev = 0;
      if (inp.active) { // this dot's slice of the spectrum, 40 Hz in the middle to 8 kHz at the ends
        const f = 40 * Math.pow(200, kk);
        lev = Math.max(0, (inp.bins[Math.min(inp.bins.length - 1, Math.round(f / inp.hz))] / 255 - 0.3) / 0.7);
      }
      d.lev += (lev - d.lev) * Math.min(1, dt * 18);
      let tgt: number;
      if (this.dancing) { const sgn = ((i >> 1) + this.parity) % 2 ? 1 : -1; tgt = sgn * d.lev * d.lev * H * 0.26 * AMP; if (k) d.v -= (1 - kk * 0.6) * H * 2.2 * AMP; }
      else tgt = Math.sin(now * 1.6 + i * 0.35) * H * 0.012 * AMP;
      d.v += ((tgt - d.y) * 170 - d.v * 13) * dt; d.y += d.v * dt;
      let wv = 0, heat = 0;
      for (const p of this.pairs) {
        const u = (now - p.t0) / p.dur, xl = u * cx, xr = W - u * cx;
        const e = Math.exp(-(((x - xl) / sig) ** 2)) + Math.exp(-(((x - xr) / sig) ** 2));
        wv += e * p.amp * H * 0.17 * (0.6 + 0.4 * u); heat = Math.max(heat, e * p.amp);
      }
      for (const b of this.bursts) {
        const age = now - b.t0, r = age * W * 0.75, dec = Math.exp(-age * 2.6);
        const e = Math.exp(-(((Math.abs(x - cx) - r) / (sig * 1.4)) ** 2)) * dec;
        wv += e * b.amp * H * 0.2 * Math.sin(age * 14 + 1.2); heat = Math.max(heat, e * b.amp);
      }
      pts.push({ x, y: y0 + d.y - wv * AMP, b: Math.min(1, 0.32 + d.lev * 0.8 + heat), h: Math.min(1, heat + d.lev * 0.35) });
    }
    const rr = Math.max(2.2, sx * 0.2);
    this.face(pts, y0, now, cx, inp);
    const faceW = (Math.min(W * 0.36, H * 0.5) / 2) * 1.05;
    g.globalCompositeOperation = 'lighter';
    for (const p of pts) {
      const s = rr * (5 + 4 * p.b);
      if (!p.nr && Math.abs(p.x - cx) > faceW) { g.globalAlpha = 0.25 * p.b; g.drawImage(this.glowW, p.x - s / 2, y0 * 2 - p.y + rr * 2 - s / 2, s, s); }
      g.globalAlpha = p.b * 0.75; g.drawImage(p.h > 0.35 ? this.glowR : this.glowW, p.x - s / 2, p.y - s / 2, s, s);
    }
    g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
    for (const p of pts) {
      const r = rr * (0.8 + 0.5 * p.b);
      g.fillStyle = `rgb(${Math.round(255 - p.h * 30)},${Math.round(236 - p.h * 190)},${Math.round(224 - p.h * 180)})`;
      g.beginPath(); g.arc(p.x, p.y, r, 0, 7); g.fill();
    }
  }

  /** Over-ear headphones: a band over the head and two cups over the ears that glow on the beat. */
  private headphones(cx: number, cy: number, hw: number, hh: number, on: number) {
    const g = this.g, glow = Math.max(this.flash, this.beat);
    g.save(); g.shadowBlur = 0;
    // band
    g.lineCap = 'round';
    g.strokeStyle = '#0d0909'; g.lineWidth = hw * 0.11;
    g.beginPath(); g.moveTo(cx - hw * 1.04, cy - hh * 0.12);
    g.bezierCurveTo(cx - hw * 1.12, cy - hh * 1.42, cx + hw * 1.12, cy - hh * 1.42, cx + hw * 1.04, cy - hh * 0.12); g.stroke();
    g.strokeStyle = `rgba(241,226,214,${0.35 * on})`; g.lineWidth = Math.max(1.5, hw * 0.014);
    g.beginPath(); g.moveTo(cx - hw * 1.0, cy - hh * 0.2);
    g.bezierCurveTo(cx - hw * 1.06, cy - hh * 1.36, cx + hw * 1.06, cy - hh * 1.36, cx + hw * 1.0, cy - hh * 0.2); g.stroke();
    // cups
    for (const s of [-1, 1]) {
      const x = cx + s * hw * 1.02, y = cy - hh * 0.04, w = hw * 0.26, h = hh * 0.46;
      g.fillStyle = '#0d0909'; g.beginPath(); g.roundRect(x - w / 2, y - h / 2, w, h, w * 0.45); g.fill();
      g.strokeStyle = `rgba(227,38,47,${(0.45 + 0.55 * glow) * on})`; g.lineWidth = Math.max(1.5, hw * 0.016);
      g.shadowColor = 'rgba(227,38,47,.8)'; g.shadowBlur = 6 + glow * 20; g.stroke(); g.shadowBlur = 0;
      g.fillStyle = `rgba(227,38,47,${(0.15 + 0.6 * glow) * on})`;
      g.beginPath(); g.ellipse(x + s * w * 0.08, y, w * 0.16, h * 0.28, 0, 0, 7); g.fill();
    }
    g.restore();
  }

  /** Face drawn around the middle; the middle dots become its lips. */
  private face(pts: Pt[], y0: number, now: number, cx: number, inp: StageInput) {
    const { W, H, g } = this;
    const hw = Math.min(W * 0.36, H * 0.5) / 2, hh = hw * 1.3, cy = y0 - hh * 0.36, mw = hw * 0.58, on = inp.active ? 1 : 0.55;
    const up: Pt[] = [], lo: Pt[] = [];
    for (const p of pts) {
      const d = Math.abs(p.x - cx); if (d >= mw) continue;
      const t = 1 - (d / mw) ** 2, o = Math.min(hh * 0.3, Math.abs(y0 - p.y) * 1.15) * t; // the mouth opens as the dots move
      const snap = Math.min(1, t * 2.5); // the whole mouth span sits on the lips
      p.y = p.y + (y0 - o * 0.45 - p.y) * snap; up.push(p);
      lo.push({ x: p.x, y: y0 + o * 0.65, b: p.b * 0.85, h: p.h, nr: true });
    }
    pts.push(...lo);
    if (up.length) {
      g.beginPath(); g.moveTo(cx - mw, y0); for (const p of up) g.lineTo(p.x, p.y); g.lineTo(cx + mw, y0);
      for (let i = lo.length - 1; i >= 0; i--) g.lineTo(lo[i].x, lo[i].y); g.closePath();
      const open = Math.max(...lo.map((q) => q.y - y0)), gr = g.createLinearGradient(0, y0 - open, 0, y0 + open);
      gr.addColorStop(0, '#050102'); gr.addColorStop(1, `rgba(150,20,28,${Math.min(0.9, open / (hh * 0.25))})`);
      g.fillStyle = gr; g.fill(); g.strokeStyle = `rgba(241,190,180,${0.25 * on})`; g.lineWidth = 1.5; g.stroke();
    }
    if (this.flash > 0.5) this.brow = Math.max(this.brow, this.flash);
    if (this.beat > 0.95) this.brow = Math.max(this.brow, 0.6);
    this.brow *= 0.93;
    g.save(); g.strokeStyle = `rgba(241,226,214,${0.32 * on})`; g.lineWidth = Math.max(1.5, hw * 0.012); g.lineCap = 'round';
    g.shadowColor = 'rgba(227,38,47,.6)'; g.shadowBlur = 8 + this.flash * 18;
    g.beginPath(); g.moveTo(cx - hw * 0.98, cy - hh * 0.1);
    g.bezierCurveTo(cx - hw * 1.05, cy - hh * 1.25, cx + hw * 1.05, cy - hh * 1.25, cx + hw * 0.98, cy - hh * 0.1);
    g.bezierCurveTo(cx + hw * 0.95, cy + hh * 0.55, cx + hw * 0.45, cy + hh * 1.02, cx, cy + hh * 1.02);
    g.bezierCurveTo(cx - hw * 0.45, cy + hh * 1.02, cx - hw * 0.95, cy + hh * 0.55, cx - hw * 0.98, cy - hh * 0.1); g.stroke();
    this.headphones(cx, cy, hw, hh, on);
    if (now > this.blinkAt + 0.14) this.blinkAt = now + 2.5 + Math.random() * 3;
    const bl = now > this.blinkAt ? 0.12 : 1, ey = cy - hh * 0.2, ew = hw * 0.24, eh = ew * 0.42 * bl;
    for (const s of [-1, 1]) {
      const ex = cx + s * hw * 0.4;
      g.beginPath(); g.moveTo(ex - ew, ey); g.quadraticCurveTo(ex, ey - eh * 2, ex + ew, ey); g.quadraticCurveTo(ex, ey + eh * 2, ex - ew, ey); g.stroke();
      if (bl === 1) { g.save(); g.shadowBlur = 0; g.fillStyle = `rgba(227,38,47,${(0.35 + 0.65 * this.flash) * on})`; g.beginPath(); g.arc(ex, ey, eh * 0.75, 0, 7); g.fill(); g.restore(); }
      const by = ey - ew * 0.75 - this.brow * hw * 0.1;
      g.beginPath(); g.moveTo(ex - s * ew * 0.9, by + ew * 0.12); g.quadraticCurveTo(ex, by - ew * 0.25, ex + s * ew * 1.05, by + ew * 0.02 * (1 - this.brow * 3)); g.stroke();
    }
    g.beginPath(); g.moveTo(cx - hw * 0.03, ey + eh); g.quadraticCurveTo(cx - hw * 0.05, cy + hh * 0.05, cx - hw * 0.13, cy + hh * 0.12);
    g.quadraticCurveTo(cx - hw * 0.02, cy + hh * 0.18, cx + hw * 0.1, cy + hh * 0.12); g.stroke();
    g.restore();
  }
}
