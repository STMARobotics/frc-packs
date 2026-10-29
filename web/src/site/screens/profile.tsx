// A player's profile, a page of its own (#u/<name>: it can be linked, and the phone's back button leaves it): a banner
// and picture picked from their cards, their name, bio and stats; what they have that you need and the other way round,
// with a fair trade one tap away; then Overview (showcase, recent big pulls, rarest cards, special editions, the
// collection by rarity), Collection and Wishlist. Yours has Edit profile (bio, picture, banner, showcase); someone
// else's can be reported.
import { useEffect, useState } from "preact/hooks";
import { api, type CardRef, type Profile, type Special } from "../../api";
import { store, useStore } from "../../lib/store";
import { BY_NUM, byRarity, ORDER, PACK, POOL, TEAMS, TIERS } from "../data";
import { ago, fail, inv, st, toast } from "../state";
import { Avatar, back, Card, closeAll, cx, push, Spinner, Tabs } from "../ui";
import { openCard } from "./cardview";
import { openSettings } from "./settings";
import { tradeFor, tradeSuggested } from "./trade";
import { SpecialRow } from "./special";

/** Bumped after you edit your profile, so the page shows the change. */
const edits = store(0);

/** Goes to a player's profile page. */
export function openProfile(name: string) {
  closeAll(() => {
    const h = `#u/${encodeURIComponent(name)}`;
    if (location.hash === h) return;
    history.pushState({ pf: 1 }, "", h);
    dispatchEvent(new HashChangeEvent("hashchange"));
  });
}
/** The player whose profile the address is on, if any. */
export function profileRoute(): string | null {
  if (!location.hash.startsWith("#u/")) return null;
  try { return decodeURIComponent(location.hash.slice(3)) || null; } catch { return null; }
}
/** Back to where the profile was opened from; to Social when it was opened from a link. */
function leave() {
  if (history.state?.pf) return history.back();
  history.replaceState(null, "", "#social");
  dispatchEvent(new HashChangeEvent("hashchange"));
}

type View = "over" | "cards" | "wish";
const rank = (n: number) => ORDER.indexOf(BY_NUM.get(n)!.tier);
/** Wanted first, then rarest. */
const wantedFirst = (want: number[]) => (a: number, b: number) => Number(want.includes(b)) - Number(want.includes(a)) || rank(a) - rank(b) || a - b;
const known = (n: number) => BY_NUM.has(n);

