// The match: them at the top, you at the bottom, the three driver stations as columns between you, the Lore slots and
// the tug-of-war bar across the middle, your hand along the bottom.
//
// In the Pit you tap a card then a robot (or drag it there), drag your robots between stations, and lock in. When both
// players have locked, the same screen plays the reveal. Every robot and card is keyed by its id, so a card stays the
// same element while it moves, flips or scores, and a robot that changes station slides there.
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { CAT, openSheet } from "../store";
import { sfx } from "../sfx";
import type { GameView, RobotInst, RobotScore, RoundLog, SupportInst } from "../types";
import { Card, CardBack, cx, plural, RobotSheet } from "../ui";
import { Clock, Ring } from "./clock";
import { initial } from "./final";
import { type Reveal, useReveal } from "./reveal";
import { Battery, openBench, openMenu, openMyRobot, openPool } from "./sheets";
import { attach, cardOf, detach, lock, playLore, powerFor, robotOf, scaled, setStations } from "./state";

export function Arena({ g, log, onNext }: { g: GameView; log: RoundLog | null; onNext: () => void }) {
  const side = g.me!.side, op = 1 - side;
  const me = g.seats[side]!, them = g.seats[op]!;
  const plan = g.me!.plan;
  const pit = !log;
  const live = pit && g.status === "PIT" && !me.locked;
  const [rv, skip] = useReveal(g, log);
  const [sel, setSel] = useState<number | null>(null);
  const [lifted, setLifted] = useState<number | null>(null);
  const [dragKind, setDragKind] = useState<"" | "part" | "lore" | "bot">("");
  const board = useRef<HTMLDivElement>(null);

  // A new round, or the reveal starting, drops whatever was in your hand.
  useEffect(() => { setSel(null); }, [g.round, pit, me.locked]);
  const selCard = sel !== null && live ? cardOf(g, sel) : undefined;

  const captains = [g.alliances[0][0], g.alliances[1][0]];
  const myBots = log ? log.stations[side] : plan.stations;
  const theirBots = log ? log.stations[op] : null;
  const score = (inst: number) => log?.result.robots.find((x) => x.inst === inst);
  const partsOn = (s: number, inst: number) =>
    (log ? log.attach[s] : s === side ? plan.attach : []).filter(([, rb]) => rb === inst).map(([p]) => cardOf(g, p)).filter((c): c is SupportInst => !!c);

  const planned = new Set([...plan.attach.map(([p]) => p), ...(plan.lore !== null ? [plan.lore] : [])]);
  const hand = pit ? g.me!.hand.map((i) => cardOf(g, i)).filter((c): c is SupportInst => !!c && !planned.has(c.inst)) : [];
  const myLore = log ? cardOf(g, log.lore[side]) : cardOf(g, plan.lore);
  const theirLore = log ? cardOf(g, log.lore[op]) : undefined;

  // RP: during the reveal the round's RP is added as it's won.
  const gained = log && rv && log.round === g.rounds[g.rounds.length - 1]?.round
    ? [log.result.match_rp[side] + log.result.bonus_rp[side] - rv.rp[0], log.result.match_rp[op] + log.result.bonus_rp[op] - rv.rp[1]]
    : [0, 0];

  // ---------- taps ----------
  const tapCard = (inst: number) => { if (!live) return; setSel(sel === inst ? null : inst); if (sel !== inst) sfx.pick(); };
  const tapBot = (inst: number, mine: boolean) => {
    if (mine && live && selCard?.kind === "PART") { sfx.place(); setSel(null); attach(selCard.inst, inst); return; }
    if (mine && live) return openMyRobot(inst);
    const r = robotOf(g, inst);
    if (r) openSheet(() => <RobotSheet r={r} />);
  };
  const tapLore = () => {
    if (live && selCard?.kind === "LORE") { sfx.place(); setSel(null); playLore(selCard.inst); }
  };
  const swap = (inst: number, lane: number) => {
    const st = [...plan.stations] as [number, number, number];
    const cur = st.indexOf(inst);
    if (cur < 0 || cur === lane) return;
    [st[cur], st[lane]] = [st[lane], st[cur]];
    sfx.place();
    setStations(st);
  };

  // ---------- dragging: a card onto a robot or the Lore slot, or a robot onto another station ----------
  const startDrag = (e: PointerEvent, what: "card" | "bot", inst: number) => {
    if (!live || (e.pointerType === "mouse" && e.button)) return;
    const src = e.currentTarget as HTMLElement;
    const kind = what === "bot" ? "bot" : cardOf(g, inst)?.kind === "LORE" ? "lore" : "part";
    const x0 = e.clientX, y0 = e.clientY;
    let ghost: HTMLElement | null = null, over: HTMLElement | null = null, raf = 0, px = 0, py = 0;
    const sel = kind === "bot" ? "[data-lane]" : kind === "part" ? "[data-drop-bot]" : "[data-drop-lore]";
    const paint = () => {
      raf = 0;
      if (!ghost) return;
      ghost.style.transform = `translate3d(${px - ghost.offsetWidth / 2}px, ${py - ghost.offsetHeight * 0.65}px, 0) rotate(-3deg) scale(1.04)`;
      const t = (document.elementFromPoint(px, py) as HTMLElement | null)?.closest<HTMLElement>(sel) ?? null;
      if (t !== over) { over?.classList.remove("over"); t?.classList.add("over"); over = t; }
    };
    const move = (ev: PointerEvent) => {
      px = ev.clientX; py = ev.clientY;
      if (!ghost) {
        if (Math.hypot(px - x0, py - y0) < 8) return;
        const face = (what === "bot" ? src.querySelector<HTMLElement>(".b-bot-card") : src) ?? src;
        const r = face.getBoundingClientRect();
        ghost = face.cloneNode(true) as HTMLElement;
        ghost.classList.add("b-ghost");
        ghost.style.width = `${r.width}px`;
        ghost.style.height = `${r.height}px`;
        document.body.appendChild(ghost);
        setLifted(inst);
        setDragKind(kind);
        setSel(null);
        sfx.pick();
      }
      ev.preventDefault();
      if (!raf) raf = requestAnimationFrame(paint);
    };
    const up = () => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
      removeEventListener("pointercancel", up);
      cancelAnimationFrame(raf);
      if (!ghost) return; // a tap: the click handler takes it
      ghost.remove();
      setLifted(null);
      setDragKind("");
      // Swallow the click that follows a drag.
      const swallow = (c: Event) => { c.stopPropagation(); c.preventDefault(); };
      addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => removeEventListener("click", swallow, { capture: true }), 80);
      const t = over;
      over?.classList.remove("over");
      if (!t) return;
      if (kind === "bot") swap(inst, +t.dataset.lane!);
      else if (kind === "part") { sfx.place(); attach(inst, +t.dataset.dropBot!); }
      else { sfx.place(); playLore(inst); }
    };
    addEventListener("pointermove", move, { passive: false });
    addEventListener("pointerup", up);
    addEventListener("pointercancel", up);
  };

  // A big score shakes the board.
  useEffect(() => {
    if (!rv?.shake || !board.current) return;
    board.current.animate([{ transform: "translate(-4px,2px)" }, { transform: "translate(4px,-2px)" }, { transform: "translate(-2px,1px)" }, { transform: "none" }], { duration: 320 });
  }, [rv?.shake]);

  const tired = live ? (g.alliances[side].slice(1).map((i) => robotOf(g, i)).filter((r) => r && r.battery < 50) as RobotInst[]) : [];
  const verdict = log && rv?.verdict ? (log.result.winner === null ? "tie" : log.result.winner === side ? "win" : "loss") : null;
  const lastRound = log && log.round >= g.rounds_total;

  return (
    <div class={cx("b-arena", pit ? "pit" : "reveal", dragKind && `drag-${dragKind}`, selCard && `sel-${selCard.kind.toLowerCase()}`)}>
      {/* them */}
      <div class={cx("b-pbar op", pit && them.locked && "ready")}>
        <span class="b-ava op">{initial(them.name)}</span>
        <div class="b-who"><b>{them.name}</b><small>{pit ? (them.locked ? <em class="ok">Locked in</em> : "Choosing…") : `${them.elo} Elo`}</small></div>
        <div class="b-theirs" aria-label={plural(them.hand_count, "card")}>
          <span class="b-backs">{Array.from({ length: Math.min(them.hand_count, 7) }, (_, i) => <i key={i} />)}</span>
          {pit && (them.parts_down > 0 || them.lore_down) && <span class="b-down">{Array.from({ length: them.parts_down }, (_, i) => <i key={`p${i}`} class="part" />)}{them.lore_down && <i class="lore" />}</span>}
        </div>
        <button type="button" class="b-chipbtn" onClick={() => openPool(op)}>Pool</button>
        <div class="b-rp"><b>{them.rp - gained[1]}</b><small>RP</small></div>
      </div>

      <div class="b-round">
        <span class="b-dots">{Array.from({ length: g.rounds_total }, (_, i) => <i class={cx(i + 1 < g.round || (i + 1 === g.round && !pit) ? "done" : i + 1 === g.round && "now")} />)}</span>
        <span>Round {log?.round ?? g.round}/{g.rounds_total}</span>
        <Clock g={g} />
      </div>

      {/* the board */}
      <div class="b-board" ref={board} onClick={(e) => { if (e.target === e.currentTarget) setSel(null); }}>
        {[0, 1, 2].map((k) => <div key={`lane${k}`} class="b-lane" data-lane={live ? k : undefined} style={{ gridColumn: k + 1 }} onClick={() => setSel(null)} />)}
        {[0, 1, 2].map((k) => (
          <div key={`st${k}`} class="b-station" style={{ gridColumn: k + 1 }}>
            {rv && log ? <LaneScore log={log} rv={rv} lane={k} side={side} /> : <><b>{k + 1}</b><small>{CAT.rp_names[k]}</small></>}
          </div>
        ))}
        {[0, 1, 2].map((k) => {
          const inst = theirBots?.[k];
          const r = robotOf(g, inst);
          if (!r || !rv) return <div key={`back${k}`} class="b-bot theirs closed" data-lane={live ? k : undefined} style={{ gridColumn: k + 1, gridRow: 1 }}><div class="b-bot-card"><CardBack /></div><div class="b-bot-info none" /></div>;
          return <Bot key={r.inst} g={g} r={r} lane={k} row={1} mine={false} captain={r.inst === captains[op]} parts={partsOn(op, r.inst)} score={score(r.inst)} rv={rv} onTap={() => tapBot(r.inst, false)} />;
        })}
        {[0, 1, 2].map((k) => {
          const r = robotOf(g, myBots[k]);
          if (!r) return null;
          return (
            <Bot key={r.inst} g={g} r={r} lane={k} row={3} mine captain={r.inst === captains[side]} parts={partsOn(side, r.inst)} score={score(r.inst)} rv={rv}
              live={live} target={selCard?.kind === "PART"} lifted={lifted === r.inst}
              onTap={() => tapBot(r.inst, true)} onDetach={live ? (p) => { sfx.pick(); detach(p); } : undefined}
              onDown={live ? (e) => startDrag(e, "bot", r.inst) : undefined} />
          );
        })}
        {rv?.banner && <b key={rv.banner.n} class="b-banner">{rv.banner.text}</b>}
        {rv && rv.auto > 0 && <div class="b-autoclock"><b>AUTO</b><span>0:0{rv.auto}</span></div>}
      </div>

      {/* Lore and the tug of war */}
      <div class="b-mid">
        <LoreSlot c={theirLore} who="op" shown={!!rv?.lore} />
        <div class="b-tug" style={{ "--tug": rv ? `${rv.totals[0] + rv.totals[1] ? (rv.totals[0] / (rv.totals[0] + rv.totals[1])) * 100 : 50}%` : "50%" }}>
          <i />
          {rv && <span><b class="me">{rv.totals[0]}</b><b class="op">{rv.totals[1]}</b></span>}
        </div>
        <LoreSlot c={myLore} who="me" shown={pit || !!rv?.lore} live={live} target={selCard?.kind === "LORE"} onTap={tapLore} onClear={live ? () => { sfx.pick(); playLore(null); } : undefined} />
      </div>

      {/* your hand, or the round's result */}
      {pit ? (
        <div class={cx("b-handarea", !live && "locked")}>
          {selCard ? <p class="b-hint"><b>{selCard.name}</b> {selCard.text}</p>
            : tired.length ? <button type="button" class="b-warnchip" onClick={() => openBench(tired[0].inst)}>⚡ {tired[0].team} at {tired[0].battery}%, plays at {powerFor(tired[0].battery)}%. Swap?</button>
            : <p class="b-hint" />}
          <Hand cards={hand} sel={sel} lifted={lifted} live={live} onTap={tapCard} onDown={(e, i) => startDrag(e, "card", i)} />
          <span class="b-pile" aria-label={`${me.pile_count} cards in your deck`}>{me.pile_count}</span>
        </div>
      ) : (
        <div class={cx("b-verdict", verdict, verdict && "show")}>
          {verdict ? <>
            <b>{verdict === "win" ? "Round won" : verdict === "loss" ? "Round lost" : "Tied round"}</b>
            <span>{log!.result.totals[side]}–{log!.result.totals[op]} · +{rv!.rp[0]} RP</span>
            {log!.result.events.length > 0 && <button type="button" class="b-link small" onClick={() => openSheet(() => <Events log={log!} />)}>What triggered ({log!.result.events.length})</button>}
          </> : <span class="b-dim">Scoring…</span>}
        </div>
      )}

      {/* you */}
      <div class={cx("b-pbar me", pit && me.locked && "ready")}>
        <span class="b-ava me">{initial(me.name)}{pit && <Ring g={g} />}</span>
        <div class="b-rp"><b>{me.rp - gained[0]}</b><small>RP</small></div>
        <button type="button" class="b-chipbtn" onClick={() => openBench()}>Bench</button>
        {pit
          ? live
            ? <button type="button" class="b-go" onClick={() => { sfx.lock(); setSel(null); lock(); }}>Lock in</button>
            : <div class="b-waiting">{them.locked ? "Revealing…" : `Waiting for ${them.name}`}</div>
          : rv?.done
            ? <button type="button" class="b-go" disabled={g.status === "RESULTS" && me.acked} onClick={onNext}>{g.status === "RESULTS" && me.acked ? (them.acked ? "…" : `Waiting for ${them.name}`) : lastRound ? "Final result" : "Next round"}</button>
            : <button type="button" class="b-go ghost" onClick={skip}>Skip</button>}
        <button type="button" class="b-iconbtn" onClick={() => openMenu(g)} aria-label="Menu">⋯</button>
      </div>
      {!pit && g.status === "RESULTS" && them.acked && !me.acked && <span class="b-oppready">{them.name} is ready</span>}
    </div>
  );
}

