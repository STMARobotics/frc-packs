// Shared pieces: robot cards (the same art as the FRC Packs cards), compact tiles, support cards, the sheet, the toast and
// the screen header.
import type { ComponentChildren, JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { CAT, closeSheet, sheet, toastMsg, useStore } from "./store";
import type { RobotCard, Support, SupportInst } from "./types";

export const TIER_ORDER = ["mythic", "legendary", "rare", "uncommon", "common"];
export const STARS: Record<string, number> = { common: 1, uncommon: 2, rare: 3, legendary: 4, mythic: 5 };
export const total = (s: RobotCard["stats"]) => s.auto + s.tele + s.end;
export const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;
export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

const nameScale = (n: string) => { const l = n.length; return l <= 12 ? 1 : l <= 15 ? 0.85 : l <= 19 ? 0.7 : l <= 24 ? 0.58 : 0.5; };

export function Photo({ team, has, cls }: { team: number; has: boolean; cls?: string }) {
  return has ? <img class={cls} alt="" draggable={false} decoding="async" src={`/photos/${team}.webp`} /> : <span class={cx(cls, "b-nophoto")}>{team}</span>;
}

/** The full robot card, drawn flat: the pack card's art without its 3D layers, so a screen full of them stays cheap.
    `w` is any CSS length. */
export function Card({ r, w, cls, children }: { r: RobotCard; w: string; cls?: string; children?: ComponentChildren }) {
  const s = r.stats;
  return (
    <div class={cx("b-card", cls)} style={{ "--cw": w }}>
      <div class="card" data-tier={r.tier}>
        <div class="face front btf">
          <div class="inner v2 bt b2" style={{ "--nl": nameScale(r.name) }}>
            <div class="head"><span class="avatar none">{r.team}</span><span class="tname">{r.name}</span></div>
            <div class="fwrap">
              <div class="fphoto">
                {r.photo ? <span class="phw"><img class="ph" alt="" draggable={false} decoding="async" src={`/photos/${r.team}.webp`} /></span> : <span class="b-nophoto big">#{r.team}</span>}
                {r.test_stats && <span class="b-teststats">Test stats</span>}
              </div>
              <div class="idbar"><span class="num">#{r.team}</span><span class="loc">{r.region}</span><span class="yr">{CAT?.season ?? 2026}</span></div>
            </div>
            <div class="statrow">
              <div class="stat"><small>AUTO</small><b>{s.auto}</b></div>
              <div class="stat"><small>TELE</small><b>{s.tele}</b></div>
              <div class="stat"><small>END</small><b>{s.end}</b></div>
            </div>
            <div class="rprow">{s.rp.map((p, i) => <div class="rp"><i>RP{i + 1}</i><b>{p}%</b></div>)}</div>
            <div class="effect"><small>UNIQUE EFFECT</small>{r.effect_text ? <p>{r.effect_text}</p> : <p class="tbd">No effect yet</p>}</div>
          </div>
          <div class="ftb">
            <span class="rar" aria-label={`${STARS[r.tier] ?? 1} of 5 stars`}>{[0, 1, 2, 3, 4].map((i) => (i < (STARS[r.tier] ?? 1) ? "★" : <i>★</i>))}</span>
            <span class="sn">{r.tier.toUpperCase()}</span>
          </div>
        </div>
      </div>
      {children}
    </div>
  );
}

/** A face-down card. */
export const CardBack = () => <div class="b-back"><i /></div>;

/** A compact robot row: lists, the deck builder, pickers. */
export function Tile({ r, sel, off, onClick, children }: { r: RobotCard; sel?: boolean; off?: boolean; onClick?: () => void; children?: ComponentChildren }) {
  const s = r.stats;
  return (
    <div class={cx("b-tile", `t-${r.tier}`, sel && "sel", off && "off")} onClick={onClick} role={onClick ? "button" : undefined} tabIndex={onClick ? 0 : undefined} onKeyDown={onClick ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } } : undefined}>
      <Photo team={r.team} has={r.photo} cls="b-tile-pic" />
      <div class="b-tile-m">
        <div class="b-tile-name"><b>{r.team}</b> {r.name}</div>
        <div class="b-tile-stats"><span>A <b>{s.auto}</b></span><span>T <b>{s.tele}</b></span><span>E <b>{s.end}</b></span></div>
      </div>
      {children && <div class="b-tile-r">{children}</div>}
    </div>
  );
}

