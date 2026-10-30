import { openSheet, useStore } from "../store";
import type { GameView, ScheduledMatch } from "../types";
import { cx, RobotSheet } from "../ui";
import { Clock } from "./clock";
import { ack, act, game, robotOf } from "./state";

export function openSchedule() {
  openSheet(() => <LiveSchedule />, true);
}

function LiveSchedule() {
  const g = useStore(game);
  return g ? <Schedule g={g} review /> : null;
}

/** The first screen after both decks are picked, and a reference throughout the game. */
export function Schedule({ g, review = false }: { g: GameView; review?: boolean }) {
  const side = g.me?.side;
  const ready = side !== undefined && g.seats[side]!.acked;
  const opponent = side === undefined ? null : g.seats[1 - side];
  const starting = g.status === "SCHEDULE" && !review;
  return (
    <section class="b-schedule" aria-label="Match schedule">
      <header class="b-schedule-head">
        <div><span class="b-eyebrow">{g.rounds_total} matches · your robots, your alliance</span><h1>Match schedule</h1></div>
        {starting && <Clock g={g} />}
      </header>
      <p class="b-dim b-small">Your captain plays every match. Your other robots are paired at random, each playing once.</p>
      <div class="b-schedule-players">
        {[0, 1].map((s) => <div class={s === 0 ? "red" : "blue"} key={s}><small>{s === 0 ? "Red" : "Blue"} alliance</small><b>{g.seats[s]?.name}{s === side ? " (you)" : ""}</b></div>)}
      </div>
      <ol class="b-schedule-list">
        {g.schedule.map((match) => <Match key={match.round} g={g} match={match} />)}
      </ol>
      <p class="b-schedule-note">Win estimates use the scheduled robots’ base stats. Effects, Parts, Lore and breakdowns can change the result.</p>
      {g.schedule.some((m) => m.prediction.test_stats) && <p class="b-schedule-note warn">Test stats are in use. These predictions are provisional.</p>}
      {starting && side !== undefined && (
        <div class="b-schedule-ready">
          <p role="status">{ready ? `Waiting for ${opponent?.name} to ready up` : opponent?.acked ? `${opponent.name} is ready` : "Both players ready up to begin."}</p>
          <button type="button" class="b-btn wide" disabled={ready} onClick={ack}>{ready ? "Ready · waiting for opponent" : "Ready for match 1"}</button>
          <button type="button" class="b-link danger" onClick={() => {
            if (confirm("Forfeit this game? It counts as a loss.")) act({ kind: "forfeit" });
          }}>Forfeit</button>
        </div>
      )}
    </section>
  );
}

function Match({ g, match: m }: { g: GameView; match: ScheduledMatch }) {
  const result = g.rounds.find((r) => r.round === m.round)?.result;
  const current = m.round === g.round && !result;
  const red = Math.round(m.prediction.win_chance[0] * 1000) / 10;
  const chances = [red, Math.round((100 - red) * 10) / 10];
  const tag = result ? result.winner === null ? "Tied" : `${result.winner === 0 ? "Red" : "Blue"} won` : current ? "In progress" : "";
  return (
    <li class={cx("b-scheduled-match", current && "current")} aria-current={current ? "step" : undefined}>
      <header><h2>Match {m.round}</h2><span>{tag}</span></header>
      <div class="b-match-alliances">
        {[0, 1].map((s) => (
          <div key={s} class={s === 0 ? "red" : "blue"}>
            <div class="b-match-robots">
              {m.alliances[s].map((inst, k) => {
                const r = robotOf(g, inst);
                return <button key={inst} type="button" aria-label={r ? `Team ${r.team}, ${r.name}${k === 0 ? ', captain' : ''}` : "Robot"}
                  title={r?.name} onClick={() => r && openSheet(() => <RobotSheet r={r} />)}>
                  {r?.photo && <img src={`/photos/${r.team}.webp`} alt="" loading="lazy" />}
                  <b>{r?.team ?? "?"}</b>{k === 0 && <small title="Captain">C</small>}
                </button>;
              })}
            </div>
            <div class="b-match-chance"><strong>{chances[s].toFixed(1)}<small>%</small></strong><span>win chance</span></div>
            <span class="b-match-score">{result ? `${result.totals[s]} points scored` : `${m.prediction.scores[s]} projected points`}</span>
          </div>
        ))}
      </div>
      <div class="b-match-probability" role="img" aria-label={`Red win chance ${chances[0]} percent, blue win chance ${chances[1]} percent`}>
        <i style={{ width: `${chances[0]}%` }} /><i style={{ width: `${chances[1]}%` }} />
      </div>
    </li>
  );
}
