// Sheets opened from a game: the menu, a robot up close, your bench, a pool. Each reads the live game, so it updates
// while open.
import { useState } from "preact/hooks";
import { CAT, closeSheet, openSheet, pref, setPref, toast, useStore } from "../store";
import { sfx } from "../sfx";
import type { GameView, RobotInst } from "../types";
import { Card, cx, RobotSheet } from "../ui";
import { openEmotes } from "./emotes";
import { act, game, powerFor, robotOf, setPartners, setStations } from "./state";

export function openMenu(g: GameView) {
  openSheet(() => <Menu g={g} />);
}

function Menu({ g }: { g: GameView }) {
  const [mute, setMute] = useState(pref("bt-mute"));
  const forfeit = () => {
    if (!confirm(g.status === "DECKS" ? "Leave this game? Nobody's rating changes." : "Forfeit this game? It counts as a loss.")) return;
    closeSheet();
    act({ kind: "forfeit" });
  };
  return (
    <div class="b-menusheet">
      <h2>Game</h2>
      <button type="button" class="b-btn ghost" onClick={() => openEmotes(g)}>Quick chat</button>
      <label class="b-check"><input type="checkbox" checked={mute} onChange={(e) => { setMute(e.currentTarget.checked); setPref("bt-mute", e.currentTarget.checked); }} /> Mute sounds</label>
      <p class="b-dim b-small">Fairness code <code>{g.seed_hash.slice(0, 16)}…</code>. The secret behind every shuffle and roll is shown when the game ends.</p>
      <button type="button" class="b-btn ghost danger" onClick={forfeit}>Forfeit</button>
    </div>
  );
}

/** Battery bar. A captain never runs down. */
export function Battery({ r, battery, broken, captain }: { r?: RobotInst; battery: number; broken: boolean; captain: boolean }) {
  if (captain) return <div class="b-batt cap"><span>Captain</span></div>;
  const lvl = broken ? "dead" : battery >= 50 ? "ok" : battery >= 25 ? "mid" : "low";
  return (
    <div class={cx("b-batt", lvl)} title={r ? `${battery}% battery` : undefined}>
      <i style={{ transform: `scaleX(${broken ? 1 : battery / 100})` }} />
      <span>{broken ? "Repairing" : battery < 50 ? `${battery}% · ${powerFor(battery)}%` : `${battery}%`}</span>
    </div>
  );
}

/** One of your robots in the pit: its card, and where it can go. */
export function openMyRobot(inst: number) {
  openSheet(() => <MyRobot inst={inst} />);
}

function MyRobot({ inst }: { inst: number }) {
  const g = useStore(game);
  if (!g?.me) return null;
  const r = robotOf(g, inst);
  if (!r) return null;
  const side = g.me.side;
  const live = g.status === "PIT" && !g.seats[side]!.locked;
  const st = g.me.plan.stations;
  const at = st.indexOf(inst);
  const captain = g.alliances[side][0] === inst;
  const move = (k: number) => {
    const n = [...st] as [number, number, number];
    [n[at], n[k]] = [n[k], n[at]];
    sfx.place();
    setStations(n);
  };
  return (
    <RobotSheet r={r}>
      {live && at >= 0 && (
        <div class="b-moves">
          <span class="b-dim b-small">Station</span>
          {[0, 1, 2].map((k) => <button type="button" class={cx("b-st", k === at && "on")} disabled={k === at} onClick={() => move(k)}>{k + 1}<small>{CAT.rp_names[k]}</small></button>)}
        </div>
      )}
      {live && !captain && <button type="button" class="b-btn wide" onClick={() => openBench(inst)}>Swap from bench</button>}
    </RobotSheet>
  );
}

/** Your pool: tap a robot to send it out in place of the highlighted partner. Changes apply as you tap. */
export function openBench(replace?: number) {
  openSheet(() => <Bench replace={replace} />, true);
}

function Bench({ replace }: { replace?: number }) {
  const g = useStore(game);
  const [slot, setSlot] = useState<number>(() => {
    const p = game.get()?.me?.plan.partners;
    return p && replace !== undefined && p[0] === replace ? 0 : 1;
  });
  if (!g?.me) return null;
  const side = g.me.side;
  const live = g.status === "PIT" && !g.seats[side]!.locked;
  const partners = g.me.plan.partners;
  const cap = robotOf(g, g.alliances[side][0]);
  const pool = g.seats[side]!.pool.map((i) => robotOf(g, i)!).filter(Boolean);
  const tap = (r: RobotInst) => {
    if (!live) return openSheet(() => <RobotSheet r={r} />);
    const at = partners.indexOf(r.inst);
    if (at >= 0) { setSlot(at); return; }
    if (r.broken) return toast(`${r.name} is being repaired.`, true);
    const n = [...partners] as [number, number];
    n[slot] = r.inst;
    sfx.place();
    setPartners(n);
    setSlot(1 - slot);
  };
  return (
    <div class="b-bench">
      <h2>{live ? "Your alliance" : "Your pool"}</h2>
      {live && cap && (
        <div class="b-slots">
          <div class="b-slot cap"><MiniPic r={cap} /><b>{cap.team}</b><small>Captain</small></div>
          {[0, 1].map((k) => { const r = robotOf(g, partners[k]); return <button type="button" class={cx("b-slot", slot === k && "sel")} onClick={() => setSlot(k)}>{r && <MiniPic r={r} />}<b>{r?.team ?? "?"}</b><small>{r ? `${r.battery}%` : ""}</small></button>; })}
        </div>
      )}
      <div class="b-minigrid">
        {pool.map((r) => {
          const on = partners.includes(r.inst);
          return (
            <button key={r.inst} type="button" class={cx("b-mini", on && "on", r.broken > 0 && "broken")} onClick={() => tap(r)}>
              <Card r={r} w="var(--mw)" />
              <Battery r={r} battery={r.battery} broken={r.broken > 0} captain={false} />
              {on && <span class="b-mini-tag">Playing</span>}
            </button>
          );
        })}
      </div>
      {live && <p class="b-dim b-small center">Playing drains {CAT.rules.drain}%. The bench recharges {CAT.rules.recharge}%.</p>}
    </div>
  );
}

const MiniPic = ({ r }: { r: RobotInst }) => (r.photo ? <img alt="" src={`/photos/${r.team}.webp`} /> : <span>{r.team}</span>);

/** The other player's drafted robots (public). */
export function openPool(who: number) {
  openSheet(() => <PoolSheet who={who} />, true);
}

function PoolSheet({ who }: { who: number }) {
  const g = useStore(game);
  if (!g) return null;
  const seat = g.seats[who]!;
  const cap = robotOf(g, g.alliances[who][0]);
  const list = [cap, ...seat.pool.map((i) => robotOf(g, i))].filter(Boolean) as RobotInst[];
  return (
    <div class="b-bench">
      <h2>{seat.name}'s robots</h2>
      <div class="b-minigrid">
        {list.map((r, i) => (
          <button key={r.inst} type="button" class={cx("b-mini", r.broken > 0 && "broken")} onClick={() => openSheet(() => <RobotSheet r={r} />)}>
            <Card r={r} w="var(--mw)" />
            <Battery r={r} battery={i === 0 ? 100 : r.battery} broken={r.broken > 0} captain={i === 0} />
          </button>
        ))}
      </div>
    </div>
  );
}
