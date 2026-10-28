// Shared pieces: the card (the FRC Packs art), the screen stack over the tabs, the toast.
import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { store, useStore } from "../lib/store";
import { BY_NUM, RECIPE, STARS, TIERS, type T } from "./data";
import { toastMsg } from "./state";
import type { Tier } from "../api";

export const cx = (...c: (string | false | null | undefined | 0)[]) => c.filter(Boolean).join(" ");
export const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

// ---------- photos ----------

/** Where each photo's robot is (data/photos/focus.json): the photo fills its window and the part cropped off is the part
    least likely to be the robot. */
let FOCUS: Record<string, [number, number]> = {};
fetch("/photos/focus.json").then((r) => (r.ok ? r.json() : {})).then((f) => { FOCUS = f || {}; }).catch(() => {});
function center(img: HTMLImageElement, num: number) {
  const f = FOCUS[num], w = img.naturalWidth, h = img.naturalHeight, box = img.parentElement?.getBoundingClientRect();
  if (!f || !w || !box?.width) return;
  const scale = Math.max(box.width / w, box.height / h), visW = box.width / (w * scale), visH = box.height / (h * scale);
  const pos = (c: number, vis: number) => (vis >= 1 ? 50 : Math.min(100, Math.max(0, ((c - vis / 2) / (1 - vis)) * 100)));
  img.style.objectPosition = `${pos(f[0], visW)}% ${pos(f[1], visH)}%`;
}

const nameScale = (n: string) => { const l = n.length; return l <= 12 ? 1 : l <= 15 ? 0.85 : l <= 19 ? 0.7 : l <= 24 ? 0.58 : 0.5; };

/** The card face: the team's ring and name, the robot photo, the strip with number, place and season, the Battler
    stats (dashes until they're imported), and the star scale and serial along the bottom. */
