// A game, from the lobby to the final result. It asks the server for news about once a second (only what changed comes
// back) and shows whichever screen the game is on.
import { useEffect, useRef, useState } from "preact/hooks";
import { ApiError, call, explain } from "../api";
import { home, loadHome, toast, useStore } from "../store";
import type { GameView } from "../types";
import { Empty, Spinner } from "../ui";
import { DeckLine } from "../screens/decks";
import { act, fetchGame, game, inviteCode, myMove, resetGame, setInvite } from "./state";
import { Arena } from "./arena";
import { Draft } from "./draft";
import { Intro } from "./intro";
import { Final, Versus } from "./final";
import { Emotes } from "./emotes";

/** Rounds whose result this player has moved past, per game (so a replayed reveal doesn't show again). */
const seenRounds = new Map<string, number>();

export function GameScreen({ id, code }: { id: string; code?: string }) {
  const g = useStore(game);
  const [err, setErr] = useState<string | null>(null);
  const [seen, setSeenState] = useState<number | null>(seenRounds.get(id) ?? null);
  const setSeen = (n: number) => { seenRounds.set(id, n); setSeenState(n); };

  useEffect(() => {
    resetGame();
    setInvite(code);
    let alive = true, timer = 0;
    const poll = async () => {
      try { await fetchGame(id); } catch (e) {
        if (e instanceof ApiError && (e.status === 404 || e.status === 403)) { alive = false; setErr(e.status === 404 ? "That game doesn't exist." : code ? "That invite doesn't work anymore." : "That's not your game."); }
      }
    };
    const loop = async () => {
      if (!alive) return;
      if (document.visibilityState === "visible") await poll();
      const over = game.get()?.status === "FINAL" || game.get()?.status === "CANCELLED";
      if (alive) timer = window.setTimeout(loop, over ? 15000 : 1000);
    };
    loop();
    const vis = () => { if (document.visibilityState === "visible") { clearTimeout(timer); loop(); } };
    document.addEventListener("visibilitychange", vis);
    return () => { alive = false; clearTimeout(timer); document.removeEventListener("visibilitychange", vis); document.title = "Battler · FRC Packs"; resetGame(); setInvite(); };
  }, [id]);

  // On first load, don't replay old rounds; do play the current round's reveal.
  useEffect(() => {
    if (g && seen === null) setSeen(g.status === "RESULTS" ? g.round - 1 : g.rounds.length);
  }, [g, seen]);

  useEffect(() => {
    if (!g) return;
    document.title = myMove(g) ? "● Your move · Battler" : "Battler · FRC Packs";
    if (g.status === "FINAL") loadHome().catch(() => {});
  }, [g?.rev, g?.status]);

  const inArena = !!g?.me && ["DRAFT", "PIT", "RESULTS"].includes(g.status);
  useEffect(() => { document.body.classList.toggle("b-in-game", inArena); return () => document.body.classList.remove("b-in-game"); }, [inArena]);

  if (err) return <Empty>{err} <a href="#play">Back to Play</a></Empty>;
  if (!g || seen === null) return <div class="b-center"><Spinner /></div>;
  if (!g.me) return <JoinLink g={g} />;

  const replay = seen < g.rounds.length && g.rounds.length > 0;
  const next = () => { setSeen(g.rounds.length); if (g.status === "RESULTS") ack(); };
  const ack = () => act({ kind: "ack" }, (x) => { x.seats[x.me!.side]!.acked = true; });

  let body;
  switch (g.status) {
    case "OPEN": body = <Waiting g={g} />; break;
    case "DECKS": body = <DeckPick g={g} />; break;
    case "DRAFT": body = <><Draft g={g} /><Intro g={g} /></>; break;
    case "PIT": body = <Arena g={g} log={replay ? g.rounds[g.rounds.length - 1] : null} onNext={next} />; break;
    case "RESULTS": body = <Arena g={g} log={g.rounds[g.rounds.length - 1]} onNext={next} />; break;
    case "FINAL":
      body = replay && g.outcome?.reason === "complete"
        ? <Arena g={g} log={g.rounds[g.rounds.length - 1]} onNext={next} />
        : <Final g={g} />;
      break;
    case "CANCELLED":
      body = <div class="b-panel center"><h2>Game called off</h2><p class="b-dim">Nobody's rating changed.</p><a class="b-btn" href="#play">Back to Play</a></div>;
      break;
  }
  return <>{body}<Emotes g={g} /></>;
}

