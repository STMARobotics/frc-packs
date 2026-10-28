// FRC Packs, rebuilt on Preact (the same setup as the Battler): each screen describes what it shows and only what
// changed gets touched, so cards keep their elements and photos while you use the app. Tabs are hash routes (#open,
// #binder, #trade, #social); screens over them (a card, a profile, settings) are a stack the phone's back button steps
// through. This page runs next to the current one (index.html) until it does everything that one does.
import "../style.css";
import "./site.css";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { api, ApiError, explain } from "../api";
import { useStore } from "../lib/store";
import { PACK, setRecipe } from "./data";
import { applyCollection, applyState, loadTrades, packOf, prefs, st, sync, trades } from "./state";
import { closeAll, cx, LayerHost, Spinner, ToastHost } from "./ui";
import { Binder } from "./screens/binder";
import { StatusBar } from "./screens/status";
import { Avatar } from "./ui";
import { openProfile } from "./screens/profile";
import { setupPwa } from "./pwa";

type Tab = "open" | "binder" | "trade" | "social";
const TABS: Tab[] = ["open", "binder", "trade", "social"];
const tabOf = (): Tab => { const h = location.hash.slice(1) as Tab; return TABS.includes(h) ? h : "binder"; };

function useTab(): [Tab, (t: Tab) => void] {
  const [t, setT] = useState(tabOf);
  useEffect(() => {
    const f = () => setT(tabOf());
    addEventListener("hashchange", f);
    return () => removeEventListener("hashchange", f);
  }, []);
  const go = (n: Tab) => closeAll(() => { if (location.hash !== `#${n}`) history.replaceState(history.state, "", `#${n}`); setT(n); scrollTo(0, 0); });
  return [t, go];
}

function App() {
  const [phase, setPhase] = useState<"loading" | "ready" | "signin" | string>("loading");
  const [tab, go] = useTab();
  const s = useStore(st);
  const p = useStore(prefs);
  const tr = useStore(trades);
  const [seen] = useState(() => new Set<Tab>());
  seen.add(tab);

  useEffect(() => {
    (async () => {
      try {
        const [state, recipe] = await Promise.all([api.session(), api.recipe(PACK)]);
        setRecipe(recipe, state.tiers);
        applyState(state);
        applyCollection(await api.collection(PACK));
        loadTrades();
        setupPwa();
        setPhase("ready");
      } catch (e) {
        setPhase(e instanceof ApiError && e.status === 401 ? "signin" : explain(e));
      }
    })();
    // Another tab or device may have changed things: catch up when the app comes back.
    const back = () => { if (document.visibilityState === "visible") sync(); };
    document.addEventListener("visibilitychange", back);
    return () => document.removeEventListener("visibilitychange", back);
  }, []);

  if (phase === "loading") return <div class="s-center"><Spinner /></div>;
  if (phase === "signin") return <div class="s-center s-gate"><h1>FRC Packs</h1><p class="s-dim">Sign in to open packs and build your binder.</p><a class="s-btn" href="/">Sign in</a></div>;
  if (phase !== "ready") return <div class="s-center s-gate"><h1>Couldn't load</h1><p class="s-dim">{phase}</p><button type="button" class="s-btn" onClick={() => location.reload()}>Try again</button></div>;

  const me = s!.account;
  const unseen = Object.keys(p.unseen).length;
  const offers = tr.incoming.length;
  const packs = packOf(s!);
  return (
    <>
      <header class="s-top">
        <span class="s-brand">FRC Packs</span>
        <span class="s-top-r">
          <span class="s-pill" title="Parts">⚙ {s!.parts}</span>
          <span class="s-pill" title="Sealed packs">▣ {packs.sealed}</span>
          <button type="button" class="s-avbtn" onClick={() => openProfile(me.username)} aria-label="Your profile"><Avatar name={me.username} /></button>
        </span>
      </header>
      <main class="s-main">
        {/* A tab stays mounted (hidden) once visited, so coming back to it shows the same cards, not rebuilt ones. */}
        {seen.has("open") && <div hidden={tab !== "open"}><StatusBar /><Later what="Opening packs" /></div>}
        {seen.has("binder") && <div hidden={tab !== "binder"}><Binder active={tab === "binder"} /></div>}
        {seen.has("trade") && <div hidden={tab !== "trade"}><Later what="Trading" /></div>}
        {seen.has("social") && <div hidden={tab !== "social"}><Later what="Social" /></div>}
      </main>
      <nav class="s-tabbar" aria-label="Sections">
        {(["open", "binder", "trade", "social"] as Tab[]).map((t) => (
          <button type="button" class={cx(tab === t && "on")} aria-current={tab === t ? "page" : undefined} onClick={() => go(t)}>
            <i class={`ic-${t}`} aria-hidden="true" />
            <span>{t === "open" ? "Open" : t === "binder" ? "Binder" : t === "trade" ? "Trade" : "Social"}</span>
            {t === "binder" && unseen > 0 && <em class="s-dot">{unseen > 99 ? "99+" : unseen}</em>}
            {t === "trade" && offers > 0 && <em class="s-dot">{offers}</em>}
          </button>
        ))}
        <a href="/battle.html"><i class="ic-battle" aria-hidden="true" /><span>Battle</span></a>
      </nav>
    </>
  );
}

/** A section that hasn't moved to the new version yet. */
function Later({ what }: { what: string }) {
  return <div class="s-empty"><b>{what}</b> hasn't moved to the new version yet. <a href="/">Use it on the current site</a>.</div>;
}

render(<><App /><LayerHost /><ToastHost /></>, document.getElementById("app")!);
