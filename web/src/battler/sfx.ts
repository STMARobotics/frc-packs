// Sounds, synthesized (no files), and a short buzz on phones for the big moments.
import { pref } from "./store";

let audio: AudioContext | null = null;
export const soundOff = () => pref("bt-mute");

function tone(freq: number, ms: number, type: OscillatorType = "sine", gain = 0.06, slide = 0) {
  if (soundOff()) return;
  try {
    audio = audio ?? new AudioContext();
    if (audio.state === "suspended") audio.resume();
    const t = audio.currentTime, o = audio.createOscillator(), g = audio.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(40, freq + slide), t + ms / 1000);
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
    o.connect(g).connect(audio.destination);
    o.start(t);
    o.stop(t + ms / 1000 + 0.02);
  } catch { /* no audio */ }
}

function buzz(ms: number) {
  if (soundOff()) return;
  try { if (!navigator.userActivation || navigator.userActivation.hasBeenActive) navigator.vibrate?.(ms); } catch { /* not supported */ }
}

export const sfx = {
  pick: () => tone(660, 70, "triangle", 0.05),
  place: () => { tone(320, 90, "square", 0.04, -120); buzz(12); },
  flip: () => tone(900, 60, "triangle", 0.04, 400),
  lock: () => { tone(440, 90, "triangle"); setTimeout(() => tone(660, 120, "triangle"), 90); buzz(25); },
  tick: (k: number) => tone(500 + k * 40, 45, "square", 0.025),
  boom: () => { tone(120, 260, "sawtooth", 0.07, -60); buzz(60); },
  win: () => [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => tone(f, 160, "triangle", 0.06), i * 110)),
  lose: () => [392, 330, 262].forEach((f, i) => setTimeout(() => tone(f, 200, "sine", 0.05), i * 140)),
  dice: () => tone(200 + Math.random() * 300, 30, "square", 0.02),
  hit: () => { tone(1046, 140, "triangle", 0.06); buzz(20); },
  miss: () => tone(180, 120, "sine", 0.04),
  emote: () => tone(880, 80, "sine", 0.04, 200),
};