export function Face({ t, tier, serial }: { t: T; tier: Tier; serial?: number | string }) {
  const bt = t.bt;
  const sn = serial ? +serial : 0;
  const stat = (v?: number) => (bt ? <b>{v}</b> : <b class="na">–</b>);
  return (
    <div class="face front btf">
      <div class="inner v2 bt b2" style={{ "--nl": nameScale(t.name) }}>
        <div class="head"><span class="avatar none">{t.num}</span><span class="tname">{t.name}</span></div>
        <div class="fwrap">
          <div class="fphoto">
            {t.photo
              ? <span class="phw"><img class="ph" alt="" draggable={false} decoding="async" src={`/photos/${t.num}.webp`} onLoad={(e) => center(e.currentTarget, t.num)} /></span>
              : <span class="s-nophoto">#{t.num}</span>}
          </div>
          <div class="idbar"><span class="num">#{t.num}</span><span class="loc">{t.region || t.loc || t.div}</span><span class="yr">{RECIPE?.season ?? 2026}</span></div>
        </div>
        <div class="statrow"><div class="stat"><small>AUTO</small>{stat(bt?.auto)}</div><div class="stat"><small>TELE</small>{stat(bt?.tele)}</div><div class="stat"><small>END</small>{stat(bt?.end)}</div></div>
        <div class="rprow">{[0, 1, 2].map((i) => <div class="rp"><i>RP{i + 1}</i>{bt ? <b>{bt.rp[i]}%</b> : <b class="na">–</b>}</div>)}</div>
        <div class="effect"><small>UNIQUE EFFECT</small>{bt?.effect ? <p>{bt.effect}</p> : <p class="tbd">{bt ? "Effect coming soon" : "Stats and effect coming soon"}</p>}</div>
      </div>
      <div class="ftb">
        <span class="rar" aria-label={`${STARS[tier]} of 5 stars`}>{[0, 1, 2, 3, 4].map((i) => (i < STARS[tier] ? "★" : <i>★</i>))}</span>
        <span class={cx("sn", sn > 0 && sn <= 10 && "low", sn === t.num && "match")}>No. {serial || "------"}</span>
      </div>
    </div>
  );
}

/** A card lying flat: grids and rows. Cheap to draw many of. */
export function Card({ num, serial, w, children, cls }: { num: number; serial?: number | string; w: string; children?: ComponentChildren; cls?: string }) {
  const t = BY_NUM.get(num);
  if (!t) return null;
  return (
    <div class={cx("s-card", cls)} style={{ "--cw": w, "--tc": TIERS[t.tier].color }}>
      <div class="card" data-tier={t.tier}><Face t={t} tier={t.tier} serial={serial} /></div>
      {children}
    </div>
  );
}

/** A card you don't own yet: its rarity frame and who it is, not the card itself. */
export function Ghost({ num, w, children }: { num: number; w: string; children?: ComponentChildren }) {
  const t = BY_NUM.get(num)!;
  return (
    <div class={cx("s-ghost", `t-${t.tier}`)} style={{ "--cw": w }}>
      <b>{t.num}</b><span>{t.name}</span><small>{TIERS[t.tier].label}</small>
      {children}
    </div>
  );
}

/** The big card in the card view: it turns with your finger (or mouse) while you hold it and springs back when you
    let go. It never moves on its own. */
export function TiltCard({ num, serial, w }: { num: number; serial?: number | string; w: string }) {
  const t = BY_NUM.get(num)!;
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const slot = el.current!, tilt = slot.querySelector<HTMLElement>(".tilt")!, inner = slot.querySelector<HTMLElement>(".inner")!;
    const MAX = 20, GAIN = 0.3;
    const g = { held: false, id: 0, rx: 0, ry: 0, rawX: 0, rawY: 0, vx: 0, vy: 0, lx: 0, ly: 0, lt: 0, raf: 0 };
    const soft = (v: number) => MAX * Math.tanh(v / MAX);
    const paint = () => {
      tilt.style.setProperty("--ry", `${g.ry.toFixed(2)}deg`);
      tilt.style.setProperty("--rx", `${g.rx.toFixed(2)}deg`);
      inner.style.setProperty("--mx", (Math.max(0, Math.min(100, 50 + (g.ry / MAX) * 50))).toFixed(1));
      inner.style.setProperty("--my", (Math.max(0, Math.min(100, 50 - (g.rx / MAX) * 50))).toFixed(1));
    };
    const spring = () => {
      cancelAnimationFrame(g.raf);
      let last = performance.now();
      const step = (now: number) => {
        const dt = Math.min(0.032, (now - last) / 1000); last = now;
        g.vx += (-170 * g.rx - 15 * g.vx) * dt; g.vy += (-170 * g.ry - 15 * g.vy) * dt;
        g.rx += g.vx * dt; g.ry += g.vy * dt; g.rawX = g.rx; g.rawY = g.ry;
        paint();
        if (Math.abs(g.rx) + Math.abs(g.ry) + Math.abs(g.vx) + Math.abs(g.vy) > 0.06) g.raf = requestAnimationFrame(step);
        else { g.rx = g.ry = g.vx = g.vy = g.rawX = g.rawY = 0; paint(); slot.classList.remove("live"); }
      };
      g.raf = requestAnimationFrame(step);
    };
    const down = (e: PointerEvent) => {
      if (e.pointerType === "mouse" && e.button) return;
      g.held = true; g.id = e.pointerId; g.lx = e.clientX; g.ly = e.clientY; g.lt = performance.now(); g.vx = g.vy = 0;
      cancelAnimationFrame(g.raf);
      slot.classList.add("live");
      try { slot.setPointerCapture(e.pointerId); } catch { /* fine */ }
    };
    const move = (e: PointerEvent) => {
      if (!g.held || e.pointerId !== g.id) return;
      const now = performance.now(), dx = e.clientX - g.lx, dy = e.clientY - g.ly;
      g.lx = e.clientX; g.ly = e.clientY;
      g.rawY += dx * GAIN; g.rawX -= dy * GAIN;
      const ry = soft(g.rawY), rx = soft(g.rawX), dt = Math.max(8, now - g.lt) / 1000;
      g.lt = now; g.vy = (ry - g.ry) / dt; g.vx = (rx - g.rx) / dt; g.ry = ry; g.rx = rx;
      paint();
    };
    const up = (e: PointerEvent) => { if (!g.held || e.pointerId !== g.id) return; g.held = false; spring(); };
    slot.addEventListener("pointerdown", down);
    slot.addEventListener("pointermove", move);
    slot.addEventListener("pointerup", up);
    slot.addEventListener("pointercancel", up);
    slot.addEventListener("lostpointercapture", up);
    return () => { cancelAnimationFrame(g.raf); slot.removeEventListener("pointerdown", down); slot.removeEventListener("pointermove", move); slot.removeEventListener("pointerup", up); slot.removeEventListener("pointercancel", up); slot.removeEventListener("lostpointercapture", up); };
  }, []);
  return (
    <div ref={el} class="slot flipped s-tilt" style={{ "--cw": w, "--tc": TIERS[t.tier].color }}>
      <div class="float"><div class="tilt">
        <div class="flip card" data-tier={t.tier}>
          <Face t={t} tier={t.tier} serial={serial} />
        </div>
      </div></div>
    </div>
  );
}

