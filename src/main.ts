import { Engine, STEM_NAMES, type AiStatus } from './audio/engine';
import { Stage } from './viz/stage';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const engine = new Engine();
const stage = new Stage($<HTMLCanvasElement>('cv'));
const status = (s: string) => { $('status').textContent = s; $('status').hidden = !s; };

// ---------- instrument buttons ----------
$('stems').innerHTML = STEM_NAMES.map((n, i) =>
  `<button type="button" class="stem" data-i="${i}" aria-pressed="true"><i></i><b>${n}</b><span>On</span></button>`).join('');
const stemBtns = [...$('stems').children] as HTMLButtonElement[];
const toggle = (i: number) => engine.setStem(i, !engine.stems[i]);
$('stems').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('.stem'); if (b) toggle(+b.dataset.i!);
});
$('karaoke').onclick = () => [false, true, true, true].forEach((v, i) => engine.setStem(i, v));
$('allon').onclick = () => engine.stems.forEach((_, i) => engine.setStem(i, true));

// ---------- sources ----------
const player = $<HTMLAudioElement>('player');
$('share').onclick = async () => {
  try {
    const { surface } = await engine.shareAudio(); stage.reset();
    status(surface === 'monitor'
      ? "You're sharing your whole computer's sound. Other apps can't be muted from here, so you'll hear the original song as well. For clean karaoke from apps like Spotify, use Audio input with a virtual audio cable."
      : '');
  } catch (e) { status((e as Error).name === 'NotAllowedError' ? 'Sharing was cancelled.' : (e as Error).message); }
};

// ---------- how-to guide ----------
const guide = $<HTMLDialogElement>('guide'), guideVideo = guide.querySelector('video')!;
$('guidebtn').onclick = () => { guide.showModal(); guideVideo.play().catch(() => {}); };
$('guideclose').onclick = () => guide.close();
guide.addEventListener('close', () => guideVideo.pause());
guide.addEventListener('click', (e) => { if (e.target === guide) guide.close(); }); // click outside closes

// ---------- audio input (virtual cable) ----------
const opts = (devs: MediaDeviceInfo[], fallback: string) =>
  devs.map((d, i) => `<option value="${d.deviceId.replace(/"/g, '&quot;')}">${(d.label || `${fallback} ${i + 1}`).replace(/[<&]/g, (c) => (c === '<' ? '&lt;' : '&amp;'))}</option>`).join('');
$('inbtn').onclick = async () => {
  const panel = $('inpanel'), open = panel.hidden;
  panel.hidden = !open; $('inbtn').setAttribute('aria-expanded', String(open));
  if (!open) return;
  try {
    const [ins, outs] = [await engine.listInputs(), await engine.listOutputs()];
    const sel = $<HTMLSelectElement>('insel');
    sel.innerHTML = opts(ins, 'Input');
    const cable = ins.find((d) => /blackhole|cable|loopback|soundflower|virtual/i.test(d.label));
    if (cable) sel.value = cable.deviceId;
    $<HTMLSelectElement>('outsel').innerHTML = opts(outs, 'Output');
    const real = outs.find((d) => d.deviceId === 'default' && !/blackhole|cable/i.test(d.label)) ?? outs.find((d) => !/blackhole|cable|virtual/i.test(d.label));
    if (real) $<HTMLSelectElement>('outsel').value = real.deviceId;
  } catch { status('melostem needs permission to see your audio inputs. Allow it in the address bar and try again.'); }
};
$('ingo').onclick = async () => {
  try {
    await engine.setOutput($<HTMLSelectElement>('outsel').value);
    await engine.useInput($<HTMLSelectElement>('insel').value);
    stage.reset(); status(''); $('inpanel').hidden = true; $('inbtn').setAttribute('aria-expanded', 'false');
  } catch (e) { status((e as Error).message); }
};
$<HTMLInputElement>('file').onchange = async (e) => {
  const f = (e.target as HTMLInputElement).files?.[0]; if (!f) return;
  if (player.src) URL.revokeObjectURL(player.src);
  player.src = URL.createObjectURL(f); player.hidden = false;
  await engine.playFile(player); stage.reset(); status('');
  player.play().catch(() => {});
};
$('stop').onclick = () => { engine.stopSource(); player.pause(); stage.reset(); };

window.addEventListener('keydown', (e: KeyboardEvent) => {
  if ((e.target as HTMLElement).closest('input,select,textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === 'v') $('karaoke').click();
  else if (k.length === 1 && '1234'.includes(k)) toggle(+k - 1);
});

// ---------- AI status in plain words ----------
function describe(a: AiStatus): string {
  if (a.state === 'loading' || a.state === 'error') return a.text;
  if (!engine.hasSource) return 'The AI is ready. Press Share audio or open a file to start.';
  if (a.buffering || a.state === 'ready') return "Starting up: the AI is listening to the first few seconds of music. You'll hear the song in a moment.";
  const parts: string[] = [];
  if (a.delay) parts.push(`You hear the music about ${Math.round(a.delay)} seconds after it actually plays, because the AI needs to listen a few seconds ahead to pull the instruments apart. A video will look a little ahead of its sound.`);
  if (a.speed) {
    if (a.speed >= 1.5) parts.push('Your computer keeps up comfortably.');
    else if (a.speed >= 1.1) parts.push('Your computer is only just keeping up. If the sound breaks up, close other heavy apps or tabs.');
    else parts.push('Your computer is struggling to keep up, so the sound may skip.');
  }
  if (a.slowedDown) parts.push('To keep up, the AI now works on bigger pieces of music at a time, which adds a little more delay.');
  return parts.join(' ');
}

engine.onChange = () => {
  $<HTMLButtonElement>('stop').disabled = !engine.hasSource;
  stemBtns.forEach((b, i) => { b.classList.toggle('off', !engine.stems[i]); b.setAttribute('aria-pressed', String(engine.stems[i])); });
  const a = engine.ai;
  $('aistatus').textContent = describe(a);
  $('aibarwrap').hidden = a.state !== 'loading';
  $('aibar').style.width = `${(a.progress ?? 0) * 100}%`;
};
engine.onChange();

// ---------- render ----------
const bins = new Uint8Array(engine.analyser.frequencyBinCount);
let lastText = 0;
function frame() {
  engine.analyser.getByteFrequencyData(bins);
  stage.frame({ bins, hz: engine.ac.sampleRate / engine.analyser.fftSize, active: engine.hasSource });
  const now = performance.now();
  if (now - lastText > 120) {
    lastText = now;
    stemBtns.forEach((b, i) => {
      const db = 20 * Math.log10(engine.levels[i] + 1e-9);
      (b.firstChild as HTMLElement).style.width = `${engine.hasSource ? Math.max(0, Math.min(100, (db + 60) * 1.7)) : 0}%`;
      b.querySelector('span')!.textContent = engine.stems[i] ? 'On' : 'Muted';
    });
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
