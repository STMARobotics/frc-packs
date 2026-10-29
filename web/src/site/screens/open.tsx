// Opening packs. On the Open tab: your packs (standard, boosted and Mythic stacks, each with its count). Tap one and,
// over the tabs: the wheel of 10 (a setting), the pack in your hand (turn it over for the odds, swipe across the top to
// tear it; the light leaking out is the best card's color), the five cards one at a time (Rare and better wait face
// down until you flip them, and a Mythic gets a moment of its own), and the summary. The server decides everything; a
// pack torn but not finished is picked up again from the Open tab. Where WebGL works (and motion isn't reduced), the
// pack in your hand and then the cards are drawn in 3D by gl/pack.ts, loaded when you first tap a pack; until then,
// and everywhere else, the DOM pack and cards do it all.
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { api, type Opening, type State, type Tier } from "../../api";
import { useStore } from "../../lib/store";
import { BY_NUM, DIV_TEAMS, DIVS, PACK, RECIPE, TEAMS, TIERS } from "../data";
import { applyState, fail, inv, packOf, prefs, sets, st, stash, sync, toast } from "../state";
import { back, Card, cx, Face, plural, push } from "../ui";
import { buzz, sfx } from "../sfx";
import { openCard } from "./cardview";
import { usePad } from "../pad";
import { createRip, type Rip } from "../rip";
import type { PackGL } from "../gl/pack";

const RM = matchMedia("(prefers-reduced-motion: reduce)").matches;
/** The WebGL pack's code (and Three.js with it), fetched the first time a pack is tapped. */
let glCode: Promise<typeof import("../gl/pack")> | null = null;
const loadGL = () => (RM ? null : (glCode ??= import("../gl/pack").catch(() => (glCode = null) as never)));
const N = 10; // packs on the wheel

export type Kind = "std" | "gold" | "myth" | "test";
const NAME: Record<Kind, string> = { std: "Standard", gold: "Boosted", myth: "Mythic", test: "Test" };
/** Sealed packs of each kind (a Mythic pack is a boosted pack with three Mythics in it). */
function counts(): Record<Kind, number> {
  const p = packOf(st.get()!);
  return { std: Math.max(0, p.sealed - p.boosted), gold: Math.max(0, p.boosted - p.mythic), myth: p.mythic, test: Infinity };
}
const flags = (k: Kind) => [k === "gold" || k === "myth", k === "myth"] as const;
/** The stack being opened, kept between visits. */
let kind: Kind = "std";

interface Deal { num: number; tier: Tier; serial: number; isNew: boolean; copy: number; inGame?: number; test?: boolean }
interface Result { opening: Opening & { cards: Deal[] }; state: State | null; streakReward: boolean }
const faceDown = (t: Tier) => t !== "common" && t !== "uncommon";
const usable = (o: Opening | null | undefined): o is Opening => !!o && o.pack === PACK && o.cards.length === 5 && o.cards.every((c) => BY_NUM.has(c.num));
/** Confetti per rarity: how many pieces, how hard. */
const BURST: Record<Tier, [number, number]> = { common: [10, 4], uncommon: [26, 6], rare: [60, 8], legendary: [140, 11], mythic: [260, 13] };

/** Downloads and decodes these robots' photos (or gives up after `ms`), so the cards don't stall the tear. */
const photos = new Map<number, Promise<unknown>>();
function photosReady(nums: number[], ms: number) {
  for (const n of nums) {
    if (photos.has(n) || !BY_NUM.get(n)?.photo) continue;
    const im = new Image();
    im.decoding = "async";
    im.src = `/photos/${n}.webp`;
    photos.set(n, im.decode().catch(() => {}));
  }
  return Promise.race([Promise.all(nums.map((n) => photos.get(n))), new Promise((r) => setTimeout(r, ms))]);
}

/** Plays `el` from where `from` was to where it is now (FLIP). */
function flyFrom(el: HTMLElement, from: DOMRect, ms: number, delay = 0, mid?: (dx: number, dy: number, sc: number) => Keyframe) {
  const to = el.getBoundingClientRect();
  if (RM || !to.width || !from.width) return null;
  const dx = from.left + from.width / 2 - (to.left + to.width / 2), dy = from.top + from.height / 2 - (to.top + to.height / 2), sc = from.width / to.width;
  const frames: Keyframe[] = [{ transform: `translate(${dx}px, ${dy}px) scale(${sc})` }];
  if (mid) frames.push(mid(dx, dy, sc));
  frames.push({ transform: "none" });
  return el.animate(frames, { duration: ms, delay, easing: "cubic-bezier(.22, .9, .28, 1)", fill: "backwards" });
}
const nudge = (el?: HTMLElement | null) => el?.animate([{ transform: "none" }, { transform: "translateX(-8px)" }, { transform: "translateX(7px)" }, { transform: "translateX(-3px)" }, { transform: "none" }], { duration: 320 });

// ---------- the pack ----------

/** Each pack's constellation: its stars (x, y, size) and the lines joining them (pairs of star indexes). Made up, and
    drawn on a 100 x 100 sky. */
const SKIES: Record<"std" | "gold" | "myth", { stars: [number, number, number][]; lines: [number, number][] }> = {
  // The Arrow: a long rising line with a fletched tail.
  std: {
    stars: [[16, 78, 1.6], [30, 66, 2.2], [44, 55, 1.8], [57, 44, 2.6], [70, 33, 2], [84, 21, 3.2], [75, 48, 1.5], [64, 22, 1.5], [22, 88, 1.2], [10, 66, 1.2]],
    lines: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [5, 7], [0, 8], [0, 9]],
  },
  // The Crown: five points over a band.
  gold: {
    stars: [[12, 70, 1.8], [24, 38, 2.4], [37, 58, 1.6], [50, 22, 3.4], [63, 58, 1.6], [76, 38, 2.4], [88, 70, 1.8], [50, 74, 1.4], [31, 74, 1.2], [69, 74, 1.2]],
    lines: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [0, 8], [8, 7], [7, 9], [9, 6]],
  },
  // The Comet: a bright head with a long, sweeping tail of stars.
  myth: {
    stars: [[78, 24, 3.8], [68, 34, 2.4], [56, 42, 2], [44, 52, 1.8], [33, 60, 1.6], [22, 70, 1.4], [12, 80, 1.2], [86, 34, 1.6], [70, 14, 1.6], [60, 56, 1.3], [38, 40, 1.3]],
    lines: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [0, 7], [0, 8], [2, 9], [3, 10]],
  },
};
/** Faint background stars, the same on every pack (a fixed scatter). */
const FIELD: [number, number, number][] = Array.from({ length: 36 }, (_, i) => {
  const r = (n: number) => ((Math.sin(i * 12.9898 + n * 78.233) * 43758.5453) % 1 + 1) % 1;
  return [r(1) * 100, r(2) * 100, 0.35 + r(3) * 0.6];
});

/** The pack's art: a quiet star map, glowing in the pack's color. Still: nothing on it moves. */
function Sky({ k }: { k: Kind }) {
  const sky = SKIES[k === "test" ? "std" : k];
  return (
    <svg class="op-sky" viewBox="0 0 100 100" aria-hidden="true">
      {FIELD.map(([x, y, r]) => <circle class="op-dust" cx={x} cy={y} r={r} />)}
      {sky.lines.map(([a, b]) => <line x1={sky.stars[a][0]} y1={sky.stars[a][1]} x2={sky.stars[b][0]} y2={sky.stars[b][1]} />)}
      {sky.stars.map(([x, y, r]) => <circle class="op-star" cx={x} cy={y} r={r} />)}
    </svg>
  );
}

