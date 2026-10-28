import { useEffect } from "preact/hooks";
import { CAT, home, loadHome, openSheet, useStore } from "../store";
import { plural } from "../ui";

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
      <button type="button" class="b-link" onClick={() => openSheet(() => <Rules />)}>How to play</button>
    </div>
  );
}

function Rules() {
  const r = CAT.rules;
  return (
    <div class="b-rules">
      <h2>How to play</h2>
      <ol>
        <li><b>Deck:</b> 1 Captain, {r.deck_robots} robots, {r.support_cards} Part and Lore cards.</li>
        <li><b>Draft:</b> both decks are shuffled together. Take turns picking 1 of {r.offer} until you each have {r.pool_size}.</li>
        <li><b>Rounds ({r.rounds}):</b> field your Captain and 2 robots. Play Parts on robots and up to one Lore, then lock in.</li>
        <li><b>Score:</b> Auto, Tele and End add up. Winning a round is 3 RP. Each robot rolls for +1 RP.</li>
        <li><b>Batteries:</b> robots drain when they play and recharge on the bench. Low ones play weaker and can break down.</li>
      </ol>
      <p class="b-dim b-small">Cards are only used up for the game. Nothing leaves your collection.</p>
    </div>
  );
}