// ---------- a robot on the board ----------

interface BotProps {
  g: GameView; r: RobotInst; lane: number; row: number; mine: boolean; captain: boolean; parts: SupportInst[]; score?: RobotScore; rv: Reveal | null;
  live?: boolean; target?: boolean; lifted?: boolean; onTap: () => void; onDetach?: (part: number) => void; onDown?: (e: PointerEvent) => void;
}

function Bot({ r, lane, row, mine, captain, parts, score, rv, live, target, lifted, onTap, onDetach, onDown }: BotProps) {
  const el = useRef<HTMLDivElement>(null);
  const last = useRef<number | null>(null);
  // Changing station slides the robot to its new column instead of jumping there.
  useLayoutEffect(() => {
    const n = el.current;
    if (!n) return;
    const x = n.getBoundingClientRect().left;
    if (last.current !== null && Math.abs(last.current - x) > 2) n.animate([{ transform: `translateX(${last.current - x}px)` }, { transform: "none" }], { duration: 280, easing: "cubic-bezier(.2,.9,.3,1.1)" });
    last.current = x;
  }, [lane]);

  const open = mine ? 2 : rv ? rv.open[lane] : 0;
  const s = r.stats;
  const base = [s.auto, s.tele, s.end];
  const power = score ? score.power : powerFor(r.battery);
  const shown = (k: number): string => {
    if (rv) { const p = rv.pts[r.inst]?.[k]; return p === null || p === undefined ? "–" : String(p); }
    return String(mine && !captain ? scaled(base[k], power) : base[k]);
  };
  const grade = (k: number) => {
    if (!rv || !score || !rv.graded[r.inst]?.[k]) return rv?.pts[r.inst]?.[k] != null ? "lit" : "";
    return score.points[k] > score.base[k] ? "lit up" : score.points[k] < score.base[k] ? "lit down" : "lit";
  };
  const broke = !!rv?.broke.includes(r.inst);
  const die = rv?.dice[r.inst];
  const battery = rv?.done ? r.battery : score ? score.battery : r.battery;
  const brokenNow = rv?.done ? r.broken > 0 : !score && r.broken > 0;
  return (
    <div ref={el} class={cx("b-bot", mine ? "mine" : "theirs", open === 0 ? "closed" : open === 1 ? "opening" : "open", target && "target", lifted && "lifted", broke && "broke")}
      style={{ gridColumn: lane + 1, gridRow: row }} data-drop-bot={live && mine ? r.inst : undefined} data-lane={live ? lane : undefined}
      onClick={onTap} onPointerDown={onDown as never}>
      <div class="b-bot-card">
        <Card r={r} w="var(--lw)" />
        {!mine && open < 2 && <div class="b-bot-back"><CardBack /></div>}
        {captain && <i class="b-cap" title="Alliance Captain">C</i>}
        {parts.length > 0 && (!rv || rv.parts) && (
          <div class="b-parts">{parts.map((p) => <span key={p.inst} class={cx("b-part", onDetach && "x")} title={p.text} onClick={onDetach ? (e) => { e.stopPropagation(); onDetach(p.inst); } : undefined}>{p.name}</span>)}</div>
        )}
        {die && <span class={cx("b-die", die.s)}>{die.t}</span>}
        {broke && <span class="b-broke">BREAKDOWN</span>}
        {rv?.floats.filter((f) => f.inst === r.inst).map((f) => <span key={f.id} class={cx("b-float", f.who)}>{f.text}</span>)}
      </div>
      <div class={cx("b-bot-info", open === 0 && "none")}>
        <div class="b-ph3">
          {[0, 1, 2].map((k) => <span class={grade(k)}><small>{"ATE"[k]}</small><b>{shown(k)}</b></span>)}
          <span class="rpc"><small>RP{lane + 1}</small><b>{score ? score.rp_chance : s.rp[lane]}%</b></span>
        </div>
        <Battery r={r} battery={battery} broken={brokenNow} captain={captain} />
      </div>
    </div>
  );
}

