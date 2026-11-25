/**
 * Turns a live audio stream into a stream of separated stems using a fixed-length model.
 * Every `hop` new samples it separates the last SEGMENT samples and keeps a `hop`-long slice
 * ending `margin` before the segment end (models are weakest at the edges). Slices are crossfaded.
 * Output block k covers input samples [k*hop, (k+1)*hop), so latency ~= hop + margin + compute time.
 */
import { SEGMENT, stemRegion } from './demucs-dsp';

export type Separate = (l: Float32Array, r: Float32Array) => Promise<{ x: Float32Array; xt: Float32Array }>;
export const XF = 2048;

export class Streamer {
  private histL = new Float32Array(SEGMENT * 2);
  private histR = new Float32Array(SEGMENT * 2);
  private total = 0;
  private nextEnd = 0;
  private busy = false;
  private prevTail: Float32Array[] | null = null;
  running = false;

  constructor(
    private separate: Separate,
    private onBlock: (stems: Float32Array[], ms: number) => void,
    private onSkip: () => void,
    public hop = 88200,
    public margin = 22050,
  ) { this.reset(); }

  reset() { this.total = 0; this.nextEnd = this.margin + this.hop; this.prevTail = null; this.histL.fill(0); this.histR.fill(0); }

  push(l: Float32Array, r: Float32Array): Promise<void> {
    const H = this.histL.length;
    for (let i = 0; i < l.length; i++) { const p = (this.total + i) % H; this.histL[p] = l[i]; this.histR[p] = r[i]; }
    this.total += l.length;
    return this.pump();
  }

  private segmentEndingAt(end: number): [Float32Array, Float32Array] {
    const L = new Float32Array(SEGMENT), R = new Float32Array(SEGMENT), H = this.histL.length;
    for (let i = 0; i < SEGMENT; i++) {
      const abs = end - SEGMENT + i; if (abs < 0) continue;
      const p = abs % H; L[i] = this.histL[p]; R[i] = this.histR[p];
    }
    return [L, R];
  }

  private async pump(): Promise<void> {
    if (this.busy || !this.running || this.total < this.nextEnd) return;
    this.busy = true;
    try {
      while (this.running && this.total >= this.nextEnd) {
        if (this.total - this.nextEnd > SEGMENT) { // fell far behind: skip ahead instead of drifting
          this.nextEnd += Math.floor((this.total - this.nextEnd) / this.hop) * this.hop; this.prevTail = null; this.onSkip();
        }
        const end = this.nextEnd; this.nextEnd += this.hop;
        const t0 = performance.now();
        const [L, R] = this.segmentEndingAt(end);
        const { x, xt } = await this.separate(L, R);
        const b = SEGMENT - this.margin, a = b - this.hop;
        const data: Float32Array[] = [], tail: Float32Array[] = [];
        for (let s = 0; s < 4; s++) for (let c = 0; c < 2; c++) {
          const seg = stemRegion(x, xt, s, c, a, b + XF);
          const out = seg.slice(0, this.hop), prev = this.prevTail?.[s * 2 + c];
          if (prev) for (let i = 0; i < XF; i++) { const w = i / XF; out[i] = out[i] * w + prev[i] * (1 - w); }
          data.push(out); tail.push(seg.slice(this.hop, this.hop + XF));
        }
        this.prevTail = tail;
        this.onBlock(data, performance.now() - t0);
      }
    } finally { this.busy = false; }
  }
}
