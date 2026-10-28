// A player's profile: how far their collection is, their showcase (3 pinned cards), rarest pulls, wishlist, special
// editions and, for someone else, their whole collection and a way to trade with them.
import { useEffect, useState } from "preact/hooks";
import { api, type CardRef, type Collection, type Profile, type Special } from "../../api";
import { useStore } from "../../lib/store";
import { BY_NUM, byRarity, PACK, TEAMS } from "../data";
import { fail, inv, st } from "../state";
import { Avatar, back, Card, closeAll, push, Spinner } from "../ui";
import { openCard } from "./cardview";
import { openSettings } from "./settings";

export function openProfile(name: string) {
  push(() => <ProfileView name={name} />, "page");
}

/** Trading hasn't moved yet: the current site's trading post, with this player picked. */
const tradeWith = (name: string) => { location.href = `/#trade`; void name; };

function ProfileView({ name }: { name: string }) {
  const [p, setP] = useState<Profile | null>(null);
  const [specials, setSpecials] = useState<Special[]>([]);
  const [col, setCol] = useState<Collection | null>(null);
  const s = useStore(st)!;
  useStore(inv);
  useEffect(() => {
    api.profile(name, PACK).then((x) => {
      setP(x);
      if (!x.me) {
        api.playerSpecials(name).then(setSpecials, () => {});
        api.playerCollection(name, PACK).then(setCol, () => {});
      }
    }, (e) => { fail(e); back(); });
  }, [name]);

  if (!p) return <div class="s-page-in"><div class="s-center small"><Spinner /></div></div>;
  // Your own profile follows what you change (pins, wishlist) without reloading.
  const showcase: (CardRef | number)[] = p.me ? (s.showcase ?? []) : p.showcase;
  const wishlist = p.me ? (s.wishlist ?? []) : p.wishlist;
  const pct = p.total ? Math.round((p.teams / p.total) * 100) : 0;
  const joined = new Date(p.joined).toLocaleDateString(undefined, { month: "short", year: "numeric" });
  const numOf = (c: CardRef | number) => (typeof c === "number" ? c : c.num);
  const serialOf = (c: CardRef | number) => (typeof c === "number" ? undefined : c.serial);
  const theirs = (n: number, serial?: number) => openCard(n, undefined, {
    serial, from: `${p.username}'s card.`,
    action: { label: `Ask ${p.username} for it`, run: () => tradeWith(p.username) },
  });
  const row = (list: (CardRef | number)[], max: number, mine: boolean) => list.slice(0, max).filter((c) => BY_NUM.has(numOf(c))).map((c) => (
    <button type="button" class="s-cell" onClick={() => (mine ? openCard(numOf(c)) : theirs(numOf(c), serialOf(c)))}>
      <Card num={numOf(c)} serial={serialOf(c)} w="var(--pw)" />
    </button>
  ));
  const colList = col ? col.cards.filter((c) => BY_NUM.has(c.num)).sort((a, b) => byRarity(BY_NUM.get(a.num)!, BY_NUM.get(b.num)!)) : [];

  return (
    <div class="s-page-in s-profile">
      <header class="s-head">
        <button type="button" class="s-icon" onClick={back} aria-label="Back">‹</button>
        <span class="cv-gap" />
        {p.me && <button type="button" class="s-btn small ghost" onClick={() => openSettings()}>Settings</button>}
      </header>
      <div class="pf-head">
        <Avatar name={p.username} big />
        <div><h1>{p.username}</h1><p class="s-dim">Joined {joined}{p.streak ? ` · ${p.streak}-day streak` : ""}</p></div>
      </div>
      <div class="pf-stats">
        <div><b>{pct}%</b><small>collected</small></div><div><b>{p.teams}</b><small>teams</small></div>
        <div><b>{p.sets}</b><small>sets</small></div><div><b>{p.trades}</b><small>trades</small></div>
      </div>
      {!p.me && <button type="button" class="s-btn wide" onClick={() => tradeWith(p.username)}>Trade with {p.username}</button>}
      {(p.me || showcase.length > 0) && (
        <section><h2 class="s-h2">Showcase</h2>
          <div class="pf-row">
            {row(showcase, 3, p.me)}
            {p.me && Array.from({ length: 3 - showcase.length }, () => <button type="button" class="pf-empty" onClick={() => closeAll(() => { location.hash = "#binder"; })}>Pin a card</button>)}
          </div>
        </section>
      )}
      {specials.length > 0 && (
        <section><h2 class="s-h2">Special editions</h2>
          <div class="pf-specials">{specials.map((x) => <div class="s-special"><b>{x.title}</b><span>{x.edition} · {x.serial}/{x.total}</span></div>)}</div>
        </section>
      )}
      {p.me && <section><h2 class="s-h2">Rarest pulls</h2><div class="pf-row">{p.rarest.length ? row(p.rarest, 3, true) : <p class="s-dim">No cards yet.</p>}</div></section>}
      {(p.me || wishlist.length > 0) && (
        <section><h2 class="s-h2">Wishlist{wishlist.length ? ` · ${wishlist.length}` : ""}</h2>
          {wishlist.length ? <div class="pf-row wide">{wishlist.slice(0, 12).filter((n) => BY_NUM.has(n)).map((n) => (
            <button type="button" class="s-cell" onClick={() => openCard(n, undefined, p.me ? {} : { from: `${p.username} wants this one.` })}><Card num={n} w="var(--pw)" /></button>
          ))}</div> : <p class="s-dim">Tap a card you don't have in the binder to add it.</p>}
        </section>
      )}
      {!p.me && (
        <section><h2 class="s-h2">Collection {col ? `· ${colList.length} of ${TEAMS.length}` : ""}</h2>
          {col ? <div class="pf-grid">{colList.map((c) => (
            <button type="button" class="s-cell" onClick={() => theirs(c.num)}><Card num={c.num} w="var(--pw)">{c.serials.length > 1 && <span class="s-count">×{c.serials.length}</span>}</Card></button>
          ))}</div> : <div class="s-center small"><Spinner /></div>}
        </section>
      )}
    </div>
  );
}
