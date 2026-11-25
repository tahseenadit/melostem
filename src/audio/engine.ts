/**
 * Audio engine: one input (a shared tab / whole-system audio, or a local file) goes to the AI
 * worker; the separated stems come back to the stem player, which mixes them with live
 * per-instrument switches and feeds the speakers and the visualiser.
 *
 *   input ─ tap → AI worker → stem player ─ out ─ analyser ─ speakers
 */
import tapUrl from './tap-processor.ts?worker&url';
import playerUrl from './stem-player-processor.ts?worker&url';

/** UI stem order. */
export const STEM_NAMES = ['Vocals', 'Drums', 'Bass', 'Other'] as const;
/** UI index -> HT-Demucs index (drums, bass, other, vocals). */
const UI_TO_AI = [3, 0, 1, 2];
/** Separation step in seconds; longer steps need less GPU power but add delay. */
const STEPS = [2, 4, 6];

export interface AiStatus {
  state: 'loading' | 'ready' | 'running' | 'error';
  text: string;
  progress?: number;
  /** how many times faster than the music the AI separates */
  speed?: number;
  /** seconds between the original sound and what you hear */
  delay?: number;
  buffering?: boolean;
  slowedDown?: boolean;
}

export class Engine {
  readonly ac = new AudioContext({ sampleRate: 44100, latencyHint: 'playback' });
  readonly input = new GainNode(this.ac, { channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers' });
  readonly out = new GainNode(this.ac);
  readonly analyser = new AnalyserNode(this.ac, { fftSize: 2048, smoothingTimeConstant: 0.25 });
  stems = [true, true, true, true];
  levels = [0, 0, 0, 0];
  ai: AiStatus = { state: 'loading', text: 'Getting the AI ready…', progress: 0 };
  onChange: () => void = () => {};

  private step = 0;
  private slowCount = 0;
  private tap?: AudioWorkletNode;
  private player?: AudioWorkletNode;
  private worker?: Worker;
  private source?: AudioNode;
  private stream?: MediaStream;
  private ready: Promise<void>;

  constructor() {
    this.out.connect(this.analyser);
    this.out.connect(this.ac.destination);
    this.ready = this.init();
  }

  private async init() {
    await Promise.all([tapUrl, playerUrl].map((u) => this.ac.audioWorklet.addModule(u)));
    this.tap = new AudioWorkletNode(this.ac, 'melostem-tap', { numberOfOutputs: 0 });
    this.input.connect(this.tap);
    this.player = new AudioWorkletNode(this.ac, 'melostem-stem-player', { numberOfInputs: 0, outputChannelCount: [2] });
    this.player.connect(this.out);
    this.player.port.onmessage = (e) => {
      if (e.data.type !== 'level') return;
      this.levels = UI_TO_AI.map((a) => e.data.rms[a]);
      const buffering = !e.data.playing && !!this.source;
      if (buffering !== this.ai.buffering) { this.ai = { ...this.ai, buffering }; this.onChange(); }
    };
    this.sendStems();
    this.loadAi();
  }

  // ---------- sources ----------
  async shareAudio(): Promise<{ surface: string }> {
    await this.ready; await this.ac.resume();
    const stream = await navigator.mediaDevices.getDisplayMedia({
      // We only want the sound. Keep the picture tiny and slow so screen capture doesn't
      // compete with the AI for the graphics card.
      video: { frameRate: 1, width: { max: 320 }, height: { max: 240 } },
      audio: {
        suppressLocalAudioPlayback: true, // a shared tab goes quiet; only our processed sound plays
        restrictOwnAudio: true, // whole-screen sound must not include our own output (feedback loop)
        echoCancellation: false, noiseSuppression: false, autoGainControl: false,
      } as MediaTrackConstraints,
      systemAudio: 'include',
      surfaceSwitching: 'include',
      selfBrowserSurface: 'exclude',
    } as DisplayMediaStreamOptions);
    const surface = (stream.getVideoTracks()[0]?.getSettings() as { displaySurface?: string }).displaySurface ?? 'browser';
    if (!stream.getAudioTracks().length) {
      stream.getTracks().forEach((t) => t.stop());
      throw new Error(surface === 'window'
        ? 'Chrome cannot capture sound from a single window. Share the tab instead, or for apps like Spotify or VLC use "Audio input" with a virtual audio cable.'
        : surface === 'monitor'
          ? 'No sound came through. Tick "Share system audio" in the picker. On a Mac this needs macOS 14.2 or newer; otherwise use "Audio input" with a virtual audio cable.'
          : 'No sound came through. Tick "Share tab audio" in the picker.');
    }
    stream.getVideoTracks().forEach((t) => (t.enabled = false));
    this.setSource(this.ac.createMediaStreamSource(stream), stream);
    stream.getAudioTracks()[0].addEventListener('ended', () => this.stopSource());
    return { surface };
  }

  /** Audio inputs (asks for microphone permission once so device names are visible). */
  async listInputs(): Promise<MediaDeviceInfo[]> {
    let devs = await navigator.mediaDevices.enumerateDevices();
    if (!devs.some((d) => d.kind === 'audioinput' && d.label)) {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
      devs = await navigator.mediaDevices.enumerateDevices();
    }
    return devs.filter((d) => d.kind === 'audioinput');
  }

  async listOutputs(): Promise<MediaDeviceInfo[]> {
    return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audiooutput');
  }

  /** Listen to an audio input, e.g. a virtual cable (BlackHole, VB-Cable) that a music app plays into. */
  async useInput(deviceId: string): Promise<void> {
    await this.ready; await this.ac.resume();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: { exact: deviceId }, channelCount: 2, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    this.setSource(this.ac.createMediaStreamSource(stream), stream);
  }

  /** Play the result on a specific output (needed when the system output is a virtual cable). */
  async setOutput(deviceId: string): Promise<void> {
    const ac = this.ac as AudioContext & { setSinkId?: (id: string) => Promise<void> };
    if (ac.setSinkId) await ac.setSinkId(deviceId);
  }

  async playFile(el: HTMLMediaElement): Promise<void> {
    await this.ready; await this.ac.resume();
    const anyEl = el as HTMLMediaElement & { _melostem?: MediaElementAudioSourceNode };
    anyEl._melostem ??= this.ac.createMediaElementSource(el);
    this.setSource(anyEl._melostem);
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
    this.restartAi();
    this.onChange();
  }

  get hasSource() { return !!this.source; }

  // ---------- instruments ----------
  setStem(i: number, on: boolean) { this.stems[i] = on; this.sendStems(); this.onChange(); }

  private sendStems() {
    const g = [0, 0, 0, 0];
    this.stems.forEach((v, ui) => (g[UI_TO_AI[ui]] = v ? 1 : 0));
    this.player?.port.postMessage({ gains: g });
  }

  // ---------- AI ----------
  private loadAi() {
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
          ? { state: 'loading', text: d.cached ? 'Loading the AI from your browser…' : `Downloading the AI (first time only): ${(d.done / 1e6).toFixed(0)} of about ${(d.total / 1e6).toFixed(0)} MB`, progress: Math.min(0.95, d.done / d.total) }
          : { state: 'loading', text: 'Preparing the AI on your graphics card…', progress: 0.95 + 0.05 * (d.done / d.total) };
      } else if (d.type === 'ready') {
        this.ai = { state: 'ready', text: 'AI ready' };
        this.restartAi();
      } else if (d.type === 'stats') {
        this.ai = { ...this.ai, state: 'running', speed: d.realtime, delay: d.latency };
        this.adaptStep(d.realtime);
      } else if (d.type === 'skip') {
        this.adaptStep(0);
      } else if (d.type === 'error') {
        this.ai = { state: 'error', text: d.message };
      }
      this.onChange();
    };
    w.postMessage({ type: 'config', hop: STEPS[this.step], margin: 0.5 });
    w.postMessage({ type: 'load' });
  }

  /**
   * If the graphics card can't keep up, separate in longer steps (more delay, less work).
   * Each step must finish faster than the music plays.
   */
  private adaptStep(speed: number) {
    this.slowCount = speed < 1.1 ? this.slowCount + 1 : 0;
    if (this.slowCount >= 2 && this.step < STEPS.length - 1) {
      this.step++; this.slowCount = 0;
      this.ai = { ...this.ai, slowedDown: true };
      this.worker?.postMessage({ type: 'config', hop: STEPS[this.step] });
      this.restartAi();
    }
  }

  private restartAi() {
    if (!this.worker || this.ai.state === 'loading' || this.ai.state === 'error') return;
    this.player?.port.postMessage({ type: 'reset' });
    this.worker.postMessage({ type: this.source ? 'start' : 'stop' });
    this.tap?.port.postMessage({ on: !!this.source });
  }
}