function JoinLink({ g }: { g: GameView }) {
  const host = g.seats[0];
  const [busy, setBusy] = useState(false);
  if (g.status !== "OPEN" || !host) return <Empty>This game is already full. <a href="#play">Find another</a></Empty>;
  const join = async () => {
    setBusy(true);
    const q = inviteCode() ? `?code=${encodeURIComponent(inviteCode())}` : "";
    try { await call("POST", `/api/battler/games/${g.id}/join${q}`); await fetchGame(g.id, false); } catch (e) { toast(explain(e), true); setBusy(false); }
  };
  return (
    <div class="b-panel center">
      <h2>{host.name} invited you</h2>
      <p class="b-dim">{host.elo} Elo · 5 rounds</p>
      <button type="button" class="b-btn" onClick={join} disabled={busy}>{busy ? <Spinner small /> : "Join"}</button>
      <a class="b-link" href="#home">Not now</a>
    </div>
  );
}

function Waiting({ g }: { g: GameView }) {
  return g.mode === "private" ? <Hosting g={g} /> : <Queue g={g} />;
}

/** Quick Play: waiting in the queue for the next player. Asks the server to match again every few seconds, which also
    pairs two players who queued at the same moment. */
function Queue({ g }: { g: GameView }) {
  const [since] = useState(() => Date.now());
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(async () => {
      tick((n) => n + 1);
      try {
        const r = await call<GameView>("POST", "/api/battler/quick");
        if (r.id !== g.id) location.hash = `#game/${r.id}`;
      } catch { /* the next try */ }
    }, 4000);
    return () => clearInterval(t);
  }, [g.id]);
  const s = Math.floor((Date.now() - since) / 1000);
  return (
    <div class="b-panel center b-wait">
      <Spinner />
      <h2>Finding an opponent</h2>
      <p class="b-dim b-small">{Math.floor(s / 60)}:{String(s % 60).padStart(2, "0")}</p>
      <button type="button" class="b-btn ghost" onClick={() => act({ kind: "cancel" })}>Cancel</button>
    </div>
  );
}

/** A private match: the code and an invite link for the one person it's meant for. */
function Hosting({ g }: { g: GameView }) {
  const url = `${location.origin}/battle.html#game/${g.id}/${g.code ?? ""}`;
  const share = async () => {
    try {
      if (navigator.share) await navigator.share({ title: "Battler", text: `Play me in the Battler. Code ${g.code}`, url });
      else { await navigator.clipboard.writeText(url); toast("Invite link copied."); }
    } catch { /* closed the share sheet */ }
  };
  return (
    <div class="b-panel center b-wait">
      <h2>Private match</h2>
      <p class="b-dim b-small">Only someone with this code can join.</p>
      <b class="b-bigcode" aria-label={`Code ${(g.code ?? "").split("").join(" ")}`}>{g.code}</b>
      <button type="button" class="b-btn" onClick={share}>Send invite</button>
      <p class="b-dim b-small"><Spinner small /> Waiting for them to join</p>
      <button type="button" class="b-link" onClick={() => act({ kind: "cancel" })}>Cancel</button>
    </div>
  );
}

function DeckPick({ g }: { g: GameView }) {
  const h = useStore(home)!;
  const me = g.seats[g.me!.side]!, op = g.seats[1 - g.me!.side]!;
  const [picking, setPicking] = useState<string | null>(null);
  const shown = useRef(false);
  useEffect(() => { if (!shown.current) { shown.current = true; loadHome().catch(() => {}); } }, []);
  const leave = () => { if (confirm("Leave this game? Nobody's rating changes.")) act({ kind: "forfeit" }); };
  return (
    <div class="b-screen">
      <Versus g={g} />
      {me.picked ? (
        <div class="b-panel center">
          <Spinner />
          <h2>Deck locked in</h2>
          <p class="b-dim">{op.picked ? "Shuffling…" : `Waiting for ${op.name}`}</p>
          <button type="button" class="b-link" onClick={leave}>Leave game</button>
        </div>
      ) : (
        <>
          <h2 class="b-h2">Pick a deck {op.picked && <small class="ok">{op.name} is ready</small>}</h2>
          <div class="b-list">
            {h.decks.map((d) => (
              <DeckLine key={d.deck.id} d={d} disabled={!!d.problems.length || !!picking}
                onClick={() => { setPicking(d.deck.id); act({ kind: "pick_deck", deck: d.deck.id }).finally(() => setPicking(null)); }} />
            ))}
            {!h.decks.length && <Empty>No decks. <a href="#decks">Build one</a></Empty>}
          </div>
          <button type="button" class="b-link" onClick={leave}>Leave game</button>
        </>
      )}
    </div>
  );
}
