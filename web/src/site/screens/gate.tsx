// Before and around the game: signing in or joining with an invite (new players agree to the beta terms first), the
// beta welcome a player sees once, a one-time note from the game, and the owner's notice (a countdown bar and a
// message to acknowledge) read from /notice.json.
import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import { api, ApiError, explain, type State } from "../../api";
import { back, push } from "../ui";
import { PackArt } from "./open";
import { openFeedback } from "./settings";

const USERNAME = /^[A-Za-z0-9_]{3,20}$/;
const TERMS = "frcpacks.betaTerms";

// ---------- sign in / join ----------

/** Shown until someone signs in or joins; `guest` is a browser with cards from before accounts existed. */
export function SignIn({ guest, onDone }: { guest: boolean; onDone: (s: State) => void }) {
  // A link like /next.html?invite=ABCD-EFGH-JKMN opens the join form with the code filled in.
  const [invite] = useState(() => new URLSearchParams(location.search).get("invite") ?? "");
  const [join, setJoin] = useState(guest || !!invite);
  const [agreed, setAgreed] = useState(() => { try { return sessionStorage.getItem(TERMS) === "1"; } catch { return false; } });
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const tab = (j: boolean) => { setJoin(j); setMsg(""); };
  const agree = () => { setAgreed(true); try { sessionStorage.setItem(TERMS, "1"); } catch { /* storage can be off */ } };
  const submit = (check: (f: HTMLFormElement) => string | null, run: (f: HTMLFormElement) => Promise<State>) => async (e: Event) => {
    e.preventDefault();
    const f = e.currentTarget as HTMLFormElement;
    const problem = check(f);
    if (problem) return setMsg(problem);
    setBusy(true); setMsg("");
    try {
      const s = await run(f);
      if (invite) history.replaceState(null, "", location.pathname + location.hash);
      onDone(s);
    } catch (er) { setMsg(explain(er)); setBusy(false); }
  };
  const v = (f: HTMLFormElement, n: string) => (f.elements.namedItem(n) as HTMLInputElement).value;
  const login = submit(
    (f) => (v(f, "username").trim() && v(f, "password") ? null : "Enter your username and password."),
    (f) => api.login(v(f, "username").trim(), v(f, "password")),
  );
  const signup = submit(
    (f) => !v(f, "code").trim() ? "Enter your invite code."
      : !v(f, "firstName").trim() ? explain(new ApiError(400, "bad_first_name"))
      : !USERNAME.test(v(f, "username").trim()) ? explain(new ApiError(400, "bad_username"))
      : v(f, "password").length < 8 ? "Passwords need at least 8 characters." : null,
    (f) => api.signup(v(f, "code").trim(), v(f, "username").trim(), v(f, "password"), v(f, "firstName").trim()),
  );
  return (
    <div class="au">
      <div class="au-hero" aria-hidden="true">
        <span class="au-p l"><PackArt k="gold" /></span>
        <span class="au-p r"><PackArt k="myth" /></span>
        <span class="au-p c"><PackArt k="std" /></span>
      </div>
      <h1 class="au-brand">FRC Packs</h1>
      <div class="au-card">
        <div class="s-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={!join} onClick={() => tab(false)}>Sign in</button>
          <button type="button" role="tab" aria-selected={join} onClick={() => tab(true)}>Join</button>
        </div>
        {!join && (
          <form class="au-form" onSubmit={login} noValidate>
            <input class="s-input" name="username" placeholder="Username" aria-label="Username" autocomplete="username" autocapitalize="none" spellcheck={false} maxLength={20} autoFocus />
            <input class="s-input" name="password" type="password" placeholder="Password" aria-label="Password" autocomplete="current-password" maxLength={128} />
            <button type="submit" class="s-btn wide" disabled={busy}>Sign in</button>
          </form>
        )}
        {join && !agreed && (
          <div class="au-form au-terms">
            <b>FRC Packs is in beta</b>
            <p>By joining as a beta tester you agree to:</p>
            <ul>
              <li><b>Report every bug you find</b> with Feedback in Settings, even small ones.</li>
              <li><b>Share ideas.</b> We need them.</li>
            </ul>
            <button type="button" class="s-btn wide" onClick={agree} autoFocus>I agree</button>
          </div>
        )}
        {join && agreed && (
          <form class="au-form" onSubmit={signup} noValidate>
            {guest && <p class="s-msg">This browser has cards from before accounts. Join and they come with you.</p>}
            <input class="s-input au-code" name="code" placeholder="Invite code" aria-label="Invite code" defaultValue={invite} autocomplete="off" autocapitalize="characters" spellcheck={false} maxLength={20} autoFocus={!invite} />
            <input class="s-input" name="firstName" placeholder="First name" aria-label="First name" autocomplete="given-name" maxLength={30} autoFocus={!!invite} />
            <input class="s-input" name="username" placeholder="Username" aria-label="Username, 3 to 20 letters, numbers or underscores" autocomplete="username" autocapitalize="none" spellcheck={false} maxLength={20} />
            <input class="s-input" name="password" type="password" placeholder="Password (8+ characters)" aria-label="Password, at least 8 characters" autocomplete="new-password" maxLength={128} />
            <button type="submit" class="s-btn wide" disabled={busy}>Create account</button>
          </form>
        )}
        {msg && <p class="s-msg bad" role="alert">{msg}</p>}
      </div>
    </div>
  );
}