function LaneScore({ log, rv, lane, side }: { log: RoundLog; rv: Reveal; lane: number; side: number }) {
  const sum = (s: number) => (rv.pts[log.stations[s][lane]] ?? []).reduce<number>((a, b) => a + (b ?? 0), 0);
  return <span class="b-lanescore"><i class="op">{sum(1 - side)}</i><i class="me">{sum(side)}</i></span>;
}

function LoreSlot({ c, who, shown, live, target, onTap, onClear }: { c?: SupportInst; who: "me" | "op"; shown: boolean; live?: boolean; target?: boolean; onTap?: () => void; onClear?: () => void }) {
  if (!c) {
    if (who === "op") return <div class="b-lore op empty" />;
    return <div class={cx("b-lore me empty", target && "target")} data-drop-lore={live ? "" : undefined} onClick={onTap}><span>{live ? (target ? "Play Lore here" : "Lore") : "No Lore"}</span></div>;
  }
  return (
    <div class={cx("b-lore", who, "full", !shown && "hidden")} onClick={onTap}>
      <b>{c.name}</b><span>{c.text}</span>
      {onClear && <button type="button" class="b-lore-x" onClick={(e) => { e.stopPropagation(); onClear(); }} aria-label="Take back">×</button>}
    </div>
  );
}

