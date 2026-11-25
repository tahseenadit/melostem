import { describe, expect, it } from 'vitest';
import { BINS, FRAMES, SEGMENT, istftRegion, spectrogram } from '../src/ai/demucs-dsp';

describe('demucs STFT round trip', () => {
  it('reconstructs the input through spectrogram -> iSTFT in the segment interior', () => {
    const l = new Float32Array(SEGMENT), r = new Float32Array(SEGMENT);
    for (let i = 0; i < SEGMENT; i++) {
      const t = i / 44100;
      l[i] = 0.5 * Math.sin(2 * Math.PI * 220 * t) + 0.2 * Math.sin(2 * Math.PI * 3150 * t);
      r[i] = 0.4 * Math.sin(2 * Math.PI * 330 * t + 1);
    }
    const mag = spectrogram(l, r);
    expect(mag.length).toBe(4 * BINS * FRAMES);
    // treat the spectrogram as a single "stem" with model layout [stems=4, 4, BINS, FRAMES]
    const x = new Float32Array(4 * 4 * BINS * FRAMES);
    x.set(mag, 3 * 4 * BINS * FRAMES); // put it in stem 3 (vocals)
    const a = 200000, b = 220000;
    const outL = istftRegion(x, 3, 0, a, b), outR = istftRegion(x, 3, 1, a, b);
    let err = 0;
    for (let i = 0; i < b - a; i++) err = Math.max(err, Math.abs(outL[i] - l[a + i]), Math.abs(outR[i] - r[a + i]));
    expect(err).toBeLessThan(1e-4);
  });
});
