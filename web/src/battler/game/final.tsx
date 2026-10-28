import { useEffect } from "preact/hooks";
import { sfx } from "../sfx";
import type { GameView } from "../types";
import { cx } from "../ui";

export const initial = (name: string) => name.slice(0, 1).toUpperCase();

export function Versus({ g }: { g: GameView }) {
  const me = g.seats[g.me!.side]!, op = g.seats[1 - g.me!.side]!;
  return (
    <div class="b-vs">
      <div><span class="b-ava me">{initial(me.name)}</span><b>{me.name}</b><small>{me.elo} Elo</small></div>
      <i>VS</i>
      <div><span class="b-ava op">{initial(op.name)}</span><b>{op.name}</b><small>{op.elo} Elo</small></div>
    </div>
  );
}

export function Final({ g }: { g: GameView }) {
  const o = g.outcome!;
  const side = g.me!.side, op = 1 - side;
  const them = g.seats[op]!;
  const res = o.winner === null ? "draw" : o.winner === side ? "win" : "loss";
  const d = o.elo_after[side] - o.elo_before[side];
  useEffect(() => { (res === "win" ? sfx.win : res === "loss" ? sfx.lose : () => sfx.tick(3))(); }, []);
  const why = o.reason === "forfeit" ? (res === "win" ? `${them.name} forfeited.` : "You forfeited.")
    : o.reason === "timeout" ? (res === "win" ? `${them.name} ran out the timer.` : "You ran out the timer.") : "";
  return (
    <div class={cx("b-final", res)}>
      <h1>{res === "win" ? "Victory" : res === "loss" ? "Defeat" : "Draw"}</h1>
      {why && <p class="b-dim">{why}</p>}
      <div class="b-finalscore">
        <div><b>{o.rp[side]}</b><small>You</small></div>
        <span>–</span>
        <div><b>{o.rp[op]}</b><small>{them.name}</small></div>
      </div>
      <p class="b-dim b-small">Points {o.points[side]}–{o.points[op]}{o.rp[0] === o.rp[1] ? " (RP tied, so points decide)" : ""}</p>
      <div class={cx("b-elochange", d >= 0 ? "up" : "down")}>{o.elo_before[side]} → <b>{o.elo_after[side]}</b> Elo <span>{d >= 0 ? "+" : ""}{d}</span></div>
      {g.rounds.length > 0 && (
        <table class="b-rounds">
          <thead><tr><th>Round</th><th>You</th><th>{them.name}</th><th>RP</th></tr></thead>
          <tbody>
            {g.rounds.map((r) => (
              <tr class={r.result.winner === side ? "won" : r.result.winner === op ? "lost" : ""}>
                <td>{r.round}</td><td>{r.result.totals[side]}</td><td>{r.result.totals[op]}</td>
                <td>+{r.result.match_rp[side] + r.result.bonus_rp[side]} / +{r.result.match_rp[op] + r.result.bonus_rp[op]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div class="b-row2"><a class="b-btn" href="#play">Play again</a><a class="b-btn ghost" href="#home">Home</a></div>
      <details class="b-fair">
        <summary>Fairness check</summary>
        <p>Every shuffle and roll came from one secret number. Its SHA-256 was shown from the start:</p>
        <code>{g.seed_hash}</code>
        <p>The number:</p>
        <code>{g.seed}</code>
      </details>
    </div>
  );
}
