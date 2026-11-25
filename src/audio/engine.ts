/**
 * Audio engine: one input (a shared tab / whole-system audio, or a local file), three routes
 * that can be switched live, and one output feeding the speakers and the visualiser.
 *
 *   input ─┬─ original ────────────────┐
 *          ├─ instant (DSP splitter) ──┼─ out ─ analyser ─ speakers
 *          └─ tap → AI worker → stem player ┘
 */
import tapUrl from './tap-processor.ts?worker&url';
import playerUrl from './stem-player-processor.ts?worker&url';
import instantUrl from './instant-processor.ts?worker&url';

export type Mode = 'original' | 'instant' | 'ai';
/** UI stem order. */
export const STEM_NAMES = ['Vocals', 'Drums', 'Bass', 'Other'] as const;
/** UI index -> HT-Demucs index (drums, bass, other, vocals). */
const UI_TO_AI = [3, 0, 1, 2];

export interface AiStatus { state: 'idle' | 'loading' | 'ready' | 'running' | 'error'; text: string; progress?: number; realtime?: number; latency?: number }

export class Engine {
  readonly ac = new AudioContext({ sampleRate: 44100, latencyHint: 'playback' });
  readonly input = new GainNode(this.ac, { channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers' });
  readonly out = new GainNode(this.ac);
  readonly analyser = new AnalyserNode(this.ac, { fftSize: 2048, smoothingTimeConstant: 0.25 });
  mode: Mode = 'original';
  stems = [true, true, true, true];
  instantLevels = [-120, -120, -120, -120];
  aiLevels = [0, 0, 0, 0];
  pitch = 0;
  ai: AiStatus = { state: 'idle', text: 'AI model not loaded yet' };
  onChange: () => void = () => {};

  private gOrig = new GainNode(this.ac, { gain: 1 });
  private gInst = new GainNode(this.ac, { gain: 0 });
  private gAi = new GainNode(this.ac, { gain: 0 });
  private instant: AudioWorkletNode[] = [];
  private passes = 1;
  private vmode = 0;
  private tap?: AudioWorkletNode;
  private player?: AudioWorkletNode;
  private worker?: Worker;
  private source?: AudioNode;
  private stream?: MediaStream;
  private ready: Promise<void>;

  constructor() {
    this.input.connect(this.gOrig).connect(this.out);
    this.gInst.connect(this.out);
    this.gAi.connect(this.out);
    this.out.connect(this.analyser);
    this.out.connect(this.ac.destination);
    this.ready = this.init();
  }

  private async init() {
    await Promise.all([tapUrl, playerUrl, instantUrl].map((u) => this.ac.audioWorklet.addModule(u)));
    const mk = () => new AudioWorkletNode(this.ac, 'inmusic-instant', { outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit' });
    this.instant = [mk(), mk(), mk()];
    this.input.connect(this.instant[0]);
    this.instant[0].port.onmessage = (e) => {
      const d = e.data;
      if (d.p != null) { for (const x of this.instant.slice(1)) x.port.postMessage({ p: d.p }); }
      else if (d.lv) { this.instantLevels = d.lv; this.pitch = d.f0; }
    };
    this.chainInstant();
    this.tap = new AudioWorkletNode(this.ac, 'inmusic-tap', { numberOfOutputs: 0 });
    this.input.connect(this.tap);
    this.player = new AudioWorkletNode(this.ac, 'inmusic-stem-player', { numberOfInputs: 0, outputChannelCount: [2] });
    this.player.connect(this.gAi);
    this.player.port.onmessage = (e) => {
      if (e.data.type === 'level') { this.aiLevels = e.data.rms; if (this.ai.state === 'running') this.ai.text = e.data.playing ? 'AI separating live' : 'AI buffering…'; }
    };
    this.sendStems();
  }

  // ---------- sources ----------
  async shareAudio(): Promise<void> {
    await this.ready; await this.ac.resume();
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      // Chrome: lets the user pick a tab, a window or the entire screen with system audio,
      // and mutes the tab's own playback so only our processed sound is heard.
      audio: { suppressLocalAudioPlayback: true, echoCancellation: false, noiseSuppression: false, autoGainControl: false } as MediaTrackConstraints,
      systemAudio: 'include',
      selfBrowserSurface: 'exclude',
    } as DisplayMediaStreamOptions);
    if (!stream.getAudioTracks().length) { stream.getTracks().forEach((t) => t.stop()); throw new Error('No audio was shared. Try again and tick "Share tab audio" or "Share system audio".'); }
    stream.getVideoTracks().forEach((t) => (t.enabled = false));
    this.setSource(this.ac.createMediaStreamSource(stream), stream);
    stream.getAudioTracks()[0].addEventListener('ended', () => this.stopSource());
  }

  async playFile(el: HTMLMediaElement): Promise<void> {
    await this.ready; await this.ac.resume();
    const anyEl = el as HTMLMediaElement & { _inmusic?: MediaElementAudioSourceNode };
    anyEl._inmusic ??= this.ac.createMediaElementSource(el);
    this.setSource(anyEl._inmusic);
  }

  private setSource(node: AudioNode, stream?: MediaStream) {
    this.stopSource();
    this.source = node; this.stream = stream;
    node.connect(this.input);
    this.restartAi();
    this.onChange();
  }

  stopSource() {
    this.source?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.source = undefined; this.stream = undefined;
    this.onChange();
  }

  get hasSource() { return !!this.source; }

  // ---------- modes and stems ----------
  setMode(m: Mode) {
    this.mode = m;
    const t = this.ac.currentTime;
    this.gOrig.gain.setTargetAtTime(m === 'original' ? 1 : 0, t, 0.03);
    this.gInst.gain.setTargetAtTime(m === 'instant' ? 1 : 0, t, 0.03);
    this.gAi.gain.setTargetAtTime(m === 'ai' ? 1 : 0, t, 0.03);
    this.onChange();
  }

  setStem(i: number, on: boolean) { this.stems[i] = on; this.sendStems(); this.onChange(); }

  setInstantOptions(o: { vmode?: number; passes?: number }) {
    if (o.vmode != null) this.vmode = o.vmode;
    if (o.passes != null) { this.passes = o.passes; this.chainInstant(); }
    this.sendStems();
  }

  private chainInstant() {
    if (!this.instant.length) return;
    for (const n of this.instant) n.disconnect();
    const list = this.instant.slice(0, 1 + this.passes);
    for (let i = 0; i < list.length - 1; i++) list[i].connect(list[i + 1]);
    list[list.length - 1].connect(this.gInst);
  }

  private sendStems() {
    const on = this.stems.map((v) => (v ? 1 : 0));
    this.instant[0]?.port.postMessage({ stems: on, vmode: this.vmode });
    this.instant.slice(1).forEach((n, i) => n.port.postMessage({ stems: [on[0], 1, 1, 1], vmode: 2, lag: 9 * (i + 1) }));
    const g = [0, 0, 0, 0];
    on.forEach((v, ui) => (g[UI_TO_AI[ui]] = v));
    this.player?.port.postMessage({ gains: g });
  }

  /** AI stem levels in UI order. */
  get aiLevelsUi() { return UI_TO_AI.map((a) => this.aiLevels[a]); }

  // ---------- AI ----------
  async loadAi(opts: { hop?: number; margin?: number; base?: string } = {}) {
    await this.ready;
    if (this.worker) return;
    this.ai = { state: 'loading', text: 'Downloading the AI model…', progress: 0 }; this.onChange();
    const w = new Worker(new URL('../ai/separator.worker.ts', import.meta.url), { type: 'module' });
    this.worker = w;
    const tapCh = new MessageChannel(), playCh = new MessageChannel();
    this.tap!.port.postMessage({ port: tapCh.port1 }, [tapCh.port1]);
    this.player!.port.postMessage({ port: playCh.port1 }, [playCh.port1]);
    w.postMessage({ type: 'ports', tap: tapCh.port2, player: playCh.port2 }, [tapCh.port2, playCh.port2]);
    w.onmessage = (e) => {
      const d = e.data;
      if (d.type === 'progress') {
        this.ai = d.phase === 'download'
          ? { state: 'loading', text: `Downloading the AI model: ${(d.done / 1e6).toFixed(0)} MB`, progress: Math.min(0.95, d.done / d.total) }
          : { state: 'loading', text: `Preparing the AI on your graphics card (${d.done}/${d.total})`, progress: 0.95 + 0.05 * (d.done / d.total) };
      } else if (d.type === 'ready') {
        this.ai = { state: 'ready', text: 'AI ready' };
        this.restartAi();
      } else if (d.type === 'stats') {
        this.ai = { ...this.ai, state: 'running', realtime: d.realtime, latency: d.latency };
      } else if (d.type === 'skip') {
        this.ai = { ...this.ai, text: 'Your graphics card is falling behind, so the AI skipped ahead. Try a longer step in AI settings.' };
      } else if (d.type === 'error') {
        this.ai = { state: 'error', text: d.message };
      }
      this.onChange();
    };
    w.postMessage({ type: 'config', hop: opts.hop ?? 2, margin: opts.margin ?? 0.5 });
    w.postMessage({ type: 'load', base: opts.base });
  }

  configureAi(hop: number) { this.worker?.postMessage({ type: 'config', hop }); this.restartAi(); }

  private restartAi() {
    if (!this.worker || (this.ai.state !== 'ready' && this.ai.state !== 'running')) return;
    this.player?.port.postMessage({ type: 'reset' });
    this.worker.postMessage({ type: this.source ? 'start' : 'stop' });
    this.tap?.port.postMessage({ on: !!this.source });
  }
}
