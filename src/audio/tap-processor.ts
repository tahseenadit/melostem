/**
 * Tap: copies the stereo input into fixed-size chunks and sends them straight to the
 * separation worker over a MessagePort (no main-thread hop). Outputs nothing.
 */
const CHUNK = 4096;

class TapProcessor extends AudioWorkletProcessor {
  private out: MessagePort | null = null;
  private l = new Float32Array(CHUNK);
  private r = new Float32Array(CHUNK);
  private n = 0;
  private on = false;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent) => {
      if (e.data.port) this.out = e.data.port as MessagePort;
      if (e.data.on != null) this.on = !!e.data.on;
    };
  }

  process(inputs: Float32Array[][]): boolean {
    const inp = inputs[0];
    if (!this.on || !this.out || !inp || !inp[0]) return true;
    const L = inp[0], R = inp[1] ?? inp[0];
    for (let i = 0; i < L.length; i++) {
      this.l[this.n] = L[i];
      this.r[this.n] = R[i];
      if (++this.n === CHUNK) {
        this.out.postMessage({ type: 'audio', l: this.l, r: this.r }, [this.l.buffer, this.r.buffer]);
        this.l = new Float32Array(CHUNK);
        this.r = new Float32Array(CHUNK);
        this.n = 0;
      }
    }
    return true;
  }
}

registerProcessor('inmusic-tap', TapProcessor);
