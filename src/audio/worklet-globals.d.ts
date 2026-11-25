// Globals available inside AudioWorkletGlobalScope (not part of TypeScript's DOM lib).
declare const sampleRate: number;
declare const currentFrame: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
}
declare function registerProcessor(name: string, ctor: new (options?: any) => AudioWorkletProcessor): void;