// ---------- once-only messages ----------

function Sheet({ title, children, buttons }: { title: string; children: ComponentChildren; buttons: ComponentChildren }) {
  return (
    <div class="au-sheet" role="dialog" aria-modal="true" aria-label={title}>
      <h2>{title}</h2>
      {children}
      <div class="s-row2">{buttons}</div>
    </div>
  );
}

const BETA = "frcpacks.beta"; // the same key as the old page, so nobody sees it twice
/** The beta welcome, once per device. */
export function betaWelcome() {
  try { if (localStorage.getItem(BETA)) return; localStorage.setItem(BETA, "1"); } catch { return; }
  push(() => (
    <Sheet title="You're a beta tester" buttons={<><button type="button" class="s-btn" onClick={() => { back(); setTimeout(openFeedback, 50); }}>Send feedback</button><button type="button" class="s-btn ghost" onClick={back}>Got it</button></>}>
      <p>FRC Packs is still being built, and you're one of the first players. Thank you!</p>
      <ul>
        <li>Things will break. Tell us when they do.</li>
        <li>Have an idea? Tell us that too.</li>
        <li>Your cards are safe, but the game may reset before launch.</li>
      </ul>
    </Sheet>
  ), "sheet");
}

let noted = false;
/** A one-time note from the game (say, "Mythics have changed"): shown once, then marked read. */
export function gameNotice(text: string | null | undefined) {
  if (!text || noted) return;
  noted = true;
  push(() => <Sheet title="A note from FRC Packs" buttons={<button type="button" class="s-btn" onClick={back}>Got it</button>}><p>{text}</p></Sheet>, "sheet");
  api.noticeSeen().catch(() => {});
}

// ---------- the owner's notice ----------

type Notice = { text: string; at: number };
const left = (ms: number) => {
  if (ms <= 0) return "any moment now";
  const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
};
const when = (at: number) => new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/** A red bar with a countdown while /notice.json exists, and a message to acknowledge when the page opens, at 10 minutes
    to go and at 1 minute to go. */
export function OwnerNotice() {
  const [n, setN] = useState<Notice | null>(null);
  const [, tick] = useState(0);
  const [seen, setSeen] = useState(0);
  useEffect(() => {
    const check = async () => {
      try {
        const r = await fetch(`/notice.json?t=${Date.now()}`, { cache: "no-store" });
        const j = r.ok && (r.headers.get("content-type") || "").includes("json") ? await r.json() : null;
        const x = j && typeof j.text === "string" && typeof j.at === "number" ? { text: j.text, at: j.at } : null;
        setN((o) => (o?.text === x?.text && o?.at === x?.at ? o : x));
        if (!x) setSeen(0);
      } catch { /* keep what we have */ }
    };
    check();
    const a = setInterval(check, 30_000), b = setInterval(() => tick((t) => t + 1), 1000);
    return () => { clearInterval(a); clearInterval(b); };
  }, []);
  useEffect(() => { document.body.classList.toggle("nt-on", !!n); }, [n]);
  if (!n) return null;
  const ms = n.at - Date.now(), stage = ms <= 60_000 ? 3 : ms <= 600_000 ? 2 : 1, msg = `Offline in ${left(ms)} (${when(n.at)})`;
  return (
    <>
      <div class="nt-bar" role="alert">{n.text} {msg}.</div>
      {stage > seen && (
        <div class="nt-over" role="alertdialog" aria-modal="true" aria-label="Heads up">
          <div class="au-sheet">
            <h2>Heads up</h2>
            <p>{n.text}</p>
            <b class="nt-time">{msg}</b>
            <button type="button" class="s-btn wide" onClick={() => setSeen(stage)}>Got it</button>
          </div>
        </div>
      )}
    </>
  );
}