export function PackArt({ k, odds }: { k: Kind; odds?: boolean }) {
  return (
    <div class={cx("op-pack", `k-${k}`)}>
      {odds && [-3, -2, -1, 0, 1, 2, 3].map((z) => <i class="op-pedge" style={{ "--z": z }} />)}
      <div class="op-pface op-pfront">
        {odds ? <canvas class="op-ripcv" aria-hidden="true" /> : <div class="op-ptop" />}
        <div class="op-pbody">
          <span class="op-pyr">{RECIPE?.season ?? 2026}</span>
          <Sky k={k} />
          <b class="op-pname">{(RECIPE?.name ?? "Championship").replace(/^\d{4}\s*/, "")}</b>
          <span class="op-pkind">{k === "std" ? "5 cards" : k === "myth" ? "3 Mythics" : NAME[k]}</span>
          <i class="op-psheen" />
        </div>
      </div>
      {odds && <div class="op-pface op-pback"><div class="op-pbody"><Odds k={k} /></div></div>}
    </div>
  );
}

function Odds({ k }: { k: Kind }) {
  const o = RECIPE.odds as typeof RECIPE.odds & { boosted?: { slots: Partial<Record<Tier, number>>; mythicMult: number } };
  const b = k === "gold" || k === "myth" ? o.boosted : undefined;
  const slots = b?.slots ?? o.slots, demo = st.get()!.demo;
  const pct = (x = 0) => `${+(x * 100).toFixed(2)}%`;
  return (
    <div class="op-odds">
      <b>{NAME[k]} pack</b>
      <dl>
        {(["common", "uncommon", "rare", "legendary"] as Tier[]).map((t) => <><dt style={{ color: TIERS[t].color }}>{TIERS[t].label}</dt><dd>{pct(slots[t])}</dd></>)}
        <dt style={{ color: TIERS.mythic.color }}>Mythic</dt>
        <dd>{k === "myth" ? "3 inside" : `1 in ${Math.round(1 / ((demo ? o.demoMythic : o.mythicBase) * (b?.mythicMult ?? 1)))}`}</dd>
      </dl>
      <small>Last card is Rare or better.{demo ? " Demo luck is on." : ""}</small>
    </div>
  );
}

// ---------- the Open tab ----------