// ---------- the screen stack ----------

/** Screens over the tabs (a card up close, a profile, settings). Each is a history entry, so the phone's back button or
    back swipe closes the top one instead of leaving the app. */
interface Layer { id: number; render: () => ComponentChildren; kind: "card" | "page" }
export const layers = store<Layer[]>([]);
let layerN = 0;

export function push(render: () => ComponentChildren, kind: Layer["kind"] = "page") {
  const l = { id: ++layerN, render, kind };
  layers.set([...layers.get(), l]);
  try { history.pushState({ layer: l.id }, ""); } catch { /* fine */ }
}
/** Swaps the top screen for another (no new history entry). */
export function replace(render: () => ComponentChildren, kind: Layer["kind"] = "page") {
  const ls = layers.get();
  if (!ls.length) return push(render, kind);
  layers.set([...ls.slice(0, -1), { id: ++layerN, render, kind }]);
}
/** One screen back. */
export function back() {
  if (!layers.get().length) return;
  if (history.state?.layer) history.back();
  else layers.set(layers.get().slice(0, -1));
}
/** Every screen at once, then `then`. */
export function closeAll(then?: () => void) {
  const n = layers.get().length;
  if (!n) return then?.();
  layers.set([]);
  const steps = history.state?.layer ? n : 0;
  if (steps) { afterPop = then ?? null; history.go(-steps); } else then?.();
}
let afterPop: (() => void) | null = null;
addEventListener("popstate", (e) => {
  const want = (e.state?.layer as number | undefined) ?? 0;
  const ls = layers.get();
  if (ls.length) layers.set(ls.filter((l) => l.id <= want));
  if (!layers.get().length && afterPop) { const f = afterPop; afterPop = null; f(); }
});

export function LayerHost() {
  const ls = useStore(layers);
  // The page behind doesn't scroll while a screen is open.
  useEffect(() => { document.body.classList.toggle("s-locked", ls.length > 0); }, [ls.length]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape" && layers.get().length) back(); };
    addEventListener("keydown", k);
    return () => removeEventListener("keydown", k);
  }, []);
  return (
    <>
      {ls.map((l, i) => (
        <div key={l.id} class={cx("s-layer", `k-${l.kind}`, i < ls.length - 1 && "under")} onClick={(e) => { if (e.target === e.currentTarget) back(); }}>
          {l.render()}
        </div>
      ))}
    </>
  );
}

export function ToastHost() {
  const t = useStore(toastMsg);
  const [last, setLast] = useState(t);
  useEffect(() => { if (t) setLast(t); }, [t]);
  return <div class={cx("s-toast", !!t && "show", last?.bad && "bad")} role="status" aria-live="polite">{last?.text}</div>;
}

export const Spinner = ({ small }: { small?: boolean }) => <span class={cx("s-spin", small && "small")} aria-hidden="true" />;

export function Tabs<V extends string>({ value, options, onChange }: { value: V; options: [V, ComponentChildren][]; onChange: (v: V) => void }) {
  return (
    <div class="s-tabs" role="tablist">
      {options.map(([v, label]) => <button type="button" role="tab" aria-selected={v === value} onClick={() => onChange(v)}>{label}</button>)}
    </div>
  );
}

export function Avatar({ name, big }: { name: string; big?: boolean }) {
  const ini = (name || "?").replace(/[^A-Za-z0-9]/g, "").slice(0, 2).toUpperCase() || "?";
  let h = 0;
  for (const c of name || "") h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return <span class={cx("s-av", big && "big")} style={{ "--h": h % 360 }}>{ini}</span>;
}
