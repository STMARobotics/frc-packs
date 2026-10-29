import { useEffect, useState } from "preact/hooks";
import { call, explain } from "../api";
import { home, loadHome, toast, useStore } from "../store";
import type { GameView } from "../types";
import { Empty, Head, Spinner } from "../ui";

// Play: Quick Play (join whoever's waiting, or wait for the next player), host a private match (only someone with its
// code can join, so nobody takes a seat meant for a friend), or join a friend's with their code.
export function Lobby() {
  const h = useStore(home)!;
  const [busy, setBusy] = useState("");
  const [code, setCode] = useState("");
  const ready = h.decks.some((d) => !d.problems.length);

  useEffect(() => {
    loadHome().then((x) => { if (x.active) location.hash = `#game/${x.active}`; }).catch(() => {});
  }, []);

  const go = async (what: string, f: () => Promise<string>) => {
    setBusy(what);
    try { location.hash = await f(); } catch (e) { toast(explain(e), true); setBusy(""); }
  };
  const quick = () => go("quick", async () => `#game/${(await call<GameView>("POST", "/api/battler/quick")).id}`);
  const host = () => go("host", async () => `#game/${(await call<GameView>("POST", "/api/battler/games")).id}`);
  const join = (e: Event) => {
    e.preventDefault();
    const c = code.trim().toUpperCase();
    if (c.length !== 6) return toast("Match codes are 6 letters and numbers.", true);
    go("code", async () => { const r = await call<{ id: string; code: string }>("GET", `/api/battler/code/${c}`); return `#game/${r.id}/${r.code}`; });
  };

  return (
    <div class="b-screen">
      <Head title="Play" />
      {!ready ? <Empty>You need a ready deck. <a href="#decks">Build one</a></Empty> : (
        <>
          <button type="button" class="b-btn wide big b-quick" onClick={quick} disabled={!!busy}>
            {busy === "quick" ? <Spinner small /> : <>Quick Play<small>Play the next person looking for a game</small></>}
          </button>
          <button type="button" class="b-btn wide ghost" onClick={host} disabled={!!busy}>{busy === "host" ? <Spinner small /> : "Host a private match"}</button>
          <h2 class="b-h2">Join a friend</h2>
          <form class="b-codejoin" onSubmit={join}>
            <input class="b-input b-code" value={code} onInput={(e) => setCode(e.currentTarget.value.toUpperCase())} maxLength={6} placeholder="Match code" aria-label="Match code"
              autocomplete="off" autocapitalize="characters" spellcheck={false} />
            <button type="submit" class="b-btn" disabled={!!busy}>{busy === "code" ? <Spinner small /> : "Join"}</button>
          </form>
        </>
      )}
    </div>
  );
}