export function ProfilePage({ name }: { name: string }) {
  const s = useStore(st)!;
  const mine = useStore(inv);
  const ver = useStore(edits);
  const [p, setP] = useState<Profile | null>(null);
  const [missing, setMissing] = useState(false);
  const [specials, setSpecials] = useState<Special[]>([]);
  const [col, setCol] = useState<Record<number, number[]> | null>(null);
  const [view, setView] = useState<View>("over");
  useEffect(() => {
    let live = true;
    setMissing(false);
    api.profile(name, PACK).then((x) => {
      if (!live) return;
      setP(x);
      api.playerSpecials(name).then((l) => live && setSpecials(l), () => {});
      if (!x.me) api.playerCollection(name, PACK).then((c) => {
        if (!live) return;
        const m: Record<number, number[]> = {};
        for (const k of c.cards) m[k.num] = k.serials;
        setCol(m);
      }, () => {});
    }, (e) => { if (!live) return; if ((e as { code?: string }).code === "unknown_player") setMissing(true); else fail(e); });
    return () => { live = false; };
  }, [name, ver]);
  useEffect(() => { setView("over"); scrollTo(0, 0); }, [name]);

  if (missing) return <div class="pp"><Bar /><div class="s-empty">There's no player called {name}.</div></div>;
  if (!p) return <div class="pp"><Bar /><div class="s-center small"><Spinner /></div></div>;

  const me = p.me;
  const theirs: Record<number, number[]> = me ? mine : col ?? {};
  const wish = me ? (s.wishlist ?? []) : p.wishlist;
  const showcase: (CardRef | number)[] = me ? (s.showcase ?? []) : p.showcase;
  const avatar = me ? s.account.avatar ?? null : p.avatar;
  const banner = me ? s.account.banner ?? null : p.banner;
  const bio = me ? s.account.bio ?? null : p.bio;
  const pct = p.total ? Math.round((p.teams / p.total) * 100) : 0;
  const joined = new Date(p.joined).toLocaleDateString(undefined, { month: "short", year: "numeric" });
  // Spares (two or more) one side has and the other has none of.
  const theyHave = me || !col ? [] : Object.keys(col).map(Number).filter((n) => known(n) && col[n].length >= 2 && !mine[n]?.length).sort(wantedFirst(s.wishlist ?? []));
  const youHave = me || !col ? [] : Object.keys(mine).map(Number).filter((n) => known(n) && mine[n].length >= 2 && !col[n]?.length).sort(wantedFirst(p.wishlist));
  const yourSpares = new Set(Object.keys(mine).map(Number).filter((n) => mine[n].length >= 2));
  const num = (c: CardRef | number) => (typeof c === "number" ? c : c.num);
  const serial = (c: CardRef | number) => (typeof c === "number" ? undefined : c.serial);
  const look = (n: number, sn?: number) => (me ? openCard(n) : openCard(n, undefined, {
    serial: sn, from: `${p.username}'s card.`, action: { label: `Ask ${p.username} for it`, run: () => tradeFor(p.username, n) },
  }));
  const cards = (list: (CardRef | number)[]) => list.filter((c) => known(num(c))).map((c) => (
    <button type="button" class="s-cell" onClick={() => look(num(c), serial(c))}><Card num={num(c)} serial={serial(c)} w="var(--pw)" /></button>
  ));
  const bt = banner ? BY_NUM.get(banner) : undefined;

  return (
    <div class="pp s-profile">
      <div class={cx("pp-banner", !bt?.photo && "plain")} style={bt ? { "--tc": TIERS[bt.tier].color } : undefined}>
        {bt?.photo && <img alt="" draggable={false} decoding="async" src={`/photos/${bt.num}.webp`} />}
        <button type="button" class="s-icon pp-back" onClick={leave} aria-label="Back">‹</button>
      </div>
      <div class="pp-top">
        <Avatar name={p.username} team={avatar} big="huge" />
        <div class="pp-acts">
          {me
            ? <><button type="button" class="s-btn small" onClick={() => openEdit()}>Edit profile</button><button type="button" class="s-icon" onClick={() => openSettings()} aria-label="Settings">⚙</button></>
            : <><button type="button" class="s-btn small" onClick={() => closeAll(() => tradeFor(p.username))}>Trade</button><button type="button" class="s-icon" onClick={() => openReport(p.username)} aria-label={`Report ${p.username}`}>⋯</button></>}
        </div>
      </div>
      <div class="pp-id">
        <h1>{p.firstName || p.username}{p.badge && <em class="s-badge">{p.badge}</em>}</h1>
        <p class="s-dim">@{p.username} · joined {joined}{p.streak ? ` · ${p.streak}-day streak` : ""}</p>
        {bio && <p class="pp-bio">{bio}</p>}
      </div>
      {!me && theyHave.length > 0 && (
        <button type="button" class="pp-match" onClick={() => (youHave.length ? tradeSuggested(p.username, theyHave, youHave) : closeAll(() => tradeFor(p.username, theyHave[0])))}>
          <span><b>{theyHave.length}</b> spare{theyHave.length === 1 ? "" : "s"} you need</span>
          {youHave.length > 0 && <span><b>{youHave.length}</b> of yours they need</span>}
          <em>{youHave.length ? "Start a fair trade" : "Make an offer"} ›</em>
        </button>
      )}
      <div class="pr-stats pp-stats">
        <div><b>{pct}%</b><small>collected</small></div>
        <div><b>{p.tiers[0]}</b><small>mythics</small></div>
        <div><b>{p.trades}</b><small>trades</small></div>
        {p.battle ? <div><b>{p.battle.rating}</b><small>rating</small></div> : <div><b>{p.sets}</b><small>sets</small></div>}
      </div>
      <Tabs value={view} onChange={setView} options={[["over", "Overview"], ["cards", `Cards · ${p.teams}`], ["wish", `Wishlist · ${wish.length}`]]} />

      {view === "over" && <>
        {(me || showcase.length > 0) && (
          <section><h2 class="s-h2">Showcase</h2>
            <div class="pr-row">
              {cards(showcase.slice(0, 3))}
              {me && Array.from({ length: 3 - Math.min(3, showcase.length) }, () => <button type="button" class="pr-empty" onClick={() => openEdit()}>Pin a card</button>)}
            </div>
          </section>
        )}
        {p.pulls.length > 0 && (
          <section><h2 class="s-h2">Big pulls</h2>
            <div class="pp-pulls">{p.pulls.filter((x) => known(x.num)).map((x) => (
              <button type="button" class="pp-pull" onClick={() => openCard(x.num, undefined, { serial: x.serial || undefined, from: `${p.username}'s pull.` })}>
                <Card num={x.num} serial={x.serial || undefined} w="64px" /><small>{ago(x.at)}</small>
              </button>
            ))}</div>
          </section>
        )}
        {p.rarest.length > 0 && <section><h2 class="s-h2">Rarest</h2><div class="pr-row">{cards(p.rarest)}</div></section>}
        {specials.length > 0 && <section><h2 class="s-h2">Special editions</h2><SpecialRow list={specials} /></section>}
        <section><h2 class="s-h2">By rarity</h2>
          <div class="pp-tiers">{ORDER.map((t, i) => (
            <div style={{ "--tc": TIERS[t].color, "--f": POOL[t].length ? p.tiers[i] / POOL[t].length : 0 }}>
              <span>{TIERS[t].label}</span><i /><b>{p.tiers[i]}<small>/{POOL[t].length}</small></b>
            </div>
          ))}</div>
        </section>
        {p.battle && <p class="s-dim pp-battle">Battle: {p.battle.wins} won, {p.battle.losses} lost{p.battle.games - p.battle.wins - p.battle.losses > 0 ? `, ${p.battle.games - p.battle.wins - p.battle.losses} drawn` : ""}.</p>}
      </>}

      {view === "cards" && <Collection p={p} have={me ? mine : col} youNeed={new Set(theyHave)} onLook={look} />}

      {view === "wish" && (wish.length ? (
        <div class="pr-grid">{wish.filter(known).map((n) => (
          <button type="button" class="s-cell" onClick={() => openCard(n, undefined, me ? {} : yourSpares.has(n)
            ? { from: `${p.username} wants this one.`, action: { label: `Offer it to ${p.username}`, run: () => tradeFor(p.username, undefined, n) } }
            : { from: `${p.username} wants this one.` })}>
            <Card num={n} w="var(--pw)">{!me && yourSpares.has(n) && <span class="s-count pp-have">You have a spare</span>}</Card>
          </button>
        ))}</div>
      ) : <p class="s-dim">{me ? "Tap a card you don't have in the binder to add it." : "Nothing on it yet."}</p>)}
    </div>
  );
}

