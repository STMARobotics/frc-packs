// Sounds (synthesized, no files) and short buzzes on phones. Off when the player mutes them in Settings.
import type { Tier } from "../api";
import { prefs } from "./state";

let ac: AudioContext | null | false = null;
function actx(): AudioContext | null {
  if (ac === null) { try { ac = new AudioContext(); } catch { ac = false; } }
  if (ac && ac.state === "suspended") ac.resume();
  return ac || null;
}
const muted = () => prefs.get().muted;

function blip(f: number, d: number, type: OscillatorType = "sine", v = 0.1, when = 0) {
  if (muted()) return;
  const a = actx();
  if (!a) return;
  const t = a.currentTime + when, o = a.createOscillator(), g = a.createGain();
  o.type = type; o.frequency.setValueAtTime(f, t);
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(v, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
  o.connect(g); g.connect(a.destination); o.start(t); o.stop(t + d + 0.02);
}
function noise(d: number, v: number, lo: number) {
  if (muted()) return;
  const a = actx();
  if (!a) return;
  const n = Math.floor(a.sampleRate * d), buf = a.createBuffer(1, n, a.sampleRate), data = buf.getChannelData(0);
  for (let i = 0; i < n; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / n);
  const s = a.createBufferSource(); s.buffer = buf;
  const bp = a.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = lo; bp.Q.value = 0.7;
  const g = a.createGain(); g.gain.value = v;
  s.connect(bp); bp.connect(g); g.connect(a.destination); s.start();
}
const chord = (fs: number[], step: number, type: OscillatorType, v: number) => fs.forEach((f, i) => blip(f, 0.5, type, v, i * step));
/** Chrome refuses (and logs an error) if the page vibrates before the first tap. */
export function buzz(ms: number | number[]) {
  try { if (!muted() && (!navigator.userActivation || navigator.userActivation.hasBeenActive)) navigator.vibrate?.(ms); } catch { /* not supported */ }
  if (!muted()) rumble?.(ms);
}
let rumble: ((ms: number | number[]) => void) | null = null;
/** A controller in use rumbles along with the phone buzzes (pad.ts). */
export const setRumble = (f: typeof rumble) => { rumble = f; };

export const sfx = {
  tick: () => blip(900, 0.03, "square", 0.02),
  pick: () => { blip(520, 0.08, "triangle", 0.08); blip(780, 0.1, "triangle", 0.06, 0.06); },
  rip: (best: Tier) => {
    noise(0.4, 0.5, 2400); blip(180, 0.15, "sawtooth", 0.05);
    if (best === "legendary" || best === "mythic") { chord([392, 523, 659], 0.06, "triangle", 0.07); buzz([30, 30, 60, 30, 90]); }
    else if (best === "rare") { blip(523, 0.2, "triangle", 0.06, 0.05); buzz([20, 30, 50]); }
    else buzz([20, 30, 40]);
  },
  tease: (tier: Tier) => { if (tier === "rare") { blip(1318, 0.12, "sine", 0.03); buzz(12); } else { blip(1318, 0.14, "sine", 0.04); blip(1760, 0.14, "sine", 0.03, 0.09); buzz([15, 40, 15]); } },
  promote: () => { [523, 659, 784, 1046, 1318].forEach((f, i) => blip(f, 0.18, "triangle", 0.06, i * 0.05)); buzz([20, 20, 20, 20, 60]); },
  /** Two heartbeats while the room goes dark before a Mythic flips. */
  heartbeat: () => {
    if (muted()) return;
    const a = actx();
    if (!a) return;
    [0, 0.26, 0.78, 1.04].forEach((d, i) => {
      const t = a.currentTime + d, o = a.createOscillator(), g = a.createGain();
      o.type = "sine"; o.frequency.setValueAtTime(i % 2 ? 58 : 66, t); o.frequency.exponentialRampToValueAtTime(38, t + 0.18);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(i % 2 ? 0.22 : 0.3, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
      o.connect(g); g.connect(a.destination); o.start(t); o.stop(t + 0.25);
    });
    buzz([45, 160, 35, 340, 45, 160, 35]);
  },
  mythic: () => {
    chord([523, 659, 784, 988, 1046, 1318, 1568, 1976], 0.06, "triangle", 0.055);
    blip(131, 1.8, "sine", 0.1); blip(196, 1.6, "sine", 0.06, 0.05);
    [2637, 3136, 2349, 3520, 2794].forEach((f, i) => blip(f, 0.09, "sine", 0.025, 0.55 + i * 0.11));
    buzz([60, 40, 60, 40, 220]);
  },
  riser: () => {
    if (muted()) return;
    const a = actx();
    if (!a) return;
    const t = a.currentTime, o = a.createOscillator(), g = a.createGain();
    o.type = "sine"; o.frequency.setValueAtTime(140, t); o.frequency.exponentialRampToValueAtTime(880, t + 0.45);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.12, t + 0.4); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
    o.connect(g); g.connect(a.destination); o.start(t); o.stop(t + 0.55);
    buzz([10, 30, 10, 30, 10, 30]);
  },
  whoosh: () => noise(0.18, 0.18, 900),
  claim: () => chord([392, 523, 659], 0.08, "triangle", 0.09),
  flip: (tier: Tier) => {
    if (tier === "common") blip(440, 0.09, "triangle", 0.08);
    else if (tier === "uncommon") chord([523, 659], 0.07, "triangle", 0.08);
    else if (tier === "rare") { chord([523, 659, 784], 0.07, "triangle", 0.1); buzz(30); }
    else if (tier === "legendary") { chord([392, 523, 659, 784, 988], 0.08, "square", 0.06); noise(0.6, 0.25, 3000); buzz([30, 40, 60]); }
    else { chord([261, 392, 523, 659, 784, 1046, 1318], 0.09, "square", 0.06); blip(65, 1.2, "sine", 0.3); noise(1.1, 0.3, 1800); buzz([40, 60, 40, 60, 120]); }
  },
};
