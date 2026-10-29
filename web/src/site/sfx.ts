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
/** A burst of noise that fades out, or (`back`) fades in and cuts off, like the same sound played backwards. */
function noise(d: number, v: number, lo: number, back = false) {
  if (muted()) return;
  const a = actx();
  if (!a) return;
  const n = Math.floor(a.sampleRate * d), buf = a.createBuffer(1, n, a.sampleRate), data = buf.getChannelData(0);
  for (let i = 0; i < n; i++) data[i] = (Math.random() * 2 - 1) * (back ? i / n : 1 - i / n);
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

/** The pack straining while you tear it: a hum that rises in pitch and volume with `c` (0 to 1). */
let hum: { o: OscillatorNode; o2: OscillatorNode; g: GainNode; f: BiquadFilterNode } | null = null;
function humSet(c: number) {
  if (muted()) return humStop();
  const a = actx();
  if (!a) return;
  if (!hum) {
    const o = a.createOscillator(), o2 = a.createOscillator(), g = a.createGain(), f = a.createBiquadFilter();
    o.type = "sawtooth"; o2.type = "square"; f.type = "lowpass"; f.Q.value = 6;
    g.gain.value = 0.0001;
    o.connect(f); o2.connect(f); f.connect(g); g.connect(a.destination);
    o.start(); o2.start();
    hum = { o, o2, g, f };
  }
  const t = a.currentTime;
  hum.o.frequency.setTargetAtTime(55 + c * c * 170, t, 0.04);
  hum.o2.frequency.setTargetAtTime(56.5 + c * c * 171, t, 0.04);
  hum.f.frequency.setTargetAtTime(300 + c * 2200, t, 0.05);
  hum.g.gain.setTargetAtTime(0.015 + c * c * 0.09, t, 0.05);
}
function humStop() {
  const a = actx();
  if (!hum || !a) return;
  const h = hum, t = a.currentTime;
  hum = null;
  h.g.gain.setTargetAtTime(0.0001, t, 0.03);
  h.o.stop(t + 0.2); h.o2.stop(t + 0.2);
}

export const sfx = {
  /** Something with weight landing in your hands (`v` 0 to 1 for how heavy). */
  thud: (v = 1) => { blip(70, 0.25, "sine", 0.32 * v); blip(140, 0.08, "triangle", 0.08 * v); noise(0.12, 0.22 * v, 220); buzz(Math.round(10 + 20 * v)); },
  /** The pack straining as it's torn: a hum that climbs with `c`; stop it when you let go. */
  strain: humSet,
  strainStop: humStop,
  /** The tear catching another notch, sharper the further it's gone. */
  tear: (t: number) => { noise(0.045, 0.16 + t * 0.2, 1800 + t * 3200); blip(260 + t * 420, 0.03, "square", 0.02 + t * 0.02); },
  /** The tear closing back up a notch: the same tick played backwards, falling instead of rising. */
  untear: (t: number) => { noise(0.06, 0.14 + t * 0.16, 1500 + t * 2600, true); blip(240 + t * 360, 0.035, "square", 0.015 + t * 0.015); },
  /** A card snapping into place. */
  snap: (v = 1) => { blip(1700, 0.03, "square", 0.04 * v); noise(0.035, 0.16 * v, 5200); buzz(Math.round(5 + 8 * v)); },
  /** Let go part way: it settles back. */
  settle: () => { blip(120, 0.12, "triangle", 0.1); noise(0.07, 0.12, 380); buzz(12); },
  /** It bursts open: a deep hit, a crack, and the best card's chord on top. */
  burst: (best: Tier) => {
    humStop();
    blip(48, 0.6, "sine", 0.45); blip(96, 0.3, "triangle", 0.15); noise(0.55, 0.6, 1300); noise(0.25, 0.4, 4000);
    if (best === "legendary" || best === "mythic") chord([392, 523, 659, 784], 0.05, "triangle", 0.08);
    else if (best === "rare") chord([523, 659], 0.05, "triangle", 0.07);
    buzz(best === "mythic" || best === "legendary" ? [90, 40, 140] : [70, 30, 60]);
  },
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
  /** A Mythic is an event: a sub-bass drop under a hard hit, a rising fanfare that lands on a big held chord ringing
      out through an echo, and sparkles falling over it; the strongest buzz and rumble in the game. */
  mythic: () => {
    buzz([90, 40, 90, 40, 220, 60, 340]);
    if (muted()) return;
    const a = actx();
    if (!a) return;
    const t0 = a.currentTime, bus = a.createGain(), echo = a.createDelay(1), fb = a.createGain(), tone = a.createBiquadFilter();
    echo.delayTime.value = 0.19; fb.gain.value = 0.34; tone.type = "lowpass"; tone.frequency.value = 2800;
    bus.connect(a.destination); bus.connect(echo); echo.connect(tone); tone.connect(fb); fb.connect(echo); tone.connect(a.destination);
    const note = (f: number, at: number, d: number, type: OscillatorType, v: number, to?: number) => {
      const o = a.createOscillator(), g = a.createGain(), t = t0 + at;
      o.type = type; o.frequency.setValueAtTime(f, t); if (to) o.frequency.exponentialRampToValueAtTime(to, t + d);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(v, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
      o.connect(g); g.connect(bus); o.start(t); o.stop(t + d + 0.05);
    };
    note(110, 0, 1.5, "sine", 0.6, 26); // the drop
    note(55, 0, 0.9, "triangle", 0.25, 30);
    noise(0.6, 0.55, 900); noise(0.3, 0.35, 4200);
    [523, 784, 1047, 1319].forEach((f, i) => note(f, 0.06 + i * 0.08, 0.32, "sawtooth", 0.05)); // the sting
    [523, 659, 784, 1047, 1319, 1568].forEach((f) => { note(f, 0.38, 2.8, "triangle", 0.045); note(f * 1.005, 0.38, 2.8, "sawtooth", 0.011); });
    for (let i = 0; i < 14; i++) note(2093 * Math.pow(2, Math.random() * 1.2), 0.7 + i * 0.12, 0.3, "sine", 0.028);
  },
  /** Each letter of MYTHIC landing. */
  stamp: (i: number) => { blip(170 + i * 34, 0.14, "square", 0.08); blip(85 + i * 17, 0.18, "sine", 0.18); noise(0.08, 0.3, 700 + i * 260); buzz(20); },
  /** A swell played backwards into the flip of a Mythic, `s` seconds long. */
  swell: (s: number) => {
    noise(s, 0.32, 2600, true);
    if (muted()) return;
    const a = actx();
    if (!a) return;
    const t = a.currentTime, o = a.createOscillator(), g = a.createGain();
    o.type = "sawtooth"; o.frequency.setValueAtTime(90, t); o.frequency.exponentialRampToValueAtTime(520, t + s);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.07, t + s * 0.95); g.gain.exponentialRampToValueAtTime(0.0001, t + s + 0.03);
    o.connect(g); g.connect(a.destination); o.start(t); o.stop(t + s + 0.08);
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
