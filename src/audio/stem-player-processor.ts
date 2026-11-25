/**
 * Plays the separated stems coming from the AI worker and mixes them with live per-stem gains,
 * so switching an instrument on or off is instant even though separation runs seconds ahead.
 * Stem order follows HT-Demucs: drums, bass, other, vocals.
 */
interface Block { data: Float32Array[]; pos: number; len: number }

const PREBUFFER = 0.3; // seconds of audio queued before playback (re)starts

class StemPlayer extends AudioWorkletProcessor {
  private q: Block[] = [];
  private buffered = 0;
  private playing = false;
  private gains = [1, 1, 1, 1];
  private cur = [1, 1, 1, 1];
  private acc = [0, 0, 0, 0];
  private accN = 0;
  private underruns = 0;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent) => {
      const d = e.data;
      if (d.port) (d.port as MessagePort).onmessage = (m: MessageEvent) => this.onBlock(m.data);
      if (d.gains) this.gains = d.gains.slice();
      if (d.type === 'reset') { this.q = []; this.buffered = 0; this.playing = false; }
    };
  }

  private onBlock(d: { type: string; data: Float32Array[] }) {
    if (d.type !== 'stems') return;
    const len = d.data[0].length;
    this.q.push({ data: d.data, pos: 0, len });
    this.buffered += len;
  }

  process(_in: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0], L = out[0], R = out[1] ?? out[0], n = L.length;
    if (!this.playing && this.buffered >= PREBUFFER * sampleRate) this.playing = true;
    for (let s = 0; s < 4; s++) this.cur[s] += (this.gains[s] - this.cur[s]) * 0.08; // ~20 ms ramp
    for (let i = 0; i < n; i++) {
      if (!this.playing) { L[i] = 0; R[i] = 0; continue; }
      const b = this.q[0];
      if (!b) { this.playing = false; this.underruns++; L[i] = 0; R[i] = 0; continue; }
      let l = 0, r = 0;
      for (let s = 0; s < 4; s++) {
        const sl = b.data[s * 2][b.pos], sr = b.data[s * 2 + 1][b.pos];
        this.acc[s] += sl * sl + sr * sr;
        l += sl * this.cur[s];
        r += sr * this.cur[s];
      }
      L[i] = l; R[i] = r;
      this.accN++;
      this.buffered--;
      if (++b.pos >= b.len) this.q.shift();
    }
    if (this.accN >= 2048) {
      this.port.postMessage({
        type: 'level',
        rms: this.acc.map((a) => Math.sqrt(a / (2 * this.accN))),
        buffered: this.buffered / sampleRate,
        playing: this.playing,
        underruns: this.underruns,
      });
      this.acc = [0, 0, 0, 0];
      this.accN = 0;
    }
    return true;
  }
}

registerProcessor('melostem-stem-player', StemPlayer);
