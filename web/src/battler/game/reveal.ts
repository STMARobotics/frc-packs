// The round reveal as a timeline: the other player's robots turn over lane by lane, then Lore, then Auto (five quick
// ticks), Tele and End robot by robot into the tug-of-war bar, the round verdict, and one RP die per robot. The timeline
// only changes this state; the arena draws it, so the cards on screen stay the same elements throughout.
import { useEffect, useRef, useState } from "preact/hooks";
import { preload } from "../store";
import { sfx } from "../sfx";
import type { GameView, RoundLog } from "../types";
import { robotOf } from "./state";

export interface Reveal {
  /** Their robot in each lane: 0 face down, 1 turning over now, 2 face up. */
  open: [number, number, number];
  parts: boolean;
  lore: boolean;
  /** Points shown so far per robot and phase (null: not scored yet). */
  pts: Record<number, [number | null, number | null, number | null]>;
  /** Phases done per robot, so they can be colored up or down against the robot's base. */
  graded: Record<number, [boolean, boolean, boolean]>;
  totals: [number, number]; // [me, them]
  dice: Record<number, { s: "roll" | "hit" | "miss"; t: string }>;
  banner: { text: string; n: number } | null;
  auto: number; // the Auto tick showing (1-5), or 0
  verdict: boolean;
  rp: [number, number]; // RP this round shown so far [me, them]
  floats: { id: number; inst: number; text: string; who: "me" | "op" }[];
  shake: number;
  done: boolean;
}

const animated = new Set<string>();
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let floatN = 0;

function blank(log: RoundLog): Reveal {
  const pts: Reveal["pts"] = {}, graded: Reveal["graded"] = {};
  for (const sc of log.result.robots) { pts[sc.inst] = [null, null, null]; graded[sc.inst] = [false, false, false]; }
  return { open: [0, 0, 0], parts: false, lore: false, pts, graded, totals: [0, 0], dice: {}, banner: null, auto: 0, verdict: false, rp: [0, 0], floats: [], shake: 0, done: false };
}

export function finished(log: RoundLog, side: number): Reveal {
  const r = log.result, op = 1 - side;
  const v = blank(log);
  v.open = [2, 2, 2]; v.parts = true; v.lore = true; v.verdict = true; v.done = true;
  for (const sc of r.robots) {
    v.pts[sc.inst] = [...sc.points];
    v.graded[sc.inst] = [true, true, true];
    v.dice[sc.inst] = sc.rp_hit ? { s: "hit", t: "+1" } : { s: "miss", t: String(sc.rp_roll) };
  }
  v.totals = [r.totals[side], r.totals[op]];
  v.rp = [r.match_rp[side] + r.bonus_rp[side], r.match_rp[op] + r.bonus_rp[op]];
  return v;
}

/** Splits an Auto score into five ticks: each about a fifth, up to 10% smaller or larger, always summing to the total. The
    same game always gives the same ticks (seeded from the game's fairness code), so a replay looks identical. */