function Bar() {
  return <div class="pp-bar"><button type="button" class="s-icon" onClick={leave} aria-label="Back">‹</button></div>;
}

function Collection({ p, have, youNeed, onLook }: { p: Profile; have: Record<number, number[]> | null; youNeed: Set<number>; onLook: (n: number) => void }) {
  const [f, setF] = useState<"all" | "need" | "spare">("all");
  if (!have) return <div class="s-center small"><Spinner /></div>;
  const all = Object.keys(have).map(Number).filter((n) => known(n) && have[n].length > 0).sort((a, b) => byRarity(BY_NUM.get(a)!, BY_NUM.get(b)!));
  const list = f === "need" ? all.filter((n) => youNeed.has(n)) : f === "spare" ? all.filter((n) => have[n].length >= 2) : all;
  return (
    <>
      <div class="s-chips">
        {([["all", `All · ${all.length}`], ...(p.me ? [] : [["need", `You need · ${youNeed.size}`]]), ["spare", "Spares"]] as [typeof f, string][]).map(([k, l]) => (
          <button type="button" class={cx("s-chip", f === k && "on")} aria-pressed={f === k} onClick={() => setF(k)}>{l}</button>
        ))}
      </div>
      {list.length ? <div class="pr-grid">{list.map((n) => (
        <button type="button" class="s-cell" onClick={() => onLook(n)}><Card num={n} w="var(--pw)">{have[n].length > 1 && <span class="s-count">×{have[n].length}</span>}</Card></button>
      ))}</div> : <p class="s-dim">{f === "need" ? `${p.username} has no spares you're missing.` : "None yet."}</p>}
      <p class="s-dim pp-of">{all.length} of {TEAMS.length} teams</p>
    </>
  );
}

