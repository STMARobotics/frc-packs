// The draft: three robots on offer, the player whose turn it is takes one, the other two go back in the pile. Swipe
// through the offer (the one in the middle is the one you'd take) or tap one; pools fill in below.
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { CAT, openSheet, preload } from "../store";
import { sfx } from "../sfx";
import type { GameView } from "../types";
import { Card, cx, Photo, RobotSheet } from "../ui";
import { Clock } from "./clock";
import { draftPick, robotOf } from "./state";
import { openMenu } from "./sheets";

export function Draft({ g }: { g: GameView }) {
  const side = g.me!.side, op = 1 - side;
  const mine = g.draft_side === side;
  const them = g.seats[op]!;
  const offer = g.offer.map((i) => robotOf(g, i)!).filter(Boolean);
  const [sel, setSel] = useState<number | null>(null);
  const row = useRef<HTMLDivElement>(null);
  const cur = sel !== null && g.offer.includes(sel) ? sel : g.offer[0] ?? null;
  const pick = cur !== null ? robotOf(g, cur) : undefined;

  useEffect(() => { preload(g.robots.map((r) => r.team), 3000); }, [g.id]);
  // A new offer starts on its first card.
  useLayoutEffect(() => { row.current?.scrollTo({ left: 0 }); setSel(g.offer[0] ?? null); }, [g.offer.join()]);
  useEffect(() => { if (mine) sfx.pick(); }, [mine, g.draft_turn]);

  // The card closest to the middle of the row is the selected one.
  const onScroll = () => {
    const el = row.current;
    if (!el) return;
    const mid = el.scrollLeft + el.clientWidth / 2;
    let best: number | null = null, dist = Infinity;
    el.querySelectorAll<HTMLElement>("[data-offer]").forEach((c) => {
      const d = Math.abs(c.offsetLeft + c.offsetWidth / 2 - mid);
      if (d < dist) { dist = d; best = +c.dataset.offer!; }
    });
    if (best !== null && best !== cur) setSel(best);
  };
  const tap = (inst: number, e: HTMLElement) => {
    if (inst === cur) return openSheet(() => <RobotSheet r={robotOf(g, inst)!} />);
    setSel(inst);
    sfx.pick();
    e.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
  };
  const take = () => { if (cur === null || !mine) return; sfx.place(); draftPick(cur); };

  return (
    <div class="b-draft">
      <header class="dr-head">
        <div><h1>Draft</h1><small>Pick {Math.min(g.draft_turn + 1, g.draft_total)} of {g.draft_total}</small></div>
        <Clock g={g} />
        <button type="button" class="b-iconbtn" onClick={() => openMenu(g)} aria-label="Menu">⋯</button>
      </header>
      <div class={cx("dr-turn", mine ? "mine" : "theirs")}>{mine ? "Your pick" : `${them.name} is picking`}</div>
      <div class="dr-offer" ref={row} onScroll={onScroll}>
        {offer.map((r) => (
          <button key={r.inst} type="button" data-offer={r.inst} class={cx("dr-opt", r.inst === cur && "sel")} onClick={(e) => tap(r.inst, e.currentTarget)} aria-label={`${r.team} ${r.name}`}>
            <Card r={r} w="var(--dw)" />
          </button>
        ))}
        {!offer.length && <div class="dr-none">…</div>}
      </div>
      <button type="button" class="b-btn wide big" onClick={take} disabled={!mine || !pick}>
        {mine && pick ? <>Draft <b>{pick.team}</b> {pick.name}</> : `Waiting for ${them.name}`}
      </button>
      <Pool g={g} who={side} label="You" />
      <Pool g={g} who={op} label={them.name} />
      <p class="b-dim b-small center">{g.pool_left} left in the pile</p>
    </div>
  );
}

function Pool({ g, who, label }: { g: GameView; who: number; label: string }) {
  const seat = g.seats[who]!;
  const n = CAT.rules.pool_size;
  return (
    <div class="dr-pool">
      <div class="dr-pool-h"><b>{label}</b><small>{seat.pool.length}/{n}</small></div>
      <div class="dr-chips">
        {Array.from({ length: n }, (_, i) => {
          const r = robotOf(g, seat.pool[i]);
          return r
            ? <button key={r.inst} type="button" class={cx("dr-chip", `t-${r.tier}`)} onClick={() => openSheet(() => <RobotSheet r={r} />)} aria-label={`${r.team} ${r.name}`}><Photo team={r.team} has={r.photo} /></button>
            : <i key={`e${i}`} class="dr-chip empty" />;
        })}
      </div>
    </div>
  );
}
