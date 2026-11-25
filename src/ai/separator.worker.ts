/**
 * AI separation worker: runs HT-Demucs (4 stems) on WebGPU with onnxruntime-web,
 * streaming. Audio arrives from the tap worklet; separated stems go to the stem player.
 *
 * Streaming scheme: every `hop` new samples we separate the last SEGMENT samples (~7.8 s) and keep
 * only a `hop`-long slice that ends `margin` before the segment end (the model is weakest right at
 * the edges). Consecutive slices are crossfaded. Latency ~= hop + margin + processing time.
 */
import * as ort from 'onnxruntime-web/webgpu';
import { SEGMENT, BINS, FRAMES, spectrogram } from './demucs-dsp';
import { Streamer } from './streamer';

ort.env.wasm.numThreads = 1; // no cross-origin isolation needed (the wasm file is bundled by Vite)

export const DEFAULT_MODEL_BASE = 'https://huggingface.co/monteslu/htdemucs-web-onnx/resolve/main/';
const CPU_NODES = ['/ReduceMean', '/Sub', '/Pow', '/ReduceMean_1', '/Clip', '/Sqrt', '/Add', '/Div',
  '/ReduceMean_2', '/Sub_1', '/Pow_1', '/ReduceMean_3', '/Clip_1', '/Sqrt_1', '/Add_1', '/Div_1'];

interface Piece { file: string; inputs: string[]; outputs: string[] }
interface Manifest { pieces: Piece[]; outputs: { freq: string; time: string } }

let sessions: ort.InferenceSession[] = [];
let manifest: Manifest | null = null;
let playerPort: MessagePort | null = null;
const post = (m: unknown, t: Transferable[] = []) => (self as unknown as Worker).postMessage(m, t);

let streamer: Streamer;
let fromCache = false;
async function fetchCached(url: string, onBytes: (n: number) => void): Promise<ArrayBuffer> {
  const cache = 'caches' in self ? await caches.open('inmusic-models-v1') : null;
  const hit = cache ? await cache.match(url) : undefined;
  if (hit) { fromCache = true; const b = await hit.arrayBuffer(); onBytes(b.byteLength); return b; }
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}) for ${url}`);
  const reader = res.body.getReader(); const parts: Uint8Array[] = []; let n = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break; parts.push(value); n += value.length; onBytes(value.length); }
  const buf = new Uint8Array(n); let o = 0; for (const p of parts) { buf.set(p, o); o += p.length; }
  if (cache) await cache.put(url, new Response(buf));
  return buf.buffer;
}

async function load(base: string) {
  if (!('gpu' in navigator) || !(await (navigator as Navigator).gpu.requestAdapter())) {
    throw new Error('WebGPU is not available in this browser. Use a recent Chrome or Edge on a computer with a graphics card.');
  }
  const mRes = await fetch(base + 'htdemucs_split_manifest.json');
  if (!mRes.ok) throw new Error(`Could not download the model manifest (${mRes.status}).`);
  const raw = await mRes.json();
  const pieces: Piece[] = Array.isArray(raw) ? raw : raw.pieces ?? raw.files ?? raw.chain;
  manifest = { pieces, outputs: raw.outputs ?? { freq: 'x', time: 'xt' } };
  let bytes = 0;
  const approxTotal = 126e6;
  sessions = [];
  for (let i = 0; i < pieces.length; i++) {
    const buf = await fetchCached(base + pieces[i].file, (n) => {
      bytes += n; post({ type: 'progress', phase: 'download', done: bytes, total: approxTotal, cached: fromCache });
    });
    const ep = i === 0 ? [{ name: 'webgpu', forceCpuNodeNames: CPU_NODES }] : ['webgpu'];
    sessions.push(await ort.InferenceSession.create(buf, {
      executionProviders: ep as ort.InferenceSession.ExecutionProviderConfig[],
      graphOptimizationLevel: 'all',
      preferredOutputLocation: i === pieces.length - 1 ? 'cpu' : 'gpu-buffer',
    }));
    post({ type: 'progress', phase: 'compile', done: i + 1, total: pieces.length });
  }
}

async function separate(L: Float32Array, R: Float32Array): Promise<{ x: Float32Array; xt: Float32Array }> {
  if (!manifest) throw new Error('model not loaded');
  const mix = new Float32Array(SEGMENT * 2); mix.set(L, 0); mix.set(R, SEGMENT);
  const env = new Map<string, ort.Tensor>();
  env.set('mix', new ort.Tensor('float32', mix, [1, 2, SEGMENT]));
  env.set('mag', new ort.Tensor('float32', spectrogram(L, R), [1, 4, BINS, FRAMES]));
  const { pieces } = manifest, keep = new Set([manifest.outputs.freq, manifest.outputs.time]);
  for (let i = 0; i < pieces.length; i++) {
    const feeds: Record<string, ort.Tensor> = {};
    for (const name of pieces[i].inputs) {
      const t = env.get(name); if (!t) throw new Error(`missing tensor ${name} for piece ${i}`);
      feeds[name] = t;
    }
    const res = await sessions[i].run(feeds);
    for (const [k, v] of Object.entries(res)) env.set(k, v);
    // free tensors no later piece needs
    for (const [name, t] of env) {
      if (keep.has(name)) continue;
      const needed = pieces.slice(i + 1).some((p) => p.inputs.includes(name));
      if (!needed) { t.dispose(); env.delete(name); }
    }
  }
  const x = (await env.get(manifest.outputs.freq)!.getData()) as Float32Array;
  const xt = (await env.get(manifest.outputs.time)!.getData()) as Float32Array;
  for (const t of env.values()) t.dispose();
  return { x, xt };
}

streamer = new Streamer(
  separate,
  (data, ms) => {
    playerPort?.postMessage({ type: 'stems', data }, data.map((d) => d.buffer));
    post({ type: 'stats', ms, realtime: (streamer.hop / 44100 * 1000) / ms, latency: (streamer.hop + streamer.margin) / 44100 + ms / 1000 + 0.3 }); // + player pre-buffer
  },
  () => post({ type: 'skip' }),
);
const push = (l: Float32Array, r: Float32Array) =>
  streamer.push(l, r).catch((e) => { streamer.running = false; post({ type: 'error', message: (e as Error).message }); });

self.onmessage = async (e: MessageEvent) => {
  const d = e.data;
  try {
    if (d.type === 'load') { await load(d.base || DEFAULT_MODEL_BASE); post({ type: 'ready' }); }
    else if (d.type === 'ports') {
      (d.tap as MessagePort).onmessage = (m: MessageEvent) => { if (m.data.type === 'audio') push(m.data.l, m.data.r); };
      playerPort = d.player as MessagePort;
    } else if (d.type === 'config') {
      if (d.hop) streamer.hop = Math.round(d.hop * 44100);
      if (d.margin != null) streamer.margin = Math.round(d.margin * 44100);
      streamer.reset();
    } else if (d.type === 'start') { streamer.reset(); streamer.running = true; }
    else if (d.type === 'stop') { streamer.running = false; }
  } catch (err) {
    post({ type: 'error', message: (err as Error).message });
  }
};
