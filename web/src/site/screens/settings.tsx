// Settings: your account (name, username, password, sign out), notifications, sound, the pack wheel, feedback, the app
// version, and the admin and developer tools when they apply.
import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import { api, explain, type Feedback, type FeedbackKind } from "../../api";
import { useStore } from "../../lib/store";
import { PACK } from "../data";
import { applyCollection, applyState, fail, prefs, setPrefs, st, toast } from "../state";
import { Avatar, back, cx, push, Spinner } from "../ui";
import { canInstall, install, ios, push as pushState, standalone, togglePush } from "../pwa";
import { openProfile } from "./profile";

export function openSettings() {
  push(() => <Settings />, "page");
}

function Line({ title, note, children }: { title: string; note?: ComponentChildren; children?: ComponentChildren }) {
  return <div class="sg-line"><span><b>{title}</b>{note && <small>{note}</small>}</span>{children}</div>;
}
const Toggle = ({ on, onClick, disabled }: { on: boolean; onClick: () => void; disabled?: boolean }) => (
  <button type="button" class={cx("s-toggle", on && "on")} role="switch" aria-checked={on} disabled={disabled} onClick={onClick}><i /></button>
);

function Settings() {
  const s = useStore(st)!;
  const p = useStore(prefs);
  const ps = useStore(pushState);
  const inst = useStore(canInstall);
  const a = s.account;
  const [edit, setEdit] = useState<"" | "name" | "user" | "pw">("");
  const [msg, setMsg] = useState<{ text: string; bad: boolean } | null>(null);
  const [ver, setVer] = useState<"" | "checking" | "latest" | "update" | "error">("");
  const [busy, setBusy] = useState("");

  const run = async (key: string, f: () => Promise<void>) => {
    setBusy(key);
    try { await f(); } catch (e) { setMsg({ text: explain(e), bad: true }); }
    setBusy("");
  };
  const submit = (e: Event, f: (form: HTMLFormElement) => Promise<string | void>) => {
    e.preventDefault();
    const form = e.currentTarget as HTMLFormElement;
    run("form", async () => { const ok = await f(form); if (ok) { setMsg({ text: ok, bad: false }); setEdit(""); } });
  };
  // Compares the script this page loaded with the one the site serves now.
  const checkVersion = async () => {
    if (ver === "update") return location.reload();
    setVer("checking");
    try {
      const h = await (await fetch(`/next.html?v=${Date.now()}`, { cache: "no-store" })).text();
      const m = h.match(/\/assets\/next-[^"']+\.js/), have = document.querySelector('script[type="module"][src*="/assets/"]')?.getAttribute("src");
      setVer(!m || !have || have.includes(m[0]) ? "latest" : "update");
    } catch { setVer("error"); }
  };
  const wait = a.renameAt && a.renameAt > Date.now();
  const dev = async (f: () => Promise<unknown>) => { try { const r = await f(); if (r && typeof r === "object" && "now" in r) applyState(r as never); applyCollection(await api.collection(PACK)); toast("Done."); } catch (e) { fail(e); } };

  return (
    <div class="s-page-in s-settings">
      <header class="s-head"><button type="button" class="s-icon" onClick={back} aria-label="Back">‹</button><h1>Settings</h1></header>
      <section class="sg-acct">
        <Avatar name={a.username} big />
        <div><b>{a.firstName || a.username}</b>{a.badge && <span class="s-badge">{a.badge}</span>}<small>@{a.username}</small></div>
        <button type="button" class="s-btn small ghost" onClick={() => openProfile(a.username)}>Profile</button>
      </section>
      {msg && <p class={cx("s-msg", msg.bad && "bad")} role="status">{msg.text}</p>}

      <section class="sg-group"><h2 class="s-h2">Account</h2>
        <Line title="First name" note={a.firstName || "Not set"}><button type="button" class="s-chipbtn" onClick={() => { setEdit(edit === "name" ? "" : "name"); setMsg(null); }}>Edit</button></Line>
        {edit === "name" && (
          <form class="sg-form" onSubmit={(e) => submit(e, async (f) => { const v = (f.elements.namedItem("v") as HTMLInputElement).value.trim(); if (!v) throw new Error("Enter your first name."); applyState(await api.changeFirstName(v)); return "Saved."; })}>
            <input class="s-input" name="v" maxLength={30} autoComplete="given-name" defaultValue={a.firstName ?? ""} aria-label="First name" />
            <button type="submit" class="s-btn small" disabled={busy === "form"}>Save</button>
          </form>
        )}
        <Line title="Username" note={wait ? `You can change it again ${new Date(a.renameAt!).toLocaleDateString(undefined, { month: "short", day: "numeric" })}` : `@${a.username}`}>
          <button type="button" class="s-chipbtn" disabled={!!wait} onClick={() => { setEdit(edit === "user" ? "" : "user"); setMsg(null); }}>Change</button>
        </Line>
        {edit === "user" && (
          <form class="sg-form" onSubmit={(e) => submit(e, async (f) => {
            const u = (f.elements.namedItem("u") as HTMLInputElement).value.trim(), pw = (f.elements.namedItem("pw") as HTMLInputElement).value;
            if (!u || !pw) throw new Error("Enter the new username and your password.");
            const n = await api.changeUsername(u, pw); applyState(n); return `Username changed to ${n.account.username}.`;
          })}>
            <input class="s-input" name="u" maxLength={20} autoCapitalize="none" spellcheck={false} autoComplete="username" defaultValue={a.username} aria-label="New username" />
            <input class="s-input" name="pw" type="password" maxLength={128} autoComplete="current-password" placeholder="Current password" aria-label="Current password" />
            <button type="submit" class="s-btn small" disabled={busy === "form"}>Change username</button>
          </form>
        )}
        <Line title="Password" note="Changing it signs your other devices out."><button type="button" class="s-chipbtn" onClick={() => { setEdit(edit === "pw" ? "" : "pw"); setMsg(null); }}>Change</button></Line>
        {edit === "pw" && (
          <form class="sg-form" onSubmit={(e) => submit(e, async (f) => {
            const cur = (f.elements.namedItem("cur") as HTMLInputElement).value, next = (f.elements.namedItem("next") as HTMLInputElement).value;
            if (!cur) throw new Error("Enter your current password.");
            if (next.length < 8) throw new Error("New passwords need at least 8 characters.");
            await api.changePassword(cur, next); return "Password changed.";
          })}>
            <input class="s-input" name="cur" type="password" autoComplete="current-password" placeholder="Current password" maxLength={128} aria-label="Current password" />
            <input class="s-input" name="next" type="password" autoComplete="new-password" placeholder="New password (8+ characters)" maxLength={128} aria-label="New password" />
            <button type="submit" class="s-btn small" disabled={busy === "form"}>Save</button>
          </form>
        )}
        <Line title="Sign out"><button type="button" class="s-chipbtn" onClick={async () => { try { await api.logout(); } finally { location.assign("/"); } }}>Sign out</button></Line>
      </section>

      <section class="sg-group"><h2 class="s-h2">Game</h2>
        <Line title="Notifications" note={ps === "ios-home" ? "Add FRC Packs to your home screen first (Share, Add to Home Screen)." : ps === "blocked" ? "Blocked in your browser's site settings." : ps === "unsupported" ? "This browser can't show them." : "Free pack ready, trade offers, accepted trades."}>
          <Toggle on={ps === "on"} disabled={!(ps === "on" || ps === "off") || busy === "push"} onClick={() => run("push", togglePush)} />
        </Line>
        <Line title="Sound"><Toggle on={!p.muted} onClick={() => setPrefs((x) => { x.muted = !x.muted; })} /></Line>
        <Line title="Pack wheel every time" note="Pick from the wheel of 10 each time you open another pack."><Toggle on={p.wheel2} onClick={() => setPrefs((x) => { x.wheel2 = !x.wheel2; })} /></Line>
      </section>

      <section class="sg-group"><h2 class="s-h2">About</h2>
        <Line title="Feedback" note="Found a bug or have an idea? We read everything."><button type="button" class="s-chipbtn" onClick={() => openFeedback()}>Send</button></Line>
        {!standalone() && <Line title="Install the app" note={inst ? "Your home screen or desktop, in its own window." : ios ? "In Safari: Share, then Add to Home Screen." : "Use your browser's menu (Install app)."}>{inst && <button type="button" class="s-chipbtn" onClick={install}>Install</button>}</Line>}
        <Line title="App version" note={ver === "checking" ? "Checking…" : ver === "latest" ? "You have the latest version." : ver === "update" ? "A newer version is ready." : ver === "error" ? "Couldn't check. Try again." : undefined}>
          <button type="button" class="s-chipbtn" disabled={ver === "checking"} onClick={checkVersion}>{ver === "update" ? "Update" : "Check"}</button>
        </Line>
      </section>

      {(a.admin || s.devTools) && (
        <section class="sg-group"><h2 class="s-h2">Admin and testing</h2>
          {a.admin && <Line title="Admin panel"><a class="s-chipbtn" href="/admin">Open</a></Line>}
          {s.devTools && <>
            <Line title="Demo luck" note="Mythic about 1 pack in 5, to try the big moment."><Toggle on={s.demo} onClick={() => dev(() => api.dev.demo(!s.demo))} /></Line>
            <Line title="Extra packs"><span class="s-btns"><button type="button" class="s-chipbtn" onClick={() => dev(() => api.dev.pack(PACK))}>+1 pack</button><button type="button" class="s-chipbtn" onClick={() => dev(() => api.dev.skipTimer())}>Skip timer</button></span></Line>
            <Line title="Start over" note="Deletes this account's cards and packs."><button type="button" class="s-chipbtn warn" onClick={() => { if (confirm("Delete all your cards and packs?")) dev(() => api.dev.reset()); }}>Reset</button></Line>
          </>}
        </section>
      )}
    </div>
  );
}

// ---------- feedback ----------

const KINDS: [FeedbackKind, string][] = [["bug", "Bug"], ["idea", "Idea"], ["other", "Other"]];
const STATUS: Record<string, string> = { open: "Open", planned: "Planned", done: "Done", wontfix: "Won't do" };

export function openFeedback() {
  push(() => <FeedbackForm />, "page");
}

function FeedbackForm() {
  const [kind, setKind] = useState<FeedbackKind>("bug");
  const [mine, setMine] = useState<Feedback[] | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => api.myFeedback().then(setMine, () => setMine([]));
  useEffect(() => { load(); }, []);
  const send = async (e: Event) => {
    e.preventDefault();
    const f = e.currentTarget as HTMLFormElement;
    const title = (f.elements.namedItem("title") as HTMLInputElement).value.trim(), details = (f.elements.namedItem("details") as HTMLTextAreaElement).value.trim();
    if (!title) return toast("Give it a short title.", true);
    setBusy(true);
    try {
      await api.sendFeedback(kind, title, details, `${location.pathname}${location.hash} · ${navigator.userAgent}`);
      f.reset();
      toast("Thanks! We'll take a look.");
      load();
    } catch (er) { fail(er); }
    setBusy(false);
  };
  return (
    <div class="s-page-in s-feedback">
      <header class="s-head"><button type="button" class="s-icon" onClick={back} aria-label="Back">‹</button><h1>Feedback</h1></header>
      <form class="sg-form col" onSubmit={send}>
        <div class="s-chips">{KINDS.map(([k, l]) => <button type="button" class={cx("s-chip", kind === k && "on")} aria-pressed={kind === k} onClick={() => setKind(k)}>{l}</button>)}</div>
        <input class="s-input" name="title" maxLength={100} placeholder="Short title" aria-label="Title" />
        <textarea class="s-input" name="details" maxLength={2000} rows={5} placeholder="What happened, or what would you like?" aria-label="Details" />
        <button type="submit" class="s-btn" disabled={busy}>Send</button>
      </form>
      <h2 class="s-h2">Yours</h2>
      {mine === null ? <Spinner small /> : !mine.length ? <p class="s-dim">Nothing sent yet.</p> : (
        <div class="s-list">{mine.map((x) => (
          <div class="s-row"><div><b>{x.title}</b><span>{x.kind} · {STATUS[x.status] ?? x.status}{x.note ? ` · ${x.note}` : ""}</span></div></div>
        ))}</div>
      )}
    </div>
  );
}
