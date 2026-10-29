// The Battler: build a deck from the robots you own in FRC Packs and play 1v1, five-round games. The server runs every
// rule (server/src/battler); this page shows what it says and sends what you tap. Screens are hash routes:
// #home, #library, #decks, #deck/<id>, #play, #game/<id> (#game/<id>/<code> to join a private one), #history, #admin.
//
// Rendering is Preact: each screen describes what it shows, and only what changed gets touched on the page. Cards keep
// their elements (and loaded photos) from one update to the next, so nothing is rebuilt while you look at it.
import "../style.css";
import "./battler.css";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { ApiError, explain } from "./api";
import { closeSheet, home, loadCatalog, loadHome, useStore } from "./store";
import { SheetHost, Spinner, ToastHost } from "./ui";
import { HomeScreen } from "./screens/home";
import { Library } from "./screens/library";
import { Decks, DeckEditor } from "./screens/decks";
import { Lobby } from "./screens/lobby";
import { History } from "./screens/history";
import { Admin } from "./screens/admin";
import { GameScreen } from "./game/game";

const parse = () => (location.hash.slice(1) || "home").split("/") as [string, string?, string?];

function useRoute() {
  const [r, setR] = useState(parse);
  useEffect(() => {
    const f = () => { closeSheet(); setR(parse()); scrollTo(0, 0); };
    addEventListener("hashchange", f);
    return () => removeEventListener("hashchange", f);
  }, []);
  return r;
}

function Screen({ name, arg, code }: { name: string; arg?: string; code?: string }) {
  switch (name) {
    case "library": return <Library />;
    case "decks": return <Decks />;
    case "deck": return <DeckEditor key={arg} id={arg!} />;
    case "play": return <Lobby />;
    case "game": return <GameScreen key={arg} id={arg!} code={code} />;
    case "history": return <History />;
    case "admin": return <Admin />;
    default: return <HomeScreen />;
  }
}

function App() {
  const [state, setState] = useState<"loading" | "ready" | "signin" | Error>("loading");
  const [name, arg, code] = useRoute();
  const h = useStore(home);
  useEffect(() => {
    Promise.all([loadCatalog(), loadHome()]).then(
      () => setState("ready"),
      (e) => setState(e instanceof ApiError && e.status === 401 ? "signin" : e instanceof Error ? e : new Error(String(e))),
    );
  }, []);
  useEffect(() => { document.body.dataset.screen = name; }, [name]);

  if (state === "loading") return <div class="b-center"><Spinner /></div>;
  if (state === "signin") return (
    <div class="b-center b-gate">
      <h1>Battler</h1>
      <p class="b-dim">Sign in with your FRC Packs account to play with the robots you own.</p>
      <a class="b-btn" href="/">Sign in</a>
    </div>
  );
  if (state instanceof Error) return (
    <div class="b-center b-gate">
      <h1>Couldn't load</h1>
      <p class="b-dim">{explain(state)}</p>
      <button class="b-btn" type="button" onClick={() => location.reload()}>Try again</button>
    </div>
  );
  return (
    <>
      {name !== "game" && (
        <header class="b-top">
          <a class="b-brand" href="#home">Battler</a>
          <span class="b-top-r">{h && <span class="b-elo"><b>{h.profile.elo}</b> Elo</span>}<a class="b-chip" href="/">FRC Packs</a></span>
        </header>
      )}
      <main class="b-main" data-screen={name}><Screen name={name} arg={arg} code={code} /></main>
    </>
  );
}

function Root() {
  return <><App /><SheetHost /><ToastHost /></>;
}

render(<Root />, document.getElementById("app")!);