function autoTicks(total: number, seed: string): number[] {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) { h = Math.imul(h ^ seed.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
  const rnd = () => { h = Math.imul(h ^ (h >>> 16), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); h ^= h >>> 16; return (h >>> 0) / 4294967296; };
  const w = Array.from({ length: 5 }, () => 0.9 + rnd() * 0.2);
  const sum = w.reduce((a, b) => a + b, 0);
  const raw = w.map((x) => (total * x) / sum);
  const out = raw.map(Math.floor);
  let rest = total - out.reduce((a, b) => a + b, 0);
  const order = raw.map((x, i) => [x - Math.floor(x), i] as const).sort((p, q) => q[0] - p[0]);
  for (let i = 0; rest > 0; i++, rest--) out[order[i % 5][1]]++;
  return out;
}

/** Runs the reveal for `log` once per game and round; afterwards (or after Skip) it shows the finished round. */
export function useReveal(g: GameView, log: RoundLog | null): [Reveal | null, () => void] {
  const side = g.me!.side;
  const key = log ? `${g.id}:${log.round}` : "";
  const reduce = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const [rv, setRv] = useState<Reveal | null>(() => (log ? (animated.has(key) || reduce ? finished(log, side) : blank(log)) : null));
  const token = useRef(0);

  const skip = () => { token.current++; if (log) { animated.add(key); setRv(finished(log, side)); } };

  useEffect(() => {
    if (!log) { setRv(null); return; }
    if (animated.has(key) || reduce) { setRv(finished(log, side)); return; }
    animated.add(key);
    const my = ++token.current;
    const alive = () => my === token.current;
    let v = blank(log);
    setRv(v);
    const upd = (f: (v: Reveal) => void) => { if (!alive()) return; v = { ...v, pts: { ...v.pts }, graded: { ...v.graded }, dice: { ...v.dice } }; f(v); setRv(v); };
    const float = (inst: number, text: string, who: "me" | "op") => {
      const id = ++floatN;
      upd((x) => { x.floats = [...x.floats, { id, inst, text, who }]; });
      setTimeout(() => upd((x) => { x.floats = x.floats.filter((f) => f.id !== id); }), 900);
    };
    let bn = 0;
    const banner = async (text: string, ms: number) => { upd((x) => { x.banner = { text, n: ++bn }; }); await wait(ms); };

    (async () => {
      const r = log.result, op = 1 - side;
      const who = (s: number) => (s === side ? "me" : "op") as "me" | "op";
      // Their photos have to be ready before the cards turn over, or a face would come up blank.
      const teams = log.stations[op].map((i) => robotOf(g, i)?.team).filter((t): t is number => !!t);
      await Promise.all([preload(teams, 1200), banner("REVEAL", 520)]);
      for (let k = 0; k < 3; k++) {
        if (!alive()) return;
        upd((x) => { x.open = x.open.map((o, j) => (j === k ? 1 : o)) as Reveal["open"]; });
        sfx.flip();
        await wait(300);
      }
      upd((x) => { x.parts = true; x.open = [2, 2, 2]; });
      if (log.lore[0] !== null || log.lore[1] !== null) { await banner("LORE", 420); upd((x) => { x.lore = true; }); sfx.flip(); await wait(450); }
      else upd((x) => { x.lore = true; });

      // Auto: five ticks.
      if (!alive()) return;
      await banner("AUTO", 450);
      const ticks = new Map(r.robots.map((sc) => [sc.inst, autoTicks(sc.points[0], `${g.seed_hash}:${log.round}:${sc.inst}`)]));
      for (let t = 0; t < 5; t++) {
        if (!alive()) return;
        upd((x) => {
          x.auto = t + 1;
          for (const sc of r.robots) {
            const add = ticks.get(sc.inst)![t];
            x.pts[sc.inst] = [(x.pts[sc.inst][0] ?? 0) + add, null, null];
            x.totals = sc.side === side ? [x.totals[0] + add, x.totals[1]] : [x.totals[0], x.totals[1] + add];
          }
        });
        for (const sc of r.robots) { const add = ticks.get(sc.inst)![t]; if (add > 0) float(sc.inst, `+${add}`, who(sc.side)); }
        sfx.tick(t);
        await wait(650);
      }
      upd((x) => { x.auto = 0; for (const sc of r.robots) x.graded[sc.inst] = [true, false, false]; });
      await wait(200);

      // Tele and End, lane by lane, them then you.
      for (const k of [1, 2] as const) {
        if (!alive()) return;
        await banner(k === 1 ? "TELE" : "END", 420);
        for (let lane = 0; lane < 3; lane++) {
          for (const s of [op, side]) {
            if (!alive()) return;
            const inst = log.stations[s][lane];
            const sc = r.robots.find((x) => x.inst === inst)!;
            const big = sc.points[k] >= sc.base[k] * 1.5 && sc.points[k] - sc.base[k] >= 10;
            upd((x) => {
              const p = [...x.pts[inst]] as Reveal["pts"][number]; p[k] = sc.points[k]; x.pts[inst] = p;
              const gr = [...x.graded[inst]] as Reveal["graded"][number]; gr[k] = true; x.graded[inst] = gr;
              x.totals = s === side ? [x.totals[0] + sc.points[k], x.totals[1]] : [x.totals[0], x.totals[1] + sc.points[k]];
              if (big) x.shake++;
            });
            float(inst, `+${sc.points[k]}`, who(s));
            if (big) sfx.boom(); else sfx.tick(lane + k);
            await wait(170);
          }
        }
        await wait(220);
      }
      // The round, then one RP die per robot.
      if (!alive()) return;
      const won = r.winner === null ? 0 : r.winner === side ? 1 : -1;
      upd((x) => { x.verdict = true; x.rp = [r.match_rp[side], r.match_rp[op]]; });
      (won > 0 ? sfx.win : won < 0 ? sfx.lose : () => sfx.tick(4))();
      await wait(1000);
      await banner("RP ROLLS", 420);
      for (const s of [side, op]) {
        for (const inst of log.stations[s]) {
          if (!alive()) return;
          const sc = r.robots.find((x) => x.inst === inst)!;
          for (let i = 0; i < 5; i++) { upd((x) => { x.dice[inst] = { s: "roll", t: String(Math.floor(Math.random() * 100)) }; }); sfx.dice(); await wait(55); }
          upd((x) => {
            x.dice[inst] = sc.rp_hit ? { s: "hit", t: "+1" } : { s: "miss", t: String(sc.rp_roll) };
            if (sc.rp_hit) x.rp = s === side ? [x.rp[0] + 1, x.rp[1]] : [x.rp[0], x.rp[1] + 1];
          });
          (sc.rp_hit ? sfx.hit : sfx.miss)();
          if (sc.rp_hit) float(inst, "+1 RP", who(s));
          await wait(220);
        }
      }
      // The finished round becomes the state the last floating numbers clear from.
      if (alive()) { v = { ...finished(log, side), floats: v.floats }; setRv(v); }
    })();
    return () => { token.current++; };
  }, [key]);

  return [rv, skip];
}
