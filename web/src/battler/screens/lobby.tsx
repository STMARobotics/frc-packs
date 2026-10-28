import { useEffect, useState } from "preact/hooks";
import { call, explain } from "../api";
import { home, loadHome, toast, useStore } from "../store";
import type { GameView } from "../types";
import { Empty, Head, Spinner } from "../ui";
import { ago } from "./history";

interface OpenGame { id: string; host: string; elo: number; created_at: number }

export function Lobby() {
  const h = useStore(home)!;
  const [games, setGames] = useState<OpenGame[] | null>(null);
  const [busy, setBusy] = useState("");
  const ready = h.decks.some((d) => !d.problems.length);

  useEffect(() => {
    let alive = true;
    loadHome().then((x) => { if (alive && x.active) location.hash = `#game/${x.active}`; }).catch(() => {});
    const refresh = async () => {
      try { const r = await call<{ games: OpenGame[] }>("GET", "/api/battler/lobby"); if (alive) setGames(r.games); } catch { /* keep the old list */ }
    };
    refresh();
    const t = setInterval(() => { if (document.visibilityState === "visible") refresh(); }, 3000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const host = async () => {
    setBusy("host");
    try { const g = await call<GameView>("POST", "/api/battler/games"); location.hash = `#game/${g.id}`; } catch (e) { toast(explain(e), true); setBusy(""); }
  };
  const join = async (id: string) => {
    setBusy(id);
    try { await call("POST", `/api/battler/games/${id}/join`); location.hash = `#game/${id}`; } catch (e) { toast(explain(e), true); setBusy(""); }
  };

  return (
    <div class="b-screen">
      <Head title="Play" />
      {ready
        ? <button type="button" class="b-btn wide" onClick={host} disabled={!!busy}>{busy === "host" ? <Spinner small /> : "Host a game"}</button>
        : <Empty>You need a ready deck. <a href="#decks">Build one</a></Empty>}
      <h2 class="b-h2">Open games</h2>
      {games === null ? <div class="b-center small"><Spinner /></div>
        : !games.length ? <p class="b-dim b-small">None right now. Host one and share the link.</p>
        : (
          <div class="b-list">
            {games.map((g) => (
              <div key={g.id} class="b-row">
                <div><b>{g.host}</b><span>{g.elo} Elo · {ago(g.created_at)}</span></div>
                {g.host === h.name ? <span class="b-dim">You</span>
                  : <button type="button" class="b-btn small" disabled={!ready || !!busy} onClick={() => join(g.id)}>{busy === g.id ? <Spinner small /> : "Join"}</button>}
              </div>
            ))}
          </div>
        )}
    </div>
  );
}