export function OpenHome() {
  const s = useStore(st)!;
  const [k, setK] = useState(kind);
  const btn = useRef<HTMLButtonElement>(null);
  const c = counts();
  const kinds: Kind[] = ["std"];
  if (c.gold) kinds.push("gold");
  if (c.myth) kinds.push("myth");
  if (s.account.admin) kinds.push("test");
  const cur: Kind = kinds.includes(k) ? k : c.std ? "std" : c.gold ? "gold" : c.myth ? "myth" : "std";
  kind = cur;
  const n = c[cur], left = usable(s.pending) ? s.pending : null;
  const go = () => {
    if (left) return openFlow(left);
    if (!n) { sfx.tick(); nudge(btn.current); return toast(c.std + c.gold + c.myth ? "None of those left." : "Out of packs for now.", true, 1800); }
    sfx.pick();
    openFlow();
  };
  const tilt = (e: PointerEvent) => {
    if (e.pointerType !== "mouse") return;
    const b = btn.current!, r = b.getBoundingClientRect();
    b.style.setProperty("--gx", (((e.clientX - r.left) / r.width - 0.5) * 2).toFixed(3));
    b.style.setProperty("--gy", (((e.clientY - r.top) / r.height - 0.5) * 2).toFixed(3));
  };
  const untilt = () => { btn.current?.style.removeProperty("--gx"); btn.current?.style.removeProperty("--gy"); };
  return (
    <section class="op-home">
      <button ref={btn} type="button" data-pad-first class={cx("op-hero", !n && !left && "op-empty")} onClick={go} onPointerDown={loadGL} onPointerMove={tilt} onPointerLeave={untilt}
        aria-label={left ? "Finish opening your last pack" : `${NAME[cur]} pack, ${cur === "test" ? "unlimited" : n} to open`}>
        <span class="op-hero-in"><PackArt k={left ? "std" : cur} /></span>
        {!left && cur !== "test" && <em class={cx("op-count", cur !== "std" && "op-gold")}>×{n}</em>}
      </button>
      <p class="op-cap">{left ? "Finish opening" : cur === "test" ? "Test pack · nothing is saved" : n ? `${NAME[cur]} pack` : "No packs left"}</p>
      {!left && kinds.length > 1 && (
        <div class="op-kinds">
          {kinds.map((x) => (
            <button type="button" class={cx("op-kind", `k-${x}`, x === cur && "op-on", x !== "test" && !c[x] && "op-none")} aria-pressed={x === cur} onClick={() => { kind = x; setK(x); sfx.tick(); }}>
              <i /><b>{x === "test" ? "∞" : c[x]}</b><span>{NAME[x]}</span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function openFlow(resume?: Opening) {
  push(() => <Flow resume={resume} />, "open");
}

// ---------- effects ----------

/** Confetti on a canvas over everything. */
function particles(cv: HTMLCanvasElement) {
  const ctx = cv.getContext("2d")!, dpr = Math.min(devicePixelRatio || 1, 2), PAL = ["#ff3d9a", "#ffe14a", "#38ffd2", "#4d7bff", "#c04dff", "#ffffff"];
  const ps: { x: number; y: number; vx: number; vy: number; life: number; dec: number; sz: number; c: string; rot: number; vr: number }[] = [];
  let raf = 0;
  const size = () => { cv.width = innerWidth * dpr; cv.height = innerHeight * dpr; };
  size();
  addEventListener("resize", size);
  const tick = () => {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    for (let i = ps.length - 1; i >= 0; i--) {
      const p = ps[i];
      p.x += p.vx; p.y += p.vy; p.vy += 0.22; p.vx *= 0.985; p.life -= p.dec; p.rot += p.vr;
      if (p.life <= 0) { ps.splice(i, 1); continue; }
      ctx.save(); ctx.globalAlpha = p.life; ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.fillStyle = p.c; ctx.fillRect(-p.sz / 2, -p.sz / 3, p.sz, p.sz * 0.66); ctx.restore();
    }
    raf = ps.length ? requestAnimationFrame(tick) : 0;
  };
  return {
    /** `color` null is rainbow. */
    burst(x: number, y: number, n: number, color: string | null, pow: number) {
      if (RM) n = Math.min(n, 12);
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2, sp = (0.3 + Math.random()) * pow;
        ps.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - pow * 0.35, life: 1, dec: 0.008 + Math.random() * 0.014, sz: 3 + Math.random() * 6, c: color ?? PAL[i % PAL.length], rot: Math.random() * 6, vr: (Math.random() - 0.5) * 0.4 });
      }
      if (!raf) raf = requestAnimationFrame(tick);
    },
    stop() { cancelAnimationFrame(raf); removeEventListener("resize", size); },
  };
}

// ---------- the opening, over the tabs ----------

type Phase = "wheel" | "hold" | "cutting" | "deal" | "stack" | "summary";

function Flow({ resume }: { resume?: Opening }) {
  const mine = useStore(inv);
  const done = useStore(sets);
  const [phase, setPhase] = useState<Phase>(resume ? "stack" : prefs.get().wheel2 ? "wheel" : "hold");
  const ph = useRef(phase);
  const go = (p: Phase) => { ph.current = p; setPhase(p); };
  const kr = useRef<Kind>(kind);
  const k = kr.current;
  const [round, setRound] = useState(0); // a new pack in hand starts fresh
  const [from, setFrom] = useState<DOMRect | null>(null); // where the pack was on the wheel
  const [best, setBest] = useState<Tier | null>(null);
  const [torn, setTorn] = useState(false);
  const [dropping, setDropping] = useState(false);
  const [deck, setDeck] = useState<Deal[] | null>(resume ? resume.cards : null);
  const [idx, setIdx] = useState(resume ? Math.min(resume.revealed, 4) : 0);
  const at = useRef(idx);
  const [up, setUp] = useState<number[]>([]); // face-down cards flipped over
  const [promo, setPromo] = useState<number[]>([]); // Mythics whose glow has turned from Legendary to Mythic
  const [charging, setCharging] = useState(-1);
  const [aura, setAura] = useState(-1);
  const [gone, setGone] = useState<{ i: number; dir: number }[]>([]);
  const [fan, setFan] = useState(false);
  const [busy, setBusy] = useState(false);
  const [mood, setMood] = useState(""); // op-m-dark, op-m-rays, op-m-aura
  const [ray, setRay] = useState("");
  const [say, setSay] = useState<{ text: string; n: number } | null>(null);
  const [skipped, setSkipped] = useState<Deal | null>(null);
  const op = useRef<{ id: number; sets: string[] } | null>(resume ? { id: resume.id, sets: resume.sets } : null);
  /** The pack in hand: its cards, known (with their serial numbers) from the moment it's picked up. */
  const hand = useRef<{ n: number; cards?: { num: number; tier: Tier; serial?: number }[] }>({ n: 0 });
  /** Those cards as they'll be dealt, drawn out of sight while the pack is in your hand, so the WebGL opening's
      pictures of them are made before the tear. */
  const [bake, setBake] = useState<Deal[] | null>(null);
  const openReq = useRef<Promise<Result> | null>(null);
  const stage = useRef<HTMLDivElement>(null), fxEl = useRef<HTMLDivElement>(null), cv = useRef<HTMLCanvasElement>(null), flashEl = useRef<HTMLDivElement>(null);
  const grip = useRef<HTMLDivElement>(null), stackEl = useRef<HTMLDivElement>(null), sumEl = useRef<HTMLDivElement>(null);
  const fx = useRef<ReturnType<typeof particles> | null>(null);
  const flowEl = useRef<HTMLDivElement>(null), glCv = useRef<HTMLCanvasElement>(null);
  const [gl, setGl] = useState<PackGL | null>(null);
  const glRef = useRef<PackGL | null>(null);
  const timers = useRef<number[]>([]);
  const charge = useRef<number[]>([]);
  const alive = useRef(true);
  const later = (ms: number, f: () => void) => { const t = window.setTimeout(() => { if (alive.current) f(); }, ms); timers.current.push(t); return t; };

  useEffect(() => {
    fx.current = particles(cv.current!);
    if (ph.current === "hold") pickUp();
    if (resume) toast("Picking up your last pack", false, 2000);
    loadGL()?.then((m) => {
      if (!alive.current) return;
      glRef.current = m.createPackGL(glCv.current!, flowEl.current!);
      setGl(glRef.current);
    });
    return () => {
      alive.current = false;
      timers.current.forEach(clearTimeout);
      fx.current?.stop();
      glRef.current?.dispose();
      if (op.current?.id) sync(); // left halfway: the Open tab offers to finish it
    };
  }, []);

  // ----- effects -----
  const burst = (r: DOMRect, n: number, color: string | null, pow: number, dy = 0.5) => fx.current?.burst(r.left + r.width / 2, r.top + r.height * dy, n, color, pow);
  const shake = (big: boolean) => {
    if (RM) return;
    const a = big ? 6 : 3;
    stage.current?.animate([{ transform: "none" }, { transform: `translate(${-a}px, ${a / 2}px) rotate(-.4deg)` }, { transform: `translate(${a}px, ${-a / 2}px) rotate(.4deg)` }, { transform: `translate(${-a}px, ${a / 2}px)` }, { transform: `translate(${a / 2}px, ${-a / 3}px)` }, { transform: "none" }], { duration: big ? 850 : 550, easing: "ease-out" });
  };
  const flash = (color = "#fff", ms = 550) => {
    const el = flashEl.current;
    if (RM || !el) return;
    el.style.background = color;
    el.animate([{ opacity: 0.85 }, { opacity: 0 }], { duration: ms, easing: "ease-out" });
  };
  const banner = (text: string, ms = 3200) => { const n = Date.now(); setSay({ text, n }); later(ms, () => setSay((x) => (x?.n === n ? null : x))); };
  /** A short-lived effect element (shockwave, title) in the effects layer, which Preact leaves alone. */
  const spawn = (cls: string, style: Record<string, string>, ms: number, html = "") => {
    const el = document.createElement("div");
    el.className = cls;
    for (const [p, v] of Object.entries(style)) el.style.setProperty(p, v);
    el.innerHTML = html;
    fxEl.current?.appendChild(el);
    setTimeout(() => el.remove(), ms);
  };
  const ripFx = (r: DOMRect, color: string, big: boolean) => {
    if (RM) return;
    spawn("op-rip", { left: `${r.left}px`, top: `${r.top + r.height * 0.13 - r.width / 2}px`, width: `${r.width}px`, height: `${r.width}px`, "--c": color }, 1000,
      `${big ? '<i class="op-rip-rays"></i>' : ""}<i class="op-rip-ring"></i><i class="op-rip-slash"></i>`);
  };
  const topRect = () => stackEl.current?.querySelector(".op-card.op-top")?.getBoundingClientRect() ?? stackEl.current!.getBoundingClientRect();

  // ----- the pack in your hand -----
  const outOfPacks = () => { back(); toast("Out of packs", true, 2000); sync(); };
  /** Picking up a pack asks the server to decide its cards (they stay fixed if you put it back). Only the best rarity
      comes back, so the glow while you swipe tells the truth without spoiling the cards. */
  function pickUp() {
    const n = ++hand.current.n, kk = kr.current;
    hand.current.cards = undefined;
    openReq.current = null;
    setBest(null); setBake(null);
    // The pack's cards: their photos start downloading and their pictures get made while it's in your hand.
    const got = (cards: { num: number; tier: Tier; serial?: number }[]) => {
      hand.current.cards = cards;
      setBest(cards[4].tier);
      photosReady(cards.map((c) => c.num), 0);
      setBake(dealt(cards));
    };
    if (kk === "test") {
      api.admin.testPack(PACK, false).then((r) => { if (n === hand.current.n) got(r.cards); }, fail);
      return;
    }
    api.hand(PACK, ...flags(kk)).then((r) => {
      if (n !== hand.current.n) return;
      if (r.cards?.length === 5) got(r.cards); else setBest(r.best);
    }, (e) => { if (n === hand.current.n && e?.code === "no_packs") outOfPacks(); });
  }
  /** The pack in hand's cards as they'll be dealt: new or another copy, by what you have now (the server's answer
      has the last word once it's in). */
  const dealt = (cards: { num: number; tier: Tier; serial?: number }[]): Deal[] => cards.map((c) => {
    if (kr.current === "test") return { ...c, serial: 0, isNew: false, copy: 0, test: true };
    const have = inv.get()[c.num]?.length ?? 0;
    return { num: c.num, tier: c.tier, serial: c.serial ?? 0, isNew: have === 0, copy: have + 1 };
  });
  const toHand = (r: DOMRect | null) => {
    setFrom(r); setTorn(false); setDropping(false); setRound((x) => x + 1);
    go("hold");
    pickUp();
  };
  /** Opens the pack on the server, once, even if the swipe and the button both ask. Starts while the swipe is still
      going, so the cards are usually there when the tear finishes. */
  const startOpen = () => {
    if (!openReq.current) {
      const kk = kr.current;
      if (kk === "test") {
        const cs = hand.current.cards;
        hand.current.cards = undefined;
        openReq.current = cs?.length === 5
          ? Promise.resolve({ opening: { id: 0, pack: PACK, revealed: 0, sets: [], cards: cs.map((c) => ({ ...c, serial: 0, isNew: false, copy: 0, test: true })) }, state: null, streakReward: false })
          : Promise.reject(new Error("The test pack isn't ready yet. Try again."));
      } else openReq.current = api.open(PACK, ...flags(kk)) as Promise<Result>;
      openReq.current.catch(() => {});
      openReq.current.then((r) => photosReady(r.opening.cards.map((c) => c.num), 0), () => {});
    }
    return openReq.current;
  };
  /** A full swipe (or the Open button). The pack was minted when it was picked up, so its cards are already known
      (and their photos and pictures ready): it bursts open and they rise out straight away, while the server records
      the opening. Without them (an answer still on its way), it bursts by the best card's rarity and the cards rise
      when the server's answer is in. */
  const cut = async () => {
    if (ph.current !== "hold") return;
    go("cutting");
    const before = st.get()!.streak, shown = best, held = hand.current.cards;
    const ready = held?.length === 5 && (kr.current === "test" || held.every((c) => c.serial)) ? dealt(held) : null;
    if (ready) rip(ready, 0);
    else if (shown) burstOpen(shown);
    try {
      const r = await startOpen();
      openReq.current = null;
      if (!alive.current) return;
      if (r.state) applyState(r.state);
      const o = r.opening;
      if (!usable(o)) { toast("Your pack opened. Reloading to show it…"); setTimeout(() => location.reload(), 1200); return; }
      op.current = o.id ? { id: o.id, sets: o.sets } : null;
      const s = st.get()!.streak;
      if (r.streakReward) later(2600, () => { sfx.promote(); banner(`${s.days}-day streak! A boosted pack is yours`, 4000); });
      else if (!before.today && s.today && s.days > 1) later(2600, () => banner(`${s.days}-day streak!`, 2600));
      if (ready) return setDeck(o.cards); // already out: the server's word on what's new, and copies in the game
      await photosReady(o.cards.map((c) => c.num), 450);
      if (alive.current) (shown ? deal : rip)(o.cards, 0);
    } catch (e) {
      openReq.current = null;
      if (!alive.current) return;
      sfx.strainStop();
      if ((e as { code?: string }).code === "no_packs") return outOfPacks();
      // The server may have opened it and only the answer got lost: pick that pack up instead of opening another.
      try {
        const s = await api.state();
        if (kr.current !== "test" && usable(s.pending)) {
          applyState(s); op.current = { id: s.pending.id, sets: s.pending.sets };
          return ready ? setDeck(s.pending.cards) : (shown ? deal : rip)(s.pending.cards, s.pending.revealed);
        }
      } catch { /* show the first error */ }
      // It comes back whole, to try again.
      if (ready) { setDeck(null); setIdx(0); at.current = 0; setUp([]); setDropping(false); }
      if (ready || shown) { setTorn(false); setRound((x) => x + 1); }
      go("hold");
      fail(e);
    }
  };
  /** The pack tears open: a burst in the best card's color, the light, the wrapper coming away. */
  const burstOpen = (b: Tier) => {
    const big = b === "legendary" || b === "mythic", r = grip.current!.getBoundingClientRect();
    sfx.burst(b);
    shake(true);
    flash(TIERS[b].color, 650);
    setBest(b); setTorn(true);
    burst(r, big ? 60 : 40, TIERS[b].color, 7, 0.12);
    ripFx(r, TIERS[b].color, big);
  };
  /** The cards come out. */
  const deal = (cards: Deal[], first: number) => {
    setDeck(cards); setIdx(first); at.current = first; setUp([]); setPromo([]); setGone([]);
    go("deal");
  };
  const rip = (cards: Deal[], first: number) => { burstOpen(cards[4].tier); deal(cards, first); };

  // The cards rise out of the torn pack, fanned, and settle into a stack while the empty pack drops away.
  useLayoutEffect(() => {
    if (phase !== "deal") return;
    const s = stackEl.current!, pr = grip.current?.getBoundingClientRect();
    const start = pr && new DOMRect(pr.left + pr.width * 0.08, pr.top + pr.height * 0.2, pr.width * 0.84, pr.width * 0.84 * 1.4);
    setFan(true);
    const anim = start && flyFrom(s, start, 720, 0, (dx, dy, sc) => ({ offset: 0.42, transform: `translate(${dx * 0.5}px, ${dy - pr!.height * 0.42}px) scale(${(sc + 1) / 2})` }));
    if (!anim) { setFan(false); go("stack"); return; }
    // The first frame with five new cards takes a while to draw. The animation's clock would run through it and the
    // cards would skip the rise, so they wait inside the pack until frames come smoothly again.
    anim.pause();
    let last = performance.now(), slow = false;
    const t0 = last;
    const wait = (now: number) => {
      const smooth = now - last < 30;
      last = now;
      if (!smooth) slow = true;
      if (now - t0 < 600 && !(smooth && (slow || now - t0 > 150))) { requestAnimationFrame(wait); return; }
      setDropping(true);
      anim.play();
      later(380, () => setFan(false));
      later(720, () => { sfx.thud(0.6); shake(false); go("stack"); });
    };
    requestAnimationFrame(wait);
  }, [phase]);

  // The cards in WebGL too: each face, back and ribbon, rising out of the pack (their pictures were made while it was
  // in your hand), on the stack and in the summary. Runs after every render, so cards and ribbons that appear are
  // picked up.
  useLayoutEffect(() => {
    const g = glRef.current, f = flowEl.current;
    if (!g || !f || (phase !== "deal" && phase !== "stack" && phase !== "summary")) return;
    const els: [HTMLElement, string][] = [];
    g.mirror(pictured(f).filter(([el]) => !el.closest(".op-bake")));
  });
  // No pictures made while the pack is torn open and the cards come out: they're made before, or after.
  useEffect(() => { gl?.quiet("opening", phase === "cutting" || phase === "deal"); }, [gl, phase]);

  // ----- the stack -----
  useEffect(() => { if (phase === "stack") stackEl.current?.focus({ preventScroll: true }); }, [phase]); // Enter and arrow keys deal
  const top = deck && idx < 5 ? deck[idx] : null;
  const isUp = (i: number) => !faceDown(deck![i].tier) || up.includes(i);
  // A face-down card on top glows in its rarity's color (a Mythic teal) and hums.
  useEffect(() => { if (phase === "stack" && top && !isUp(idx)) sfx.tease(top.tier); }, [phase, idx]);

  const reveal = (i: number) => {
    const c = deck![i];
    if (c.tier !== "mythic" || RM) return flip(i);
    // A Mythic's moment: the room goes dark, the card trembles and leaks rainbow light, two heartbeats, then it flips.
    setPromo((p) => (p.includes(i) ? p : [...p, i]));
    setCharging(i); setMood("op-m-dark"); setBusy(true);
    sfx.heartbeat();
    charge.current = [later(450, () => sfx.swell(1.05)), later(1500, () => flip(i))]; // a backwards swell lands on the flip
  };
  const flip = (i: number) => {
    charge.current.forEach(clearTimeout);
    charge.current = [];
    const c = deck![i], t = BY_NUM.get(c.num)!;
    setCharging(-1); setUp((u) => [...u, i]); setBusy(true);
    sfx.flip(c.tier);
    later(380, () => {
      if (ph.current !== "stack") return;
      const r = topRect(), [n, pow] = BURST[c.tier];
      if (faceDown(c.tier)) glRef.current?.flare(r, TIERS[c.tier].color, c.tier !== "rare");
      if (c.tier === "rare") { burst(r, n, TIERS.rare.color, pow); shake(false); }
      else if (c.tier === "legendary") {
        burst(r, n, TIERS.legendary.color, pow); burst(r, 60, null, 9); shake(true); flash();
        setRay("rgba(190, 140, 255, .16)"); setMood("op-m-rays");
        banner(`LEGENDARY · ${t.name} (${t.num})`, 3000);
      } else if (c.tier === "mythic") mythic(c, r);
    });
    later(RM ? 0 : 360, () => sfx.snap());
    later(RM ? 400 : 850, () => setBusy(false));
  };
  /** White flash, shockwaves, MYTHIC stamped in gold, the name under it, confetti, and a rainbow aura that stays until
      you move on. */
  const mythic = (c: Deal, r: DOMRect) => {
    const t = BY_NUM.get(c.num)!, x = r.left + r.width / 2, y = r.top + r.height / 2;
    setAura(at.current); setRay("rgba(255, 225, 120, .2)"); setMood("op-m-aura op-m-rays");
    flash(); shake(true); sfx.mythic();
    if (!RM) {
      [0, 180, 420].forEach((d, i) => later(d, () => spawn(cx("op-mring", i === 1 && "op-gold"), { left: `${x}px`, top: `${y}px` }, 1300)));
      [0, 350, 800].forEach((d) => later(d, () => spawn("op-mshock", { left: `${x}px`, top: `${y}px` }, 1500)));
      spawn("op-mtitle", { "--ty": `${y - r.height * 0.12}px` }, 2900, [..."MYTHIC"].map((ch, i) => `<span style="--i:${i}">${ch}</span>`).join(""));
      [..."MYTHIC"].forEach((_, i) => later(330 + i * 70, () => sfx.stamp(i))); // each letter lands with a hit
      const nm = document.createElement("div");
      nm.innerHTML = `<b></b><span>Team ${t.num}</span>`;
      nm.querySelector("b")!.textContent = t.name;
      spawn("op-mname", { "--ny": `${y + r.height * 0.46}px` }, 3400, nm.innerHTML);
    }
    fx.current?.burst(x, y, 90, null, 15);
    later(300, () => { fx.current?.burst(x - 70, y - 50, 50, "#ffd34d", 11); fx.current?.burst(x + 70, y - 50, 50, "#ffd34d", 11); });
    later(750, () => fx.current?.burst(x, y - 90, 90, null, 13));
    later(1250, () => fx.current?.burst(x, y, 40, "#fff6c2", 9));
    const n = c.inGame ?? 0;
    banner(`MYTHIC · ${t.name} (${t.num}) · ${c.test ? "a test pull" : n === 1 ? "the only one in the game" : n > 1 ? `one of only ${n} in the game` : `No. ${c.serial}`}`, 6000);
  };
  /** Deals the top card off: it joins the binder, and the next one is live straight away. */
  const fling = (dir: number) => {
    const i = at.current;
    if (!deck || i >= 5 || !isUp(i)) return;
    sfx.whoosh();
    setMood(""); setAura(-1);
    const c = deck[i];
    if (!c.test) stash(c);
    const n = i + 1;
    at.current = n; setIdx(n);
    setGone((g) => [...g, { i, dir }]);
    if (op.current) {
      api.progress(op.current.id, n).catch(() => {});
      const p = st.get()?.pending;
      if (p?.id === op.current.id) p.revealed = n; // leaving now picks up from here
    }
    later(RM ? 60 : 380, () => { setGone((g) => g.filter((x) => x.i !== i)); if (n >= 5) summary(null); });
    if (n < 5) later(RM ? 0 : 140, () => sfx.snap(0.5));
  };
  const tapTop = () => {
    if (charging >= 0) return flip(charging); // tap through a Mythic's build-up
    if (ph.current !== "stack" || busy || at.current >= 5) return;
    if (isUp(at.current)) fling(1); else reveal(at.current);
  };
  const drag = useRef<{ x: number; y: number; el: HTMLElement; moved: boolean; id: number } | null>(null);
  const sDown = (e: PointerEvent) => {
    const el = stackEl.current?.querySelector<HTMLElement>(".op-card.op-top");
    if (!el || ph.current !== "stack") return;
    drag.current = { x: e.clientX, y: e.clientY, el, moved: false, id: e.pointerId };
    try { stackEl.current!.setPointerCapture(e.pointerId); } catch { /* fine */ }
  };
  const sMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.id) return;
    let dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.abs(dx) + Math.abs(dy) < 8) return;
    d.moved = true;
    if (!isUp(at.current)) dx *= 0.25; // face-down cards resist; tap to flip them
    d.el.classList.add("op-drag");
    d.el.style.transform = `translate(${dx}px, ${dy * 0.3}px) rotate(${dx * 0.06}deg)`;
    glRef.current?.wake();
  };
  const sUp = (e: PointerEvent) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.id) return;
    drag.current = null;
    d.el.classList.remove("op-drag");
    if (!d.moved) return tapTop();
    const dx = e.clientX - d.x;
    d.el.style.transform = "";
    if (isUp(at.current) && !busy && Math.abs(dx) > 70) fling(dx > 0 ? 1 : -1);
  };
  const sCancel = () => { const d = drag.current; if (d) { d.el.classList.remove("op-drag"); d.el.style.transform = ""; drag.current = null; } };
  const sKey = (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); tapTop(); }
    else if ((e.key === "ArrowRight" || e.key === "ArrowLeft") && !busy && deck && isUp(at.current)) fling(e.key === "ArrowRight" ? 1 : -1);
  };

  // ----- the summary -----
  const summary = (sk: Deal | null) => {
    charge.current.forEach(clearTimeout);
    deck!.forEach((c) => { if (!c.test) stash(c); });
    const o = op.current;
    op.current = null;
    if (o) api.progress(o.id, 5).then(() => sync(), () => {});
    const s = st.get();
    if (s?.pending) st.set({ ...s, pending: null });
    at.current = 5; setIdx(5);
    setMood(""); setAura(-1); setCharging(-1); setBusy(false); setSkipped(sk);
    go("summary");
    if (o?.sets.length) {
      sets.set(new Set([...sets.get(), ...o.sets]));
      const l = o.sets;
      later(sk ? 1800 : 400, () => { sfx.claim(); banner(`${l.length > 1 ? l.slice(0, -1).join(", ") + " and " + l[l.length - 1] : l[0]} set complete! +${plural(l.length, "pack")}`, 4200); });
    }
  };
  /** Reveal all: straight to the summary, still with the big moment for the best card if it was face down. */
  const skip = () => {
    if (!deck || (ph.current !== "stack")) return;
    const last = deck[4];
    summary(faceDown(last.tier) && !up.includes(4) ? last : null);
  };
  useLayoutEffect(() => {
    if (phase !== "summary" || !sumEl.current) return;
    // The cards come up into their places in the fan one after another, each with a soft snap, the best one last.
    const kids = [...sumEl.current.children] as HTMLElement[];
    if (!RM) {
      sumEl.current.previousElementSibling?.animate([{ opacity: 0, transform: "translateY(8px)" }, { opacity: 1, transform: "none" }], { duration: 320, easing: "ease-out", fill: "backwards" });
      kids.forEach((el, i) => {
        (el.firstElementChild as HTMLElement).animate([{ opacity: 0, transform: "translateY(18px) scale(.94)" }, { opacity: 1, transform: "none" }], { duration: 360, delay: 120 + i * 90, easing: "cubic-bezier(.2, .8, .3, 1)", fill: "backwards" });
        later(120 + i * 90 + 200, () => sfx.snap(0.35));
      });
    }
    if (skipped) {
      if (skipped.tier === "mythic") sfx.mythic(); else sfx.flip(skipped.tier);
      later(RM ? 0 : 520, () => {
        const el = kids[kids.length - 1];
        if (!el) return;
        const r = el.getBoundingClientRect(), [n, pow] = BURST[skipped.tier];
        glRef.current?.flare(r, TIERS[skipped.tier].color, skipped.tier !== "rare");
        burst(r, n, skipped.tier === "mythic" ? null : TIERS[skipped.tier].color, pow);
        if (skipped.tier === "legendary" || skipped.tier === "mythic") { flash(); shake(true); banner(`${TIERS[skipped.tier].label.toUpperCase()} · ${BY_NUM.get(skipped.num)!.name} (${skipped.num})`, 3000); }
      });
    }
  }, [phase]);
  const left = () => { const c = counts(); return kr.current === "test" ? 1 : c.std + c.gold + c.myth; };
  /** Another pack of the same kind, or the other kind when that ran out. */
  const again = () => {
    const c = counts();
    let nk = kr.current;
    if (nk !== "test" && !c[nk]) nk = c.std ? "std" : c.gold ? "gold" : c.myth ? "myth" : nk;
    if (nk !== "test" && !c[nk]) return back();
    kind = kr.current = nk;
    setDeck(null); setIdx(0); at.current = 0; setUp([]); setPromo([]); setGone([]); setSkipped(null); setRay("");
    sfx.pick();
    if (prefs.get().wheel2) { setTorn(false); setDropping(false); go("wheel"); } else toHand(null);
  };

  /** Back from the pack in your hand: a pack torn far enough to open gets opened. */
  const holdBack = () => (openReq.current ? cut() : prefs.get().wheel2 ? go("wheel") : back());
  /** Open without swiping. Turned over? Face it first, then tear it. */
  const openNow = () => { if (holdApi.front && !holdApi.front()) { holdApi.face?.(); later(350, cut); } else cut(); };
  // A controller: A opens or deals, X turns the pack over, Y reveals the rest, B puts the pack back.
  usePad((b) => {
    const p = ph.current;
    if (p === "hold") {
      if (b === "a") openNow(); else if (b === "x") holdApi.turn?.(); else if (b === "b") holdBack(); else return false;
      return true;
    }
    if (p === "stack") {
      if (b === "a") tapTop();
      else if (b === "y") skip();
      else if ((b === "left" || b === "right") && !busy && deck && at.current < 5 && isUp(at.current)) fling(b === "right" ? 1 : -1);
      return true; // nothing else (B doesn't leave a pack halfway)
    }
    return p === "cutting" || p === "deal";
  });

  // ----- drawing -----
  const holding = phase === "hold" || phase === "cutting" || phase === "deal";
  const stacked = (phase === "deal" || phase === "stack") && deck;
  const cw = "var(--op-cw)";
  const b4 = deck?.[4], bt = b4 && BY_NUM.get(b4.num);
  const news = deck?.filter((c) => c.isNew && !c.test).length ?? 0;
  const owned = Object.keys(mine).length;
  let near: { d: string; miss: number } | null = null;
  if (phase === "summary") for (const d of DIVS) {
    if (done.has(d)) continue;
    const miss = DIV_TEAMS.get(d)!.filter((t) => !mine[t.num]?.length).length;
    if (miss > 0 && miss <= 3 && (!near || miss < near.miss)) near = { d, miss };
  }
  return (
    <div ref={flowEl} class={cx("op-flow", mood)} style={ray ? { "--ray": ray } : undefined}>
      <i class="op-rays" />
      <div ref={stage} class="op-stage">
        <i class="op-dim" />
        {phase === "wheel" && <Wheel k={k} onPick={(r) => { sfx.pick(); toHand(r); }} onBack={back} />}
        {(holding || stacked) && (
          <div class="op-main">
            {holding && (
              <Hold key={round} k={k} gl={gl} best={best} from={from} active={phase === "hold"} torn={torn} dropping={dropping} grip={grip}
                onEarly={startOpen} onCut={cut} onLand={() => { sfx.thud(1); shake(false); }} />
            )}
            {stacked && (
              <div ref={stackEl} class={cx("op-stack", phase === "deal" && "op-dealing", fan && "op-fan", !!resume && phase === "stack" && "op-rise")} tabIndex={0} role="button"
                aria-label="Card stack. Enter flips or deals the next card." onPointerDown={sDown} onPointerMove={sMove} onPointerUp={sUp} onPointerCancel={sCancel} onKeyDown={sKey}>
                {[4, 3, 2, 1, 0].map((i) => {
                  const g = gone.find((x) => x.i === i);
                  if (i < idx && !g) return null;
                  return <StackCard key={i} c={deck[i]} k={i - idx} up={isUp(i)} flipped={up.includes(i)} promo={promo.includes(i)} charging={charging === i} aura={aura === i} gone={g?.dir} w={cw} />;
                })}
              </div>
            )}
          </div>
        )}
        {phase === "summary" && deck && (
          <div class="op-sum">
            <div class="op-sum-h">
              <small>{b4!.tier === "mythic" ? "Mythic pull" : "Best pull"}</small>
              <b style={{ color: TIERS[b4!.tier].color }}>{bt!.name}</b>
              <span>{news ? `${news} new` : "No new teams"} · {owned}/{TEAMS.length}{near ? ` · ${near.miss} from the ${near.d} set` : ""}</span>
            </div>
            <div ref={sumEl} class="op-sum-cards">
              {deck.map((c, i) => (
                <button type="button" class={cx("op-sc", i === 4 && faceDown(c.tier) && "op-best")} style={{ "--i": i - 2, "--tc": TIERS[c.tier].color }} data-glk={`${c.num}-${c.test ? "TEST" : c.serial}`}
                  onClick={() => { if (!c.test) openCard(c.num); }} aria-label={`${BY_NUM.get(c.num)!.name}, ${TIERS[c.tier].label}`}>
                  <Card num={c.num} serial={c.test ? "TEST" : c.serial} w="var(--op-sw)">
                    <span class={cx("op-ribbon", !c.isNew && "op-dupe")}>{c.test ? "TEST" : c.isNew ? "NEW" : `COPY #${c.copy}`}</span>
                  </Card>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      <div class="op-foot">
        {phase === "hold" && <HoldButtons onBack={holdBack} onOpen={openNow} />}
        {phase === "stack" && deck && (
          <>
            <p class="op-capline">{top && isUp(idx) ? <><b style={{ color: TIERS[top.tier].color }}>{TIERS[top.tier].label}</b>{top.isNew && !top.test ? " · New" : ""}</> : " "}</p>
            <div class="op-dots">{deck.map((_, i) => <i class={i < idx ? "op-done" : i === idx ? "op-now" : ""} />)}</div>
            <button type="button" class="op-link" onClick={skip}>Reveal all</button>
          </>
        )}
        {phase === "summary" && (
          <div class="s-row2 op-sum-b">
            <button type="button" class="s-btn" onClick={left() ? again : back}>{left() ? "Open another" : "Done"}</button>
            {left() > 0 && <button type="button" class="s-btn ghost" onClick={back}>Done</button>}
          </div>
        )}
      </div>
      {gl && bake && holding && <Bake cards={bake} gl={gl} w={cw} />}
      <canvas ref={glCv} class="op-glcv" aria-hidden="true" />
      <div class={cx("op-say", !!say && "op-show")} role="status" aria-live="polite">{say?.text}</div>
      <div ref={fxEl} class="op-fxl" aria-hidden="true" />
      <canvas ref={cv} class="op-fx" aria-hidden="true" />
      <div ref={flashEl} class="op-flash" />
    </div>
  );
}

/** What the WebGL opening draws from pictures, inside `root`: each card's face (keyed by team and serial number, so
    copies share one), the card back, and the ribbons. */
function pictured(root: HTMLElement): [HTMLElement, string][] {
  const els: [HTMLElement, string][] = [];
  for (const c of root.querySelectorAll<HTMLElement>("[data-glk]")) {
    const face = c.querySelector<HTMLElement>(".face.front");
    if (face) els.push([face, `face ${c.dataset.glk}`]);
    const back = c.querySelector<HTMLElement>(".op-back");
    if (back) els.push([back, "back"]);
  }
  for (const r of root.querySelectorAll<HTMLElement>(".op-ribbon")) els.push([r, `ribbon ${r.className} ${r.textContent} ${r.offsetWidth}`]);
  return els;
}

/** The pack in hand's cards, as the stack will show them, out of sight: their pictures for the WebGL opening are
    made from these while you hold the pack (the top card first), so the cards that rise out are ready. */
function Bake({ cards, gl, w }: { cards: Deal[]; gl: PackGL; w: string }) {
  const el = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { gl.prebake(pictured(el.current!)); }, [cards, gl]);
  return (
    <div ref={el} class="op-bake" aria-hidden="true">
      {cards.map((c) => <StackCard c={c} k={0} up flipped={false} promo={false} charging={false} aura={false} w={w} />)}
    </div>
  );
}

function StackCard({ c, k, up, flipped, promo, charging, aura, gone, w }: { c: Deal; k: number; up: boolean; flipped: boolean; promo: boolean; charging: boolean; aura: boolean; gone?: number; w: string }) {
  const t = BY_NUM.get(c.num)!;
  const glow = TIERS[c.tier].color;
  return (
    <div class={cx("op-card", k === 0 && gone === undefined && "op-top", up && "op-up", flipped && "op-flipped", !up && "op-tease", charging && "op-charging", aura && "op-aura", gone !== undefined && "op-gone")}
      data-glk={`${c.num}-${c.test ? "TEST" : c.serial}`}
      style={{ "--cw": w, "--k": Math.max(0, k), "--tc": glow, transform: gone !== undefined ? `translate(${gone * 130}vw, -10vh) rotate(${gone * 30}deg)` : undefined }}>
      <i class="op-glow" />
      <i class="op-leak"><i /></i>
      <div class="op-cscale">
        <div class="op-flip card" data-tier={c.tier}>
          <div class="op-back"><span class="op-bmark"><i /><i /><i /></span></div>
          <Face t={t} tier={c.tier} serial={c.test ? "TEST" : c.serial} />
        </div>
      </div>
      {up && (k === 0 || gone !== undefined) && <span class={cx("op-ribbon", !c.isNew && "op-dupe")}>{c.test ? "TEST" : c.isNew ? "NEW" : `COPY #${c.copy}`}</span>}
    </div>
  );
}

// ---------- the wheel of 10 ----------

function Wheel({ k, onPick, onBack }: { k: Kind; onPick: (r: DOMRect) => void; onBack: () => void }) {
  const wrap = useRef<HTMLDivElement>(null), ring = useRef<HTMLDivElement>(null);
  const me = useRef({ dragged: false, front: -1 });
  useEffect(() => {
    const w = wrap.current!, r = ring.current!, picks = [...r.children] as HTMLElement[], m = me.current;
    let a = 0, raf = 0, g: { x: number; a: number; t: number; v: number; lx: number; id: number; cap: boolean } | null = null;
    // Runs every frame while the wheel turns, so it only writes transforms and opacities.
    const set = (v: number) => {
      a = v;
      r.style.transform = `translateZ(calc(var(--R) * -1)) rotateX(-7deg) rotateY(${v}deg)`;
      const f = ((Math.round(-v / 36) % N) + N) % N;
      picks.forEach((el, i) => {
        el.style.opacity = (1 - ((1 - Math.cos(((i * 36 + v) * Math.PI) / 180)) / 2) * 0.6).toFixed(3);
        if ((i === f) !== el.classList.contains("op-front")) { el.classList.toggle("op-front", i === f); el.setAttribute("aria-selected", String(i === f)); }
      });
      if (f !== m.front) { if (m.front !== -1) { sfx.tick(); buzz(4); } m.front = f; }
    };
    const spinTo = (target: number, ms: number) => {
      cancelAnimationFrame(raf);
      if (RM || !ms) return set(target);
      const from = a, t0 = performance.now();
      const step = (now: number) => {
        const t = Math.min(1, (now - t0) / ms);
        set(from + (target - from) * (1 - Math.pow(1 - t, 3)));
        if (t < 1) raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
    };
    const snap = () => spinTo(Math.round(a / 36) * 36, 380);
    const target = -36 * Math.floor(N / 2);
    // The packs shuffle around on the way in, then settle with one in front.
    if (RM) set(target); else { set(target + 540); spinTo(target, 1100); }
    const down = (e: PointerEvent) => { cancelAnimationFrame(raf); m.dragged = false; g = { x: e.clientX, a, t: performance.now(), v: 0, lx: e.clientX, id: e.pointerId, cap: false }; };
    const move = (e: PointerEvent) => {
      if (!g) return;
      const dx = e.clientX - g.x;
      if (!g.cap && Math.abs(dx) > 6) { g.cap = true; m.dragged = true; w.classList.add("op-drag"); try { w.setPointerCapture(g.id); } catch { /* fine */ } }
      if (!g.cap) return;
      const now = performance.now();
      g.v = ((e.clientX - g.lx) * 0.32) / Math.max(1, now - g.t); g.lx = e.clientX; g.t = now;
      set(g.a + dx * 0.32);
    };
    const upH = () => {
      if (!g) return;
      const was = g;
      g = null;
      w.classList.remove("op-drag");
      if (!was.cap) return;
      setTimeout(() => { m.dragged = false; }, 0);
      // It coasts with the flick's speed, then clicks into place on the nearest pack.
      let v = Math.max(-2.5, Math.min(2.5, was.v)), last = performance.now();
      if (RM) return snap();
      const coast = (now: number) => {
        const dt = now - last;
        last = now; v *= Math.pow(0.94, dt / 16);
        set(a + v * dt);
        if (Math.abs(v) > 0.05) raf = requestAnimationFrame(coast); else snap();
      };
      raf = requestAnimationFrame(coast);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); spinTo(Math.round(a / 36) * 36 + (e.key === "ArrowLeft" ? -36 : 36), 260); }
      else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); picks[m.front < 0 ? 5 : m.front].click(); }
    };
    w.addEventListener("pointerdown", down); w.addEventListener("pointermove", move); w.addEventListener("pointerup", upH); w.addEventListener("pointercancel", upH); w.addEventListener("keydown", key);
    w.focus({ preventScroll: true });
    return () => { cancelAnimationFrame(raf); w.removeEventListener("pointerdown", down); w.removeEventListener("pointermove", move); w.removeEventListener("pointerup", upH); w.removeEventListener("pointercancel", upH); w.removeEventListener("keydown", key); };
  }, []);
  return (
    <div class="op-wheel">
      <div ref={wrap} class={cx("op-ringwrap", `k-${k}`)} tabIndex={0} data-pad-keys role="listbox" aria-label="Choose a pack. Arrow keys turn the wheel.">
        <i class="op-floor" />
        <div ref={ring} class="op-ring">
          {Array.from({ length: N }, (_, i) => (
            <button type="button" class="op-pick" role="option" tabIndex={-1} style={{ "--i": i }} aria-label={`Pack ${i + 1} of ${N}`}
              onClick={(e) => { if (!me.current.dragged) onPick(e.currentTarget.getBoundingClientRect()); }}>
              <PackArt k={k} />
            </button>
          ))}
        </div>
      </div>
      <button type="button" class="s-btn ghost small" onClick={onBack}>Back</button>
    </div>
  );
}