// ---------- your hand ----------

function Hand({ cards, sel, lifted, live, onTap, onDown }: { cards: SupportInst[]; sel: number | null; lifted: number | null; live: boolean; onTap: (i: number) => void; onDown: (e: PointerEvent, inst: number) => void }) {
  const n = cards.length;
  const mid = (n - 1) / 2;
  // The fan spreads to fit the screen; cards overlap more the more there are.
  const step = Math.min(84, n > 1 ? (Math.min(innerWidth, 520) - 150) / (n - 1) : 0);
  if (!n) return <div class="b-hand empty"><span class="b-dim b-small">{live ? "No cards left" : ""}</span></div>;
  return (
    <div class="b-hand">
      {cards.map((c, i) => {
        const d = i - mid;
        return (
          <button key={c.inst} type="button" class={cx("b-hcard", c.kind === "LORE" ? "lore" : "part", sel === c.inst && "sel", lifted === c.inst && "lifted")}
            style={{ "--x": `${d * step}px`, "--r": `${d * Math.min(5, 20 / n)}deg`, "--y": `${d * d * 2.5}px`, "--i": i }}
            onClick={() => onTap(c.inst)} onPointerDown={(e) => onDown(e as unknown as PointerEvent, c.inst)} aria-label={`${c.name}: ${c.text}`}>
            <span class="k">{c.kind === "PART" ? c.tags.map((t) => t.replace("_", " ")).join(" · ") : "Lore"}</span>
            <b>{c.name}</b>
            <span class="t">{c.text}</span>
          </button>
        );
      })}
    </div>
  );
}

function Events({ log }: { log: RoundLog }) {
  return (
    <div class="b-events">
      <h2>Round {log.round}: what triggered</h2>
      <ul>{log.result.events.map((ev) => <li><b>{ev.source}</b> {ev.text}</li>)}</ul>
    </div>
  );
}
