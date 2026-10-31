import { useEffect, useState } from "preact/hooks";
import { call } from "../api";
import { CAT, home, loadHome, openSheet, useStore } from "../store";
import type { LeaderboardPlayer } from "../types";
import { cx, plural, Spinner } from "../ui";

export function HomeScreen() {
  const h = useStore(home)!;
  useEffect(() => { loadHome().catch(() => {}); }, []);
  const p = h.profile;
  const ready = h.decks.filter((d) => !d.problems.length).length;
  return (
    <div class="b-home">
      {h.active && <a class="b-resume" href={`#game/${h.active}`}><b>Game in progress</b><span>Rejoin ›</span></a>}
      <section class="b-hello">
        <h1>{h.name}</h1>
        <div class="b-record">
          <span><b>{p.elo}</b>Elo</span><span><b>{p.wins}</b>Won</span><span><b>{p.losses}</b>Lost</span><span><b>{p.draws}</b>Drawn</span>
        </div>
      </section>
      <nav class="b-menu">
        <a class="b-big play" href="#play"><b>Play</b><span>{ready ? "1v1, five rounds" : "Build a deck first"}</span></a>
        <a class="b-big" href="#decks"><b>Decks</b><span>{plural(h.decks.length, "deck")} · {ready} ready</span></a>
        <a class="b-big" href="#library"><b>Library</b><span>{plural(h.owned_teams.length, "robot")} · {CAT.support.length} support</span></a>
        <a class="b-big" href="#history"><b>History</b><span>{plural(p.games, "game")}</span></a>
        {h.is_admin && <a class="b-big admin" href="#admin"><b>Card admin</b><span>Robot effects</span></a>}
      </nav>
      <Leaderboard />
      <button type="button" class="b-link" onClick={() => openSheet(() => <Rules />)}>How to play</button>
    </div>
  );
}

function Leaderboard() {
  const [players, setPlayers] = useState<LeaderboardPlayer[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const load = async () => {
    setBusy(true); setFailed(false);
    try { setPlayers(await call<LeaderboardPlayer[]>("GET", "/api/battler/leaderboard")); }
    catch { setFailed(true); }
    finally { setBusy(false); }
  };
  useEffect(() => { load(); }, []);
  return (
    <section class="b-leaderboard" aria-labelledby="b-leaderboard-title" aria-busy={busy}>
      <header><div><h2 id="b-leaderboard-title">Leaderboard</h2><p>Top 25</p></div>
        <button type="button" class="b-link small" disabled={busy} onClick={load} aria-label="Refresh leaderboard">{busy ? <Spinner small /> : "Refresh"}</button>
      </header>
      {failed && <p class="b-dim b-small" role="status">Couldn't load the leaderboard. Try Refresh.</p>}
      {players?.length ? (
        <div class="b-leaderboard-scroll" role="region" aria-label="Top 25 players by Elo" tabIndex={0}>
        <table>
          <thead><tr><th scope="col">Rank</th><th scope="col">Player</th><th scope="col">Elo</th><th scope="col">W–L–D</th></tr></thead>
          <tbody>{players.map((p) => <tr key={p.name} class={cx(p.me && "you")}>
            <td class={cx("b-lb-rank", p.rank <= 3 && "b-lb-podium")}>{p.rank}</td>
            <th scope="row"><a href={`/#u/${encodeURIComponent(p.name)}`}>{p.name}</a>{p.me && <small>You</small>}</th>
            <td class="b-lb-elo">{p.elo}</td><td class="b-lb-record">{p.wins}–{p.losses}–{p.draws}</td>
          </tr>)}</tbody>
        </table>
        </div>
      ) : players && !failed && <p class="b-dim b-small">No ranked players yet. Finish a game to claim the first spot.</p>}
    </section>
  );
}

function Rules() {
  const r = CAT.rules;
  return (
    <div class="b-rules">
      <h2>How to play</h2>
      <ol>
        <li><b>Deck:</b> 1 Captain, {r.deck_robots} robots, {r.support_cards} Part and Lore cards.</li>
        <li><b>Schedule:</b> your {r.deck_robots} robots are shuffled into {r.rounds} pairs. Your captain joins each pair. Review both alliances and their estimated win chances, then ready up.</li>
        <li><b>Matches ({r.rounds}):</b> play with your scheduled partners. Choose stations, play Parts on robots and up to one Lore, then lock in.</li>
        <li><b>Score:</b> Auto, Tele and End add up. Winning a round is 3 RP. Each robot rolls for +1 RP.</li>
      </ol>
      <p class="b-dim b-small">Cards are only used up for the game. Nothing leaves your collection.</p>
    </div>
  );
}
