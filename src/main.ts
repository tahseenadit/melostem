import { Engine, STEM_NAMES, type Mode } from './audio/engine';
import { Stage } from './viz/stage';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const engine = new Engine();
const stage = new Stage($<HTMLCanvasElement>('cv'));
const status = (s: string) => ($('status').textContent = s);

// ---------- instrument buttons ----------
$('stems').innerHTML = STEM_NAMES.map((n, i) =>
  `<button type="button" class="stem" data-i="${i}" aria-pressed="true"><i></i><b>${n}</b><span>On</span></button>`).join('');
const stemBtns = [...$('stems').children] as HTMLButtonElement[];
const toggle = (i: number) => engine.setStem(i, !engine.stems[i]);
$('stems').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('.stem'); if (b) toggle(+b.dataset.i!);
});
$('karaoke').onclick = () => { [false, true, true, true].forEach((v, i) => engine.setStem(i, v)); if (engine.mode === 'original') setMode('instant'); };
$('allon').onclick = () => engine.stems.forEach((_, i) => engine.setStem(i, true));

// ---------- modes ----------
const radios = [...document.querySelectorAll<HTMLInputElement>('input[name=mode]')];
function setMode(m: Mode) {
  engine.setMode(m);
  radios.forEach((r) => (r.checked = r.value === m));
  if (m === 'ai' && engine.ai.state === 'idle') void engine.loadAi({ hop: +$<HTMLSelectElement>('hop').value });
}
radios.forEach((r) => (r.onchange = () => setMode(r.value as Mode)));

// ---------- sources ----------
const player = $<HTMLAudioElement>('player');
$('share').onclick = async () => {
  try { await engine.shareAudio(); stage.reset(); status('Listening to the shared audio. Play your song.'); }
  catch (e) { status((e as Error).name === 'NotAllowedError' ? 'Sharing was cancelled.' : (e as Error).message); }
};
$<HTMLInputElement>('file').onchange = async (e) => {
  const f = (e.target as HTMLInputElement).files?.[0]; if (!f) return;
  if (player.src) URL.revokeObjectURL(player.src);
  player.src = URL.createObjectURL(f); player.hidden = false;
  await engine.playFile(player); stage.reset();
  player.play().catch(() => {});
  status(`Playing ${f.name}.`);
};
$('stop').onclick = () => { engine.stopSource(); player.pause(); stage.reset(); status('Stopped.'); };

// ---------- settings ----------
$<HTMLSelectElement>('vmode').onchange = (e) => engine.setInstantOptions({ vmode: +(e.target as HTMLSelectElement).value });
$<HTMLSelectElement>('passes').onchange = (e) => engine.setInstantOptions({ passes: +(e.target as HTMLSelectElement).value });
$<HTMLSelectElement>('hop').onchange = (e) => engine.configureAi(+(e.target as HTMLSelectElement).value);
$('loadai').onclick = () => void engine.loadAi({ hop: +$<HTMLSelectElement>('hop').value });

window.addEventListener('keydown', (e: KeyboardEvent) => {
  if ((e.target as HTMLElement).closest('input,select,textarea') || e.metaKey || e.ctrlKey) return;
  const k = e.key.toLowerCase();
  if (k === 'v') $('karaoke').click();
  else if ('1234'.includes(k) && k) toggle(+k - 1);
  else if (k === 'o') setMode('original'); else if (k === 'i') setMode('instant'); else if (k === 'a') setMode('ai');
});

// ---------- render ----------
const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const noteName = (f: number) => { const m = Math.round(12 * Math.log2(f / 440)) + 69; return NOTES[m % 12] + (Math.floor(m / 12) - 1); };

engine.onChange = () => {
  $<HTMLButtonElement>('stop').disabled = !engine.hasSource;
  stemBtns.forEach((b, i) => { b.classList.toggle('off', !engine.stems[i]); b.setAttribute('aria-pressed', String(engine.stems[i])); });
  const a = engine.ai;
  const extra = a.state === 'running' && a.realtime ? ` · ${a.realtime.toFixed(1)}× real time · sound is about ${a.latency!.toFixed(1)} s behind` : '';
  $('aistatus').textContent = a.text + extra;
  $('aibar').style.width = `${(a.state === 'loading' ? a.progress ?? 0 : a.state === 'idle' || a.state === 'error' ? 0 : 1) * 100}%`;
  $<HTMLButtonElement>('loadai').disabled = a.state !== 'idle' && a.state !== 'error';
  $('loadai').textContent = a.state === 'idle' || a.state === 'error' ? 'Load the AI model' : a.state === 'loading' ? 'Loading…' : 'AI loaded';
};
engine.onChange();

// voice level for the face: adaptive range so quiet and loud songs both move the lips
let vmin = 0, vmax = 1, voice = 0;
const bins = new Uint8Array(engine.analyser.frequencyBinCount);
let lastText = 0;
function frame() {
  engine.analyser.getByteFrequencyData(bins);
  const ai = engine.mode === 'ai';
  const lv = ai ? engine.aiLevelsUi.map((r) => 20 * Math.log10(r + 1e-9) + 100) : engine.instantLevels;
  const v = engine.stems[0] || !ai ? lv[0] : 0;
  vmin = v < vmin ? vmin + (v - vmin) * 0.5 : vmin + 0.05; vmax = v > vmax ? vmax + (v - vmax) * 0.5 : vmax - 0.03; if (vmax < vmin + 12) vmax = vmin + 12;
  const tgt = Math.min(1, Math.max(0, (v - vmin - 3) / (vmax - vmin - 3))) ** 1.4;
  voice += (tgt - voice) * (tgt > voice ? 0.5 : 0.2);
  stage.frame({ bins, hz: engine.ac.sampleRate / engine.analyser.fftSize, voice, active: engine.hasSource });
  const now = performance.now();
  if (now - lastText > 120) {
    lastText = now;
    stemBtns.forEach((b, i) => {
      const w = engine.hasSource ? Math.max(0, Math.min(100, ai ? (lv[i] - 40) * 1.7 : (lv[i] - 5) * 1.7)) : 0;
      (b.firstChild as HTMLElement).style.width = `${w}%`;
      const st = engine.stems[i] ? 'On' : 'Muted';
      b.querySelector('span')!.textContent = i === 0 && !ai && engine.mode === 'instant' && engine.pitch > 0 && engine.hasSource ? `${st} · singing ${noteName(engine.pitch)}` : st;
    });
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