// ---------- editing your profile ----------

function openEdit() {
  push(() => <EditProfile />, "page");
}

type Slot = "avatar" | "banner" | "showcase";

function EditProfile() {
  const s = useStore(st)!;
  const mine = useStore(inv);
  const a = s.account;
  const [bio, setBio] = useState(a.bio ?? "");
  const [avatar, setAvatar] = useState<number | null>(a.avatar ?? null);
  const [banner, setBanner] = useState<number | null>(a.banner ?? null);
  const [show, setShow] = useState<number[]>((s.showcase ?? []).filter((n) => mine[n]?.length));
  const [busy, setBusy] = useState(false);
  const lines = bio.split("\n").filter((l) => l.trim()).length;
  const bad = bio.trim().length > 160 || lines > 3;
  const bt = banner ? BY_NUM.get(banner) : undefined;
  const pick = (slot: Slot) => push(() => <PickCard slot={slot} chosen={slot === "avatar" ? (avatar == null ? [] : [avatar]) : slot === "banner" ? (banner == null ? [] : [banner]) : show}
    onDone={(l) => { if (slot === "avatar") setAvatar(l[0] ?? null); else if (slot === "banner") setBanner(l[0] ?? null); else setShow(l); }} />, "page");
  const save = async () => {
    setBusy(true);
    try {
      const r = await api.editProfile(PACK, bio, avatar, banner);
      const same = show.length === (s.showcase ?? []).length && show.every((n, i) => s.showcase[i] === n);
      const sc = same ? s.showcase : await api.setShowcase(PACK, show);
      const now = st.get()!;
      st.set({ ...now, showcase: sc, account: { ...now.account, bio: r.bio, avatar: r.avatar, banner: r.banner } });
      edits.set(edits.get() + 1);
      toast("Profile saved.");
      back();
    } catch (e) { fail(e); }
    setBusy(false);
  };
  return (
    <div class="s-page-in ed">
      <header class="s-head"><button type="button" class="s-icon" onClick={back} aria-label="Back">‹</button><h1>Edit profile</h1></header>
      <div class="ed-prev">
        <div class={cx("pp-banner", !bt?.photo && "plain")} style={bt ? { "--tc": TIERS[bt.tier].color } : undefined}>
          {bt?.photo && <img alt="" src={`/photos/${bt.num}.webp`} />}
        </div>
        <Avatar name={a.username} team={avatar} big />
        <b>{a.firstName || a.username}</b>
      </div>
      <div class="ed-rows">
        <button type="button" class="ed-row" onClick={() => pick("avatar")}><span><b>Picture</b><small>{avatar ? `${avatar} ${BY_NUM.get(avatar)?.name ?? ""}` : "Your initials"}</small></span><i>›</i></button>
        <button type="button" class="ed-row" onClick={() => pick("banner")}><span><b>Banner</b><small>{banner ? `${banner} ${BY_NUM.get(banner)?.name ?? ""}` : "Plain"}</small></span><i>›</i></button>
        <button type="button" class="ed-row" onClick={() => pick("showcase")}><span><b>Showcase</b><small>{show.length ? show.join(", ") : "Pin up to 3 cards"}</small></span><i>›</i></button>
      </div>
      <label class="ed-bio">
        <span><b>Bio</b><small class={cx(bad && "bad")}>{bio.trim().length}/160</small></span>
        <textarea class="s-input" rows={3} maxLength={200} value={bio} placeholder="Your team, your favorite robot, what you're collecting…" onInput={(e) => setBio(e.currentTarget.value)} />
      </label>
      <button type="button" class="s-btn wide" disabled={busy || bad} onClick={save}>{busy ? <Spinner small /> : "Save"}</button>
      <p class="s-dim ed-note">Your picture and banner come from cards you own. Keep it friendly: everyone can see your profile.</p>
    </div>
  );
}

