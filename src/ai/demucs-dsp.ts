/**
 * Pre- and post-processing for HT-Demucs, reproducing demucs' HTDemucs._spec / _magnitude
 * and _mask / _ispec (complex-as-channels) so the ONNX graph sees exactly what PyTorch would.
 */
import { FFT, hann } from '../dsp/fft';

export const SAMPLE_RATE = 44100;
export const SEGMENT = 343980; // samples per model call (~7.8 s)
export const NFFT = 4096;
export const HOP = 1024;
export const BINS = 2048; // Nyquist bin dropped
export const FRAMES = Math.ceil(SEGMENT / HOP); // 336
export const STEMS = ['drums', 'bass', 'other', 'vocals'] as const;
const PAD = (HOP / 2) * 3; // 1536
const PADDED = FRAMES * HOP + 2 * PAD; // length after demucs' own reflect padding
const NORM = 1 / Math.sqrt(NFFT); // torch.stft(normalized=True)

const fft = new FFT(NFFT);
const win = hann(NFFT);

function reflect(i: number, len: number): number {
  // torch 'reflect' padding: the edge sample is not repeated
  while (i < 0 || i >= len) {
    if (i < 0) i = -i;
    if (i >= len) i = 2 * (len - 1) - i;
  }
  return i;
}

/** Sample j of the signal torch.stft actually windows (demucs pad, then centre pad). */
function sampleAt(x: Float32Array, j: number): number {
  const p = reflect(j - NFFT / 2, PADDED); // undo torch.stft centre padding
  const q = p - PAD; // undo demucs' own padding
  if (q < x.length) return x[reflect(q, x.length)];
  // right-hand demucs pad reaches past the signal: reflect about the last sample
  return x[reflect(q, x.length)];
}

/**
 * Stereo segment -> model input `mag` [1, 4, BINS, FRAMES], channel order L.re, L.im, R.re, R.im.
 */
export function spectrogram(left: Float32Array, right: Float32Array): Float32Array {
  const out = new Float32Array(4 * BINS * FRAMES);
  const re = new Float32Array(NFFT), im = new Float32Array(NFFT);
  [left, right].forEach((x, c) => {
    for (let f = 0; f < FRAMES; f++) {
      const t = f + 2; // demucs keeps frames 2 .. 2+FRAMES
      const start = t * HOP;
      for (let i = 0; i < NFFT; i++) { re[i] = sampleAt(x, start + i) * win[i]; im[i] = 0; }
      fft.transform(re, im);
      const bRe = (c * 2) * BINS * FRAMES, bIm = (c * 2 + 1) * BINS * FRAMES;
      for (let k = 0; k < BINS; k++) {
        out[bRe + k * FRAMES + f] = re[k] * NORM;
        out[bIm + k * FRAMES + f] = im[k] * NORM;
      }
    }
  });
  return out;
}

/** Centre of frame f in segment sample coordinates. */
const frameCentre = (f: number) => f * HOP + HOP / 2;

/**
 * Inverse STFT of one stem/channel from the model's frequency-branch output `x`
 * ([1, 4 stems, 4, BINS, FRAMES]) over segment samples [a, b) only.
 */
export function istftRegion(x: Float32Array, stem: number, ch: number, a: number, b: number): Float32Array {
  const len = b - a;
  const acc = new Float64Array(len), env = new Float64Array(len);
  const re = new Float32Array(NFFT), im = new Float32Array(NFFT);
  const planeRe = ((stem * 4) + ch * 2) * BINS * FRAMES, planeIm = planeRe + BINS * FRAMES;
  const scale = Math.sqrt(NFFT) / NFFT; // istft(normalized=True) and the 1/n of the inverse FFT
  // frames -2..FRAMES+1 exist in torch (zero padding of 2 frames each side); they count in the window envelope
  for (let f = -2; f < FRAMES + 2; f++) {
    const s0 = frameCentre(f) - NFFT / 2;
    if (s0 >= b || s0 + NFFT <= a) continue;
    const real = f >= 0 && f < FRAMES;
    if (real) {
      re.fill(0); im.fill(0);
      for (let k = 0; k < BINS; k++) { re[k] = x[planeRe + k * FRAMES + f]; im[k] = x[planeIm + k * FRAMES + f]; }
      for (let k = 1; k < BINS; k++) { re[NFFT - k] = re[k]; im[NFFT - k] = -im[k]; }
      fft.transform(re, im, true);
    }
    const i0 = Math.max(0, a - s0), i1 = Math.min(NFFT, b - s0);
    for (let i = i0; i < i1; i++) {
      const o = s0 + i - a, w = win[i];
      if (real) acc[o] += re[i] * scale * w;
      env[o] += w * w;
    }
  }
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) out[i] = env[i] > 1e-8 ? acc[i] / env[i] : 0;
  return out;
}

/** Model outputs -> one stem/channel over [a, b): frequency branch (iSTFT) + time branch. */
export function stemRegion(x: Float32Array, xt: Float32Array, stem: number, ch: number, a: number, b: number): Float32Array {
  const out = istftRegion(x, stem, ch, a, b);
  const base = (stem * 2 + ch) * SEGMENT;
  for (let i = 0; i < out.length; i++) out[i] += xt[base + a + i];
  return out;
}