// ---------- the pack in your hand ----------

interface HoldProps { k: Kind; gl: PackGL | null; best: Tier | null; from: DOMRect | null; active: boolean; torn: boolean; dropping: boolean; grip: { current: HTMLDivElement | null }; onEarly: () => void; onCut: () => void; onLand: () => void }

/** Turns the pack in your hand (it shows the odds on the back) and tears it with a swipe across the top. Exposed so
    the buttons under it can do the same. */
const holdApi: { turn?: () => void; front?: () => boolean; face?: () => void } = {};
/** The tear catches every this much of the pack's width, with a tick, a buzz and a jolt. */
const NOTCH = 0.04;
/** How much of the strip has to be torn (as a share of the pack's width) to open it. */
const OPEN_AT = 0.72;

function Hold(p: HoldProps) {
  const lift = useRef<HTMLDivElement>(null), shakeEl = useRef<HTMLDivElement>(null), rotEl = useRef<HTMLDivElement>(null);
  const rip = useRef<Rip | null>(null), torn = useRef({ len: 0, dir: 1, t: 0 });
  const rot = useRef({ y: 0, x: 0 });
  const g = useRef<{ x: number; y: number; ry: number; cut: boolean; w: number; left: number; moved: boolean; id: number; notch: number; dir: number } | null>(null);
  const [away, setAway] = useState(false);
  const [swiping, setSwiping] = useState(false);
  /** The WebGL pack, once it's drawing this one (the DOM pack is then invisible, but still takes the touches). */
  const [drawn, setDrawn] = useState<PackGL | null>(null);
  const glp = useRef<PackGL | null>(null);
  const facingFront = () => { const d = ((rot.current.y % 360) + 360) % 360; return Math.min(d, 360 - d) < 35; };
  const paint = (live: boolean) => {
    const r = rotEl.current;
    if (!r) return;
    r.classList.toggle("op-live", live);
    r.style.transform = `perspective(900px) rotateX(${rot.current.x}deg) rotateY(${rot.current.y}deg)`;
    r.style.setProperty("--sx", (-Math.sin((rot.current.y * Math.PI) / 180) * 60).toFixed(1));
    glp.current?.turn(rot.current.x, rot.current.y, live);
    setAway(!facingFront());
  };
  /** The wrapper torn this far (share of the width, from the side it started: 1 the left, -1 the right), with the best
      card's light coming out of the gap at `t` (0 to 1). */
  const tear = (len: number, dir: number, t: number) => {
    torn.current = { len, dir, t };
    p.grip.current?.style.setProperty("--dir", String(dir));
    const c = TIERS[p.best ?? "common"].color;
    if (glp.current) glp.current.tear(len, dir, t, c); else rip.current?.set(len, dir, t, c);
  };
  const jolt = (t: number) => { if (glp.current) glp.current.jolt(t); else rip.current?.jolt(t); };
  // The WebGL pack takes over as soon as it's ready, if the pack hasn't been touched yet: it looks the same, so the
  // switch can't be seen.
  useEffect(() => {
    const gl = p.gl;
    if (!gl || glp.current || torn.current.len || g.current || p.torn || !p.grip.current || !lift.current || !shakeEl.current) return;
    let live = true;
    gl.show(p.k, p.grip.current, [lift.current, shakeEl.current]).then((ok) => {
      if (!live || !ok) return;
      gl.turn(rot.current.x, rot.current.y, true);
      // Hide the DOM pack once the WebGL one has drawn a frame.
      requestAnimationFrame(() => requestAnimationFrame(() => { if (live) { glp.current = gl; setDrawn(gl); } }));
    });
    return () => { live = false; };
  }, [p.gl]);
  useEffect(() => () => glp.current?.hide(), []);
  useEffect(() => { drawn?.hint(!away && !swiping && !p.torn); }, [drawn, away, swiping, p.torn]);
  useEffect(() => { p.gl?.quiet("swipe", swiping); }, [p.gl, swiping]);
  useEffect(() => { if (p.dropping) drawn?.drop(); }, [drawn, p.dropping]);

  // It lands in your hand with some weight: from the wheel, or dropped in from above.
  useLayoutEffect(() => {
    if (p.from && lift.current) flyFrom(lift.current, p.from, 460);
    const t = setTimeout(p.onLand, RM ? 0 : p.from ? 440 : 380);
    return () => clearTimeout(t);
  }, []);
  useEffect(() => {
    holdApi.turn = () => { rot.current.y += 180; paint(false); sfx.whoosh(); };
    holdApi.front = facingFront;
    holdApi.face = () => { rot.current.y = Math.round(rot.current.y / 360) * 360; rot.current.x = 0; paint(false); };
    const pack = rotEl.current?.querySelector<HTMLElement>(".op-pack"), cv = pack?.querySelector<HTMLCanvasElement>(".op-ripcv");
    if (pack && cv) rip.current = createRip(cv, pack, RM);
    return () => { holdApi.turn = holdApi.front = holdApi.face = undefined; sfx.strainStop(); rip.current?.stop(); };
  }, []);
  // Opened (by the swipe or the Open button): the light at full as the wrapper comes away.
  useEffect(() => {
    if (!p.torn) return;
    const c = torn.current;
    tear(Math.max(c.len, 0.3), c.dir, 1);
    glp.current?.open();
    setTimeout(() => rip.current?.stop(), 700);
  }, [p.torn]);
  // The best card's color arrives from the server after the pack is picked up.
  useEffect(() => { const c = torn.current; if (c.len) tear(c.len, c.dir, c.t); }, [p.best]);

  const down = (e: PointerEvent) => {
    if (!p.active) return;
    const r = p.grip.current!.getBoundingClientRect(), y = (e.clientY - r.top) / r.height;
    g.current = { x: e.clientX, y: e.clientY, ry: rot.current.y, cut: facingFront() && y < 0.26, w: r.width, left: r.left, moved: false, id: e.pointerId, notch: 0, dir: 0 };
    try { p.grip.current!.setPointerCapture(e.pointerId); } catch { /* fine */ }
  };
  const move = (e: PointerEvent) => {
    const s = g.current;
    if (!s || e.pointerId !== s.id || !p.active) return;
    const dx = e.clientX - s.x, dy = e.clientY - s.y;
    if (Math.abs(dx) + Math.abs(dy) > 6) s.moved = true;
    if (s.cut) {
      // The strip rips under your finger, from the side you started on: it catches notch by notch, each catch with a
      // tick, a buzz and a jolt that get stronger, while the pack strains (a rising hum) and the best card's light
      // shows through. Drag back and it closes up again, the sounds running backwards.
      const at = Math.max(0, Math.min(1, (e.clientX - s.left) / s.w)), from = Math.max(0, Math.min(1, (s.x - s.left) / s.w));
      if (!s.dir && Math.abs(at - from) > 0.02) s.dir = at > from ? 1 : -1;
      if (!s.dir) return;
      const len = Math.floor(Math.max(0, (at - from) * s.dir) / NOTCH + 1e-6) * NOTCH, t = Math.min(1, len / OPEN_AT);
      if (len === s.notch) return;
      p.grip.current!.classList.add("op-swiping");
      setSwiping(true);
      tear(len ? (s.dir > 0 ? from : 1 - from) + len : 0, s.dir, t); // the torn edge, measured from the side it started
      sfx.strain(t);
      if (len > s.notch) {
        sfx.tear(t);
        buzz(Math.round(6 + t * 18));
        jolt(t);
        const a = RM ? 0 : 1 + t * 4;
        shakeEl.current?.animate([{ transform: `translate(${(Math.random() * 2 - 1) * a}px, ${a * 0.6}px) rotate(${(Math.random() * 2 - 1) * a * 0.2}deg)` }, { transform: "none" }], { duration: 120, easing: "ease-out" });
      } else {
        sfx.untear(t);
        buzz(Math.round(4 + t * 10));
      }
      s.notch = len;
      if (t > 0.6) p.onEarly(); // ask the server now, so the cards are ready when the tear finishes
      if (t >= 1) { g.current = null; p.onCut(); }
    } else {
      rot.current.y = s.ry + dx * 0.7;
      rot.current.x = Math.max(-18, Math.min(18, -dy * 0.15));
      paint(true);
    }
  };
  const upH = (e: PointerEvent) => {
    const s = g.current;
    if (!s || e.pointerId !== s.id) return;
    g.current = null;
    if (s.cut) {
      // Let go part way: the wrapper lies back down and the light goes out.
      p.grip.current!.classList.remove("op-swiping");
      setSwiping(false);
      tear(0, s.dir || 1, 0);
      if (s.notch) { sfx.strainStop(); sfx.settle(); }
      return;
    }
    if (!s.moved) rot.current.y += 180; // a tap turns it over
    rot.current.y = Math.round(rot.current.y / 180) * 180;
    rot.current.x = 0;
    paint(false);
    sfx.whoosh();
  };
  return (
    <div class={cx("op-hold", `k-${p.k}`, p.torn && "op-torn", p.dropping && "op-drop", away && "op-away", drawn && "op-gl")}>
      <div ref={p.grip} class="op-grip" onPointerDown={down} onPointerMove={move} onPointerUp={upH} onPointerCancel={upH}>
        <div ref={lift} class={cx("op-lift", !p.from && "op-in")}>
          <div ref={shakeEl} class="op-shake">
            <div ref={rotEl} class="op-rot"><PackArt k={p.k} odds /></div>
            <i class="op-cutzone" aria-hidden="true" />
          </div>
        </div>
      </div>
    </div>
  );
}

function HoldButtons({ onBack, onOpen }: { onBack: () => void; onOpen: () => void }) {
  return (
    <div class="op-holdbtns">
      <button type="button" class="s-btn ghost small" onClick={onBack}>Back</button>
      <button type="button" class="s-btn ghost small" onClick={() => holdApi.turn?.()}>Turn over</button>
      <button type="button" class="s-btn small" onClick={onOpen}>Open</button>
    </div>
  );
}
