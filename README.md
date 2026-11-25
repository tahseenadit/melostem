# inmusic

Live karaoke for anything playing on your computer. Share a YouTube tab, or your whole screen's
audio to catch Spotify, VLC or any other player, then switch the **vocals, drums, bass and other
instruments** on and off while the song plays. A line of dots dances to the drums and a face sings
along.

## Modes

| Mode | How it splits the song | Delay |
| --- | --- | --- |
| **Original** | Nothing, the sound passes through | none |
| **Instant** | Signal processing in an AudioWorklet: harmonic/percussive separation for drums, a pitch-tracking comb for the singer, stereo position for vocals vs. guitars, steady lows for bass. Optional clean-up passes remove leftover vocal haze. | ~0.2 s per pass |
| **AI** | [HT-Demucs](https://github.com/facebookresearch/demucs) (Meta, MIT) running on your GPU with onnxruntime-web + WebGPU, in a Web Worker | a few seconds |

Switching instruments on and off is instant in every mode: in AI mode the four stems are already
separated and are mixed live in the stem player.

## How the AI mode streams

HT-Demucs works on fixed ~7.8 s segments. Every *step* (1, 2 or 4 s, set in the UI) the worker
separates the latest 7.8 s, keeps only the step-long slice that ends 0.5 s before the segment
edge, and crossfades it onto the previous slice. Delay is roughly step + 0.5 s + compute time, and
the GPU has to run faster than real time by a factor of about 7.8 s / step. The page shows the live
speed and delay. If the GPU falls behind, it skips ahead instead of drifting.

The model (about 126 MB, the fp16 split build from
[monteslu/htdemucs-web-onnx](https://huggingface.co/monteslu/htdemucs-web-onnx)) downloads on first
use and is cached by the browser. STFT pre-processing and iSTFT post-processing reproduce demucs'
own `_spec` / `_ispec` in `src/ai/demucs-dsp.ts`.

## Run it

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # STFT round trip + streaming tests
npm run build
```

Use Chrome or Edge. "Share audio" opens the browser's picker: choose a tab and tick
**Share tab audio**, or choose **Entire screen** and tick **Share system audio**. The shared tab's own
sound is muted so you only hear the processed version.

## Layout

```
src/
  main.ts                     UI wiring, keyboard shortcuts
  audio/engine.ts             audio graph, sources, mode switching
  audio/instant-processor.ts  Instant-mode DSP splitter (AudioWorklet)
  audio/tap-processor.ts      sends live audio to the AI worker
  audio/stem-player-processor.ts  plays AI stems with live per-instrument gains
  ai/separator.worker.ts      model download/cache, ONNX sessions, inference
  ai/streamer.ts              segmenting, slicing and crossfading for live input
  ai/demucs-dsp.ts            demucs-compatible STFT / iSTFT
  viz/stage.ts                dots, waves, singing face, mosh crowd
```

Audio never leaves your computer.