export function SupportCard({ c, sel, children, onClick }: { c: Support | SupportInst; sel?: boolean; children?: ComponentChildren; onClick?: () => void }) {
  return (
    <div class={cx("b-sup", c.kind === "LORE" ? "lore" : "part", sel && "sel")} onClick={onClick}>
      <div class="b-sup-k">{c.kind === "PART" ? c.tags.map((t) => t.replace("_", " ")).join(" · ") : "Lore · whole field"}</div>
      <div class="b-sup-n">{c.name}</div>
      <div class="b-sup-t">{c.text}</div>
      {children}
    </div>
  );
}

export function Stepper({ n, minus, plus, canPlus }: { n: number; minus: () => void; plus: () => void; canPlus: boolean }) {
  return (
    <span class="b-stepper" onClick={(e) => e.stopPropagation()}>
      <button type="button" onClick={minus} disabled={!n} aria-label="One fewer">−</button>
      <b>{n}</b>
      <button type="button" onClick={plus} disabled={!canPlus} aria-label="One more">+</button>
    </span>
  );
}

export function Head({ title, back = "#home", children }: { title: ComponentChildren; back?: string | (() => void); children?: ComponentChildren }) {
  return (
    <header class="b-head">
      {typeof back === "string" ? <a class="b-iconbtn" href={back} aria-label="Back">‹</a> : <button type="button" class="b-iconbtn" onClick={back} aria-label="Back">‹</button>}
      <h1>{title}</h1>
      {children}
    </header>
  );
}

export function Tabs<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div class="b-tabs" role="tablist">
      {options.map(([v, label]) => <button type="button" role="tab" aria-selected={v === value} onClick={() => onChange(v)}>{label}</button>)}
    </div>
  );
}

export const Empty = ({ children }: { children: ComponentChildren }) => <div class="b-empty">{children}</div>;
export const Spinner = ({ small }: { small?: boolean }) => <span class={cx("b-spin", small && "small")} aria-hidden="true" />;

// ---------- the sheet ----------

/** The bottom drawer. It slides up when opened and down when closed; what's inside re-renders with the app. */
export function SheetHost() {
  const s = useStore(sheet);
  const [shown, setShown] = useState(s);
  const [out, setOut] = useState(false);
  const inner = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (s) { setShown(s); setOut(false); document.body.classList.add("b-noscroll"); return; }
    if (!shown) return;
    setOut(true);
    document.body.classList.remove("b-noscroll");
    const t = setTimeout(() => { setShown(null); setOut(false); }, 200);
    return () => clearTimeout(t);
  }, [s]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape" && sheet.get()) closeSheet(); };
    addEventListener("keydown", k);
    return () => removeEventListener("keydown", k);
  }, []);
  // A new sheet starts at the top.
  useEffect(() => { if (inner.current) inner.current.scrollTop = 0; }, [shown?.key]);
  if (!shown) return null;
  return (
    <div class={cx("b-sheet", out && "out")} onClick={(e) => { if (e.target === e.currentTarget) closeSheet(); }}>
      <div class={cx("b-sheet-in", shown.wide && "wide")} ref={inner} role="dialog" aria-modal="true">
        <span class="b-grip" aria-hidden="true" />
        <button type="button" class="b-x" onClick={closeSheet} aria-label="Close">×</button>
        {(s ?? shown).render()}
      </div>
    </div>
  );
}

export function ToastHost() {
  const t = useStore(toastMsg);
  const [last, setLast] = useState(t);
  useEffect(() => { if (t) setLast(t); }, [t]);
  return <div class={cx("b-toast", !!t && "show", last?.bad && "bad")} role="status" aria-live="polite">{last?.text}</div>;
}

/** Shows a robot's full card in the sheet. */
export function RobotSheet({ r, children }: { r: RobotCard; children?: ComponentChildren }) {
  return (
    <div class="b-detail">
      <Card r={r} w="min(300px, calc(100vw - 72px))" />
      {r.effect_test && <p class="b-dim b-small">The effect is a test example.</p>}
      {children}
    </div>
  );
}

export type Click = JSX.TargetedMouseEvent<HTMLElement>;
