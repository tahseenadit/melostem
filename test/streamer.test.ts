import { describe, expect, it } from 'vitest';
import { BINS, FRAMES, SEGMENT, spectrogram } from '../src/ai/demucs-dsp';
import { Streamer } from '../src/ai/streamer';

/** A fake "model" that puts the whole mix into the vocals stem: the stream must come out intact. */
const identity = async (l: Float32Array, r: Float32Array) => {
  const x = new Float32Array(4 * 4 * BINS * FRAMES);
  x.set(spectrogram(l, r), 3 * 4 * BINS * FRAMES);
  return { x, xt: new Float32Array(4 * 2 * SEGMENT) };
};

describe('Streamer', () => {
  it('emits contiguous blocks that reproduce the input stream (slices + crossfades are seamless)', async () => {
    const hop = 44100, blocks: Float32Array[][] = [];
    const s = new Streamer(identity, (d) => blocks.push(d), () => {}, hop, 22050);
    s.running = true;
    const sig = (n: number) => 0.4 * Math.sin(2 * Math.PI * 233 * n / 44100) + 0.2 * Math.sin(2 * Math.PI * 1777 * n / 44100);
    const total = 44100 * 5;
    for (let n = 0; n < total; n += 4096) {
      const len = Math.min(4096, total - n), l = new Float32Array(len), r = new Float32Array(len);
      for (let i = 0; i < len; i++) { l[i] = sig(n + i); r[i] = -sig(n + i); }
      await s.push(l, r);
    }
    expect(blocks.length).toBeGreaterThanOrEqual(3);
    let err = 0;
    blocks.forEach((b, k) => {
      for (let i = 0; i < hop; i++) {
        const n = k * hop + i;
        err = Math.max(err, Math.abs(b[6][i] - sig(n)), Math.abs(b[7][i] + sig(n))); // vocals L/R
        err = Math.max(err, Math.abs(b[0][i])); // drums stay silent
      }
    });
    expect(err).toBeLessThan(1e-3);
  }, 60000);
});
