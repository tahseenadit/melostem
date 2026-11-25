# inmusic

Live karaoke for anything playing on your computer. Share a YouTube tab, or your whole screen's
audio to catch Spotify, VLC or any other player, then switch the **vocals, drums, bass and other
instruments** on and off while the song plays. A line of dots dances to the drums and a face sings
along.

## How it works

[HT-Demucs](https://github.com/facebookresearch/demucs) (Meta, MIT) runs on your graphics card with
onnxruntime-web and WebGPU, in a Web Worker. The model loads automatically when the page opens
(downloaded once, then cached). Switching an instrument on or off is instant: the four parts are
already separated and are mixed live in the stem player.

The dots follow the music: each dot tracks its own slice of the spectrum (bass in the middle,
treble at the ends), and every kick drum sends a wave in from both ends.

## How live separation works

HT-Demucs works on fixed ~7.8 s segments. Every *step* (2 s, raised automatically to 4 or 6 s on slower
graphics cards) the worker separates the latest 7.8 s, keeps only the step-long slice that ends 0.5 s before the segment
edge, and crossfades it onto the previous slice. Delay is roughly step + 0.5 s + compute time, and
the GPU has to run faster than real time by a factor of about 7.8 s / step. The page explains the
current delay and whether the computer is keeping up, in plain words. If the GPU falls behind, it
skips ahead instead of drifting.

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
  audio/engine.ts             audio graph, sources, AI start-up and pacing
  audio/tap-processor.ts      sends live audio to the AI worker
  audio/stem-player-processor.ts  plays AI stems with live per-instrument gains
  ai/separator.worker.ts      model download/cache, ONNX sessions, inference
  ai/streamer.ts              segmenting, slicing and crossfading for live input
  ai/demucs-dsp.ts            demucs-compatible STFT / iSTFT
  viz/stage.ts                dots, waves and the face
```

Audio never leaves your computer.