/** Picks one card (picture, banner) or up to three (showcase) from the teams you own. */
function PickCard({ slot, chosen, onDone }: { slot: Slot; chosen: number[]; onDone: (l: number[]) => void }) {
  const mine = useStore(inv);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(chosen);
  const many = slot === "showcase";
  const owned = Object.keys(mine).map(Number).filter((n) => known(n) && mine[n].length).sort((a, b) => byRarity(BY_NUM.get(a)!, BY_NUM.get(b)!));
  const v = q.trim().toLowerCase();
  const list = v ? owned.filter((n) => String(n).startsWith(v) || BY_NUM.get(n)!.name.toLowerCase().includes(v)) : owned;
  const tap = (n: number) => {
    if (!many) { onDone([n]); back(); return; }
    setSel(sel.includes(n) ? sel.filter((x) => x !== n) : sel.length < 3 ? [...sel, n] : sel);
  };
  return (
    <div class="s-page-in ed-pick">
      <header class="s-head">
        <button type="button" class="s-icon" onClick={back} aria-label="Back">‹</button>
        <h1>{slot === "avatar" ? "Picture" : slot === "banner" ? "Banner" : "Showcase"}</h1>
        <span class="cw-gap" />
        {many ? <button type="button" class="s-btn small" onClick={() => { onDone(sel); back(); }}>Done · {sel.length}/3</button>
          : chosen.length > 0 && <button type="button" class="s-btn small ghost" onClick={() => { onDone([]); back(); }}>{slot === "avatar" ? "Use initials" : "Plain"}</button>}
      </header>
      <input class="s-input" type="search" placeholder="Team number or name" value={q} onInput={(e) => setQ(e.currentTarget.value)} aria-label="Find a team" />
      <div class="ed-grid">
        {list.map((n) => {
          const t = BY_NUM.get(n)!, i = sel.indexOf(n);
          return (
            <button type="button" class={cx("ed-tile", i >= 0 && "on")} style={{ "--tc": TIERS[t.tier].color }} onClick={() => tap(n)} aria-pressed={i >= 0} aria-label={`${n} ${t.name}`}>
              {t.photo ? <img alt="" loading="lazy" decoding="async" src={`/photos/${n}.webp`} /> : <span>#{n}</span>}
              <b>{n}</b>
              {many && i >= 0 && <em>{i + 1}</em>}
            </button>
          );
        })}
      </div>
      {!list.length && <p class="s-dim">{owned.length ? "No team matches that." : "Open some packs first."}</p>}
    </div>
  );
}

// ---------- reporting ----------

const REASONS: [string, string][] = [["username", "Offensive name or bio"], ["cheating", "Cheating"], ["harassment", "Harassment"], ["other", "Something else"]];

function openReport(name: string) {
  push(() => <Report name={name} />, "sheet");
}

function Report({ name }: { name: string }) {
  const [why, setWhy] = useState("");
  const [details, setDetails] = useState("");
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true);
    try { await api.report(name, why, details.trim()); toast(`Thanks. The admin will look at ${name}'s account.`); back(); } catch (e) { fail(e); }
    setBusy(false);
  };
  return (
    <div class="au-sheet" role="dialog" aria-modal="true" aria-label={`Report ${name}`}>
      <h2>Report {name}</h2>
      <div class="s-chips">{REASONS.map(([k, l]) => <button type="button" class={cx("s-chip", why === k && "on")} aria-pressed={why === k} onClick={() => setWhy(k)}>{l}</button>)}</div>
      <textarea class="s-input" rows={3} maxLength={500} placeholder="What happened? (optional)" value={details} onInput={(e) => setDetails(e.currentTarget.value)} />
      <div class="s-row2"><button type="button" class="s-btn" disabled={!why || busy} onClick={send}>Send report</button><button type="button" class="s-btn ghost" onClick={back}>Cancel</button></div>
    </div>
  );
}

