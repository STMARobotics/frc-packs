// The trading post: pick a player (good matches first: people with spares you need who need yours, with a fair offer
// already on the table), put up to 5 of your cards (and packs, parts, special editions) and up to 5 of theirs on the
// table, and send the offer. Each card on the table is one particular copy (serial and all); "any" lets the server pick
// your newest copy, so you keep your earliest serial longest. An offer for you can be accepted, declined or answered
// with a counter-offer. Offers for you, sent offers and history each have a tab.
import { useEffect, useState } from "preact/hooks";
import { api, type CardRef, type Collection, type Special, type Trade, type TradeMatch } from "../../api";
import { store, useStore } from "../../lib/store";
import { BY_NUM, byRarity, ORDER, PACK, TEAMS as TEAM_LIST, TIERS, type T } from "../data";
import { ago, applyCollection, applyState, fail, inv, loadSocial, packOf, setPrefs, social, specials as mySpecials, st, toast, trades } from "../state";
import { Avatar, back, cx, push, Spinner, Tabs } from "../ui";
import { sfx } from "../sfx";
import { openCard } from "./cardview";
import { openProfile } from "./profile";
import { Who } from "./social";
import { SpecialCard } from "./special";

const MAX = 5;
const PACK_WORTH = 50, SPECIAL_WORTH = 800; // for weighing a trade: a sealed pack counts as 50 parts

interface Pick { num: number; serial: number } // serial 0: any copy
interface Goods { packs: number; boosted: number; parts: number }
interface Draft {
  name: string;
  /** Their cards: team number to serials. null while loading. */
  theirs: Record<number, number[]> | null;
  theirWish: number[];
  theirGoods: Goods | null;
  theirSpecials: Special[];
  give: Pick[]; get: Pick[];
  giveGoods: Goods; getGoods: Goods;
  giveSpecials: number[]; getSpecials: number[];
  /** The offer this one answers (declined once this one is sent). */
  counter: number;
}
const none = (): Goods => ({ packs: 0, boosted: 0, parts: 0 });
const empty = (name = ""): Draft => ({ name, theirs: null, theirWish: [], theirGoods: null, theirSpecials: [], give: [], get: [], giveGoods: none(), getGoods: none(), giveSpecials: [], getSpecials: [], counter: 0 });

const draft = store<Draft>(empty());
const pane = store<"new" | "in" | "out" | "past">("new");
const edit = (f: (d: Draft) => void) => { const d = structuredClone(draft.get()); f(d); draft.set(d); };

/** Loads a player onto the other side of the table, with these cards of theirs and yours on it. */
async function choose(name: string, wants: Pick[] = [], gives: Pick[] = []) {
  const same = draft.get().name.toLowerCase() === name.toLowerCase();
  if (!same) draft.set({ ...empty(name), give: draft.get().give, giveGoods: draft.get().giveGoods, giveSpecials: draft.get().giveSpecials });
  try {
    const [col, prof] = await Promise.all([api.playerCollection(name, PACK), api.profile(name, PACK)]);
    if (draft.get().name !== name) return;
    edit((d) => {
      d.theirs = {};
      for (const c of col.cards) if (BY_NUM.has(c.num)) d.theirs[c.num] = c.serials;
      d.theirWish = prof.wishlist;
      d.theirGoods = { packs: prof.packs, boosted: prof.boosted, parts: prof.parts };
      for (const w of wants) if (d.theirs[w.num] && d.get.length < MAX && !d.get.some((p) => p.num === w.num)) d.get.push(w);
      for (const g of gives) if (inv.get()[g.num]?.length && d.give.length < MAX && !d.give.some((p) => p.num === g.num)) d.give.push(g);
    });
    api.playerSpecials(name).then((l) => { if (draft.get().name === name) edit((d) => { d.theirSpecials = l; }); }, () => {});
  } catch (e) {
    if (draft.get().name !== name) return;
    draft.set({ ...draft.get(), name: "" });
    if ((e as { code?: string }).code === "unknown_player") toast(`There's no player named ${name}.`, true); else fail(e);
  }
}

/** From anywhere: the trading post with this player, and a card of theirs you want (or one of yours) on the table. */
export function tradeFor(name: string, want?: number, give?: number) {
  pane.set("new");
  location.hash = "#trade";
  choose(name, want ? [{ num: want, serial: 0 }] : [], give ? [{ num: give, serial: 0 }] : []);
}

/** A fair first offer from two lists of spares: up to 3 of theirs (wanted and rarest first), each matched with one of
    yours of the same rarity, or the nearest one. */
export function suggest(theyHave: number[], youHave: number[]): { get: number[]; give: number[] } {
  const rank = (n: number) => ORDER.indexOf(BY_NUM.get(n)!.tier);
  const get = theyHave.filter((n) => BY_NUM.has(n)).slice(0, 3);
  const left = youHave.filter((n) => BY_NUM.has(n));
  const give: number[] = [];
  for (const g of get) {
    if (!left.length) break;
    let bi = 0;
    for (let i = 1; i < left.length; i++) if (Math.abs(rank(left[i]) - rank(g)) < Math.abs(rank(left[bi]) - rank(g))) bi = i;
    give.push(left.splice(bi, 1)[0]);
  }
  return { get: get.slice(0, give.length), give };
}

/** The trading post with a fair offer to this player already on the table (see `suggest`). */
export function tradeSuggested(name: string, theyHave: number[], youHave: number[]) {
  const { get, give } = suggest(theyHave, youHave);
  pane.set("new");
  location.hash = "#trade";
  draft.set(empty());
  choose(name, get.map((num) => ({ num, serial: 0 })), give.map((num) => ({ num, serial: 0 })));
}

/** Answers an offer with another: the same cards on the table, to change before sending. Sending it declines theirs. */
function counterOffer(t: Trade) {
  const goods = (packs: number, boosted: number, parts: number): Goods => ({ packs, boosted, parts });
  draft.set({
    ...empty(t.with),
    give: t.youGive.map((c) => ({ num: c.num, serial: c.serial })),
    giveGoods: goods(t.youGivePacks, t.youGiveBoosted, t.youGiveParts),
    giveSpecials: t.youGiveSpecials.map((x) => x.id),
    getGoods: goods(t.youGetPacks, t.youGetBoosted, t.youGetParts),
    getSpecials: t.youGetSpecials.map((x) => x.id),
    counter: t.id,
  });
  pane.set("new");
  choose(t.with, t.youGet.map((c) => ({ num: c.num, serial: c.serial })));
}
/** From your binder: that card on your side; then pick who to trade with. */
/** Starts a trade offering this card (`serial`: that copy in particular, else any). */
export function offerFromBinder(num: number, serial = 0) {
  pane.set("new");
  edit((d) => { if (d.give.length < MAX && !d.give.some((p) => p.num === num && (!serial || p.serial === serial))) d.give.push({ num, serial }); });
  location.hash = "#trade";
}

export function TradeTab({ active }: { active: boolean }) {
  const tr = useStore(trades);
  const p = useStore(pane);
  useEffect(() => {
    if (!active) return;
    // Open on the offers waiting for you, if there are any.
    const toOffers = (t: { incoming: unknown[] }) => { if (t.incoming.length && pane.get() === "new" && !draft.get().name) pane.set("in"); };
    toOffers(tr);
    api.trades().then((t) => { trades.set(t); toOffers(t); }, () => {});
    api.specials().then(mySpecials.set, () => {});
    loadSocial();
    // Offers change on the other side too (accepted, declined, a new one): a look every 30 seconds while you're here,
    // and none while the app is in the background.
    const t = setInterval(() => { if (document.visibilityState === "visible") api.trades().then(trades.set, () => {}); }, 30_000);
    return () => clearInterval(t);
  }, [active]);
  return (
    <div class="s-screen s-trade">
      <Tabs value={p} onChange={(v) => pane.set(v)} options={[["new", "New"], ["in", <>For you{tr.incoming.length ? <em class="s-dot in">{tr.incoming.length}</em> : null}</>], ["out", "Sent"], ["past", "History"]]} />
      {p === "new" && <NewTrade />}
      {p === "in" && <Offers list={tr.incoming} kind="in" />}
      {p === "out" && <Offers list={tr.outgoing} kind="out" />}
      {p === "past" && <History />}
    </div>
  );
}

// ---------- a new trade ----------

const collectionCards = (collection: Collection) => {
  const cards: Record<number, number[]> = {};
  for (const card of collection.cards) cards[card.num] = card.serials;
  return cards;
};

function Fairness({ giveCards, giveGoods, giveSpecials, getCards, getGoods, getSpecials }: {
  giveCards: { num: number }[]; giveGoods: Goods; giveSpecials: number;
  getCards: { num: number }[]; getGoods: Goods; getSpecials: number;
}) {
  const s = useStore(st)!;
  const sideWorth = (cards: { num: number }[], goods: Goods, specials: number) =>
    cards.reduce((sum, card) => sum + (BY_NUM.get(card.num) ? s.scrapParts[BY_NUM.get(card.num)!.tier] ?? 0 : 0), 0)
    + specials * SPECIAL_WORTH + goods.packs * PACK_WORTH + goods.boosted * s.boostCost + goods.parts;
  const give = sideWorth(giveCards, giveGoods, giveSpecials);
  const get = sideWorth(getCards, getGoods, getSpecials);
  if (!give && !get) return null;
  const lean = (get - give) / (get + give);
  const summary = Math.abs(lean) < 0.2 ? "Looks even" : lean > 0 ? (lean > 0.6 ? "A big ask" : "You get more") : lean < -0.6 ? "Very generous" : "You give more";
  return (
    <div class="td-fair" role="group" aria-label="Estimated trade fairness">
      <span class="td-fairbar" style={{ "--lean": lean.toFixed(3) }}><i /></span>
      <small>{summary}</small>
    </div>
  );
}

function NewTrade() {
  const d = useStore(draft);
  const s = useStore(st)!;
  const mine = useStore(inv);
  const [busy, setBusy] = useState(false);

  if (!d.name) return <PickPlayer />;
  const giving = d.give.length || d.giveSpecials.length || d.giveGoods.packs || d.giveGoods.boosted || d.giveGoods.parts;
  const getting = d.get.length || d.getSpecials.length || d.getGoods.packs || d.getGoods.boosted || d.getGoods.parts;
  const iWant = d.theirs ? (s.wishlist ?? []).filter((n) => d.theirs![n]).length : 0;
  const theyWant = d.theirWish.filter((n) => mine[n]?.length).length;

  const send = async () => {
    setBusy(true);
    try {
      const t = await api.offerTrade(d.name, PACK, d.give.map((p) => p.num), d.get.map((p) => p.num), {
        givePacks: d.giveGoods.packs, wantPacks: d.getGoods.packs, giveBoosted: d.giveGoods.boosted, wantBoosted: d.getGoods.boosted,
        giveParts: d.giveGoods.parts, wantParts: d.getGoods.parts, giveSpecials: d.giveSpecials, wantSpecials: d.getSpecials,
        giveSerials: d.give.map((p) => p.serial), wantSerials: d.get.map((p) => p.serial),
      });
      trades.set(d.counter ? await api.declineTrade(d.counter).catch(() => t) : t);
      sfx.whoosh();
      toast(d.counter ? `Counter-offer sent to ${d.name}.` : `Offer sent to ${d.name}. It's under Sent until they answer.`);
      const name = d.name;
      draft.set(empty());
      choose(name);
    } catch (e) { fail(e); }
    setBusy(false);
  };

  return (
    <>
      <div class="td-who">
        <button type="button" class="td-whob" onClick={() => openProfile(d.name)}><Avatar name={d.name} /><b>{d.name}</b></button>
        <button type="button" class="s-chipbtn" onClick={() => draft.set({ ...empty(), give: d.give, giveGoods: d.giveGoods, giveSpecials: d.giveSpecials })}>{d.counter ? "Cancel" : "Change"}</button>
      </div>
      {d.counter > 0 && <p class="td-match">A counter-offer. Sending it declines theirs.</p>}
      {(iWant > 0 || theyWant > 0) && <p class="td-match">{[iWant ? `${d.name} has ${iWant} from your wishlist` : "", theyWant ? `you have ${theyWant} they want` : ""].filter(Boolean).join(" · ")}</p>}
      <div class="td-table">
        <Side label="You give" picks={d.give} goods={d.giveGoods} specials={mySpecials.get().filter((x) => d.giveSpecials.includes(x.id))} side="give" recipient={d.name} recipientCards={d.theirs ?? undefined} ownerCards={mine} />
        <Side label="You get" picks={d.get} goods={d.getGoods} specials={d.theirSpecials.filter((x) => d.getSpecials.includes(x.id))} side="get" recipient="you" recipientCards={mine} ownerCards={d.theirs ?? undefined} />
      </div>
      <Fairness giveCards={d.give} giveGoods={d.giveGoods} giveSpecials={d.giveSpecials.length} getCards={d.get} getGoods={d.getGoods} getSpecials={d.getSpecials.length} />
      <button type="button" class="s-btn wide" disabled={!giving || !getting || busy} onClick={send}>
        {busy ? <Spinner small /> : !giving && !getting ? "Put something on the table" : !giving ? "Add something you give" : !getting ? "Add something you want" : d.counter ? `Send counter-offer to ${d.name}` : `Send offer to ${d.name}`}
      </button>
    </>
  );
}

function PickPlayer() {
  const so = useStore(social);
  const me = useStore(st)!.account.username.toLowerCase();
  const [q, setQ] = useState("");
  const [sugg, setSugg] = useState<string[]>([]);
  useEffect(() => {
    const v = q.trim();
    if (!v) { setSugg([]); return; }
    const t = setTimeout(() => api.players(v).then((n) => setSugg(n.filter((x) => x.toLowerCase() !== me)), () => {}), 200);
    return () => clearTimeout(t);
  }, [q]);
  const [matches, setMatches] = useState<TradeMatch[] | null>(null);
  useEffect(() => { api.tradeMatches(PACK).then(setMatches, () => setMatches([])); }, []);
  const players = (so?.players ?? []).filter((p) => p.name.toLowerCase() !== me && (!q.trim() || p.name.toLowerCase().includes(q.trim().toLowerCase()) || (p.firstName ?? "").toLowerCase().includes(q.trim().toLowerCase())));
  const known = new Set(players.map((p) => p.name.toLowerCase()));
  // Looking for a team rather than a player: its card shows who has it (and who has spares) to trade with.
  const needle = q.trim().toLowerCase();
  const teams = needle ? TEAM_LIST.filter((t) => String(t.num) === needle || (needle.length >= 3 && t.name.toLowerCase().includes(needle))).slice(0, 4) : [];
  return (
    <>
      <input autoComplete="off" data-1p-ignore data-lpignore="true" data-form-type="other" class="s-input" type="search" placeholder="A player, or a team you're after" value={q} onInput={(e) => setQ(e.currentTarget.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && q.trim()) choose(sugg[0] ?? q.trim()); }} autoCapitalize="none" spellcheck={false} aria-label="Player" />
      {!q.trim() && matches && matches.length > 0 && (
        <section class="td-matches">
          <h2 class="s-h2">Good matches</h2>
          <div class="s-list">
            {matches.slice(0, 5).map((m) => (
              <button key={m.name} type="button" class="td-person td-mrow" onClick={() => tradeSuggested(m.name, m.theyHave, m.youHave)}>
                <Avatar name={m.name} team={m.avatar} />
                <span class="td-mwho"><Who p={{ name: m.name, firstName: m.firstName, badge: m.badge }} /><small>Has {m.theyHave.length} you need · needs {m.youHave.length} of yours</small></span>
                <span class="td-mcards" aria-hidden="true">{m.theyHave.slice(0, 3).map((n) => <i style={{ "--tc": TIERS[BY_NUM.get(n)?.tier ?? "common"].color }} />)}</span>
              </button>
            ))}
          </div>
          <h2 class="s-h2">Everyone</h2>
        </section>
      )}
      {teams.length > 0 && (
        <div class="s-list td-teams">
          {teams.map((t) => (
            <button type="button" class="td-person" onClick={() => openCard(t.num)}>
              <Mini num={t.num} /><span class="td-mwho"><b>{t.name}</b><small>{t.num} · {inv.get()[t.num]?.length ? `you have ×${inv.get()[t.num].length}` : "you don't have it"} · see who has it</small></span>
            </button>
          ))}
        </div>
      )}
      <div class="s-list">
        {sugg.filter((n) => !known.has(n.toLowerCase())).map((n) => (
          <button type="button" class="td-person" onClick={() => choose(n)}><Avatar name={n} /><span class="so-name">{n}</span></button>
        ))}
        {players.map((p) => (
          <button key={p.name} type="button" class="td-person" onClick={() => choose(p.name)}><Avatar name={p.name} team={p.avatar} /><Who p={p} /><small>{p.teams} teams</small></button>
        ))}
        {!so && <div class="s-center small"><Spinner /></div>}
      </div>
    </>
  );
}

function Side({ label, picks, goods, specials, side, recipient, recipientCards, ownerCards }: {
  label: string; picks: Pick[]; goods: Goods; specials: Special[]; side: "give" | "get"; recipient: string;
  recipientCards: Record<number, number[]> | null | undefined; ownerCards: Record<number, number[]> | null | undefined;
}) {
  const remove = (i: number) => { sfx.tick(); edit((d) => { (side === "give" ? d.give : d.get).splice(i, 1); }); };
  return (
    <div class={cx("td-side", side)}>
      <div class="td-side-h"><b>{label}</b><small>{picks.length}/{MAX}</small></div>
      <div class="td-slots">
        {picks.map((p, i) => {
          const ownerCount = ownerCards?.[p.num]?.length ?? 0;
          return (
            <span key={`${p.num}:${p.serial}:${i}`} class="td-slot full">
              <button type="button" class="td-slotcard" onClick={() => inspect(side, p.num)} aria-label={`${BY_NUM.get(p.num)!.name}: see or change the copy`}>
                <Mini num={p.num} foot={p.serial ? `No. ${p.serial}` : "Any copy"} />
              </button>
              {ownerCount > 1 && <small class="td-spare-cue" data-num={p.num} aria-label={`${side === "give" ? "You have" : "Your trade partner has"} ${ownerCount} copies`}>×{ownerCount}</small>}
              <RecipientCue name={recipient} copies={recipientCards?.[p.num] ?? (recipientCards === undefined ? undefined : recipientCards === null ? null : [])} />
              <button type="button" class="td-x" onClick={() => remove(i)} aria-label={`Take ${BY_NUM.get(p.num)!.name} off`}>×</button>
            </span>
          );
        })}
        {picks.length < MAX && <button type="button" class="td-slot" onClick={() => openPicker(side)} aria-label="Add a card"><span>+</span></button>}
      </div>
      <Chips goods={goods} specials={specials} onClick={() => openPicker(side, "goods")} />
    </div>
  );
}

function RecipientCue({ name, copies }: { name: string; copies: number[] | null | undefined }) {
  if (copies === undefined) return <small class="td-owner-cue checking" aria-label={`Checking ${name}'s collection`}>Checking…</small>;
  if (copies === null) return <small class="td-owner-cue unavailable" aria-label={`Could not check ${name}'s collection`}>Unknown</small>;
  if (!copies.length) {
    const recipient = name === "you" ? "you" : "them";
    return <small class="td-owner-cue new" title={`New to ${name}`} aria-label={`New to ${name}`}>New to {recipient}</small>;
  }
  const owner = name === "you" ? "You" : name;
  const verb = name === "you" ? "own" : "owns";
  const copiesText = `${copies.length} ${copies.length === 1 ? "copy" : "copies"}`;
  const message = `${owner} already ${verb} ${copiesText}; receiving this card would be a duplicate`;
  return <small class="td-owner-cue owned" title={message} aria-label={message}>Owns ×{copies.length}</small>;
}

function Chips({ goods, specials, onClick }: { goods: Goods; specials: Special[]; onClick?: () => void }) {
  const any = goods.packs || goods.boosted || goods.parts || specials.length;
  const body = <>
    {goods.packs > 0 && <span class="td-chip pack">{goods.packs} {goods.packs === 1 ? "pack" : "packs"}</span>}
    {goods.boosted > 0 && <span class="td-chip gold">{goods.boosted} boosted</span>}
    {specials.map((x) => <span class="td-chip special">{x.edition} No. {String(x.serial).padStart(3, "0")}</span>)}
    {goods.parts > 0 && <span class="td-chip parts">{goods.parts} parts</span>}
  </>;
  if (!onClick) return any ? <div class="td-chips">{body}</div> : null;
  return <button type="button" class="td-chips btn" onClick={onClick}>{any ? body : <span class="s-dim">+ Packs and parts</span>}</button>;
}

/** A small card: the photo, number and name, framed in its rarity. */
export function Mini({ num, foot }: { num: number; foot?: string }) {
  const t = BY_NUM.get(num);
  if (!t) return null;
  return (
    <span class={cx("s-mini", `t-${t.tier}`)}>
      {t.photo ? <img alt="" src={`/photos/${num}.webp`} decoding="async" loading="lazy" draggable={false} /> : <span class="mi-noph">{num}</span>}
      <span class="mi-num">{num}</span>
      <span class="mi-name">{t.name}</span>
      {foot && <span class="mi-foot">{foot}</span>}
    </span>
  );
}

// ---------- the picker: cards, or packs and parts, for one side ----------

/** `num`: a card on the table, its copies open to see or change which one. */
function openPicker(side: "give" | "get", kind: "cards" | "goods" = "cards", num?: number) {
  push(() => <Picker side={side} start={kind} focus={num} />, "page");
}

/** A card on the table: its copies, to see or change which one goes; with only one copy, the card itself. */
function inspect(side: "give" | "get", num: number) {
  const d = draft.get(), cards = (side === "give" ? inv.get() : d.theirs ?? {})[num] ?? [];
  if (cards.length > 1) return openPicker(side, "cards", num);
  openCard(num, undefined, { serial: cards[0], from: side === "give" ? "Your card." : `${d.name}'s card.` });
}

/** Why each copy of yours that can't go in an offer now can't: in the pack you're opening, in an offer you sent, or
    asked for in one sent to you. */
function heldWhy(s: { pending?: { cards: { num: number; serial: number }[] } | null }) {
  const why = new Map<string, string>();
  s.pending?.cards.forEach((c) => why.set(`${c.num}:${c.serial}`, "in the pack you're opening"));
  const tr = trades.get();
  tr.outgoing.forEach((x) => x.youGive.forEach((c) => why.set(`${c.num}:${c.serial}`, `in your offer to ${x.with}`)));
  tr.incoming.forEach((x) => x.youGive.forEach((c) => why.set(`${c.num}:${c.serial}`, `asked for by ${x.with}`)));
  return why;
}

function Picker({ side, start, focus }: { side: "give" | "get"; start: "cards" | "goods"; focus?: number }) {
  const d = useStore(draft);
  const s = useStore(st)!;
  const myCards = useStore(inv);
  const specialsMine = useStore(mySpecials);
  const [kind, setKind] = useState(start);
  const [q, setQ] = useState("");
  const [tier, setTier] = useState<"all" | T["tier"]>("all");
  const mine = side === "give";
  const cards: Record<number, number[]> = mine ? myCards : d.theirs ?? {};
  const [copies, setCopies] = useState<number | null>(focus != null && (cards[focus]?.length ?? 0) > 1 ? focus : null);
  const [onlyNeeds, setOnlyNeeds] = useState(false);
  const [onlyWishlist, setOnlyWishlist] = useState(false);
  const [onlySpares, setOnlySpares] = useState(false);
  const picks = mine ? d.give : d.get;
  // Your copies the server won't put in another offer, and why.
  const held = mine ? heldWhy(s) : new Map<string, string>();
  const free = (n: number) => cards[n].filter((sn) => !held.has(`${n}:${sn}`)).length;
  const otherSide: Record<number, number[]> = mine ? d.theirs ?? {} : myCards;
  const isSpare = (n: number) => cards[n].length > 1 && (!mine || free(n) > 0);
  const isNeeded = (n: number) => mine
    ? d.theirs !== null && !d.theirs?.[n]?.length
    : !myCards[n]?.length;
  const isWishlisted = (n: number) => mine ? d.theirWish.includes(n) : (s.wishlist ?? []).includes(n);
  const matchesFilters = (n: number) =>
    ((!onlyNeeds && !onlyWishlist) || (onlyNeeds && isNeeded(n)) || (onlyWishlist && isWishlisted(n)))
      && (!onlySpares || isSpare(n));
  const hasFilters = onlyNeeds || onlyWishlist || onlySpares;
  const needle = q.trim().toLowerCase();
  const list = Object.keys(cards).map(Number).map((n) => BY_NUM.get(n)).filter((t): t is T => !!t && cards[t.num].length > 0)
    .filter((t) => (tier === "all" || t.tier === tier) && (!needle || String(t.num).startsWith(needle) || t.name.toLowerCase().includes(needle)))
    .filter((t) => !hasFilters || matchesFilters(t.num))
    // Relevant cards first, then your spares when you're giving so your only copies aren't the first thing on offer.
    .sort((a, b) => Number(matchesFilters(b.num)) - Number(matchesFilters(a.num))
      || (mine ? Number(cards[b.num].length > 1) - Number(cards[a.num].length > 1) : 0)
      || byRarity(a, b));
  const onTable = (n: number) => picks.filter((p) => p.num === n).length;

  const tap = (n: number) => {
    if (mine && !onTable(n) && !free(n)) {
      const why = [...new Set(cards[n].map((sn) => held.get(`${n}:${sn}`)).filter(Boolean))];
      return toast(`Can't offer it right now: ${cards[n].length > 1 ? "every copy is " : "it's "}${why.join(", or ")}.`, true, 3500);
    }
    if (cards[n].length > 1) return setCopies(n);
    if (onTable(n)) { sfx.tick(); return edit((x) => { const a = mine ? x.give : x.get; a.splice(a.findIndex((p) => p.num === n), 1); }); }
    if (picks.length >= MAX) return toast(`Up to ${MAX} cards on each side.`, true);
    sfx.pick();
    edit((x) => { (mine ? x.give : x.get).push({ num: n, serial: 0 }); });
  };
  const toggleCopy = (n: number, serial: number) => edit((x) => {
    const a = mine ? x.give : x.get;
    const i = a.findIndex((p) => p.num === n && p.serial === serial);
    if (i >= 0) { a.splice(i, 1); sfx.tick(); return; }
    if (a.length >= MAX) { toast(`Up to ${MAX} cards on each side.`, true); return; }
    // "Any copy" picks of the same team become this one.
    const anyI = a.findIndex((p) => p.num === n && !p.serial);
    if (anyI >= 0) a.splice(anyI, 1);
    a.push({ num: n, serial });
    sfx.pick();
  });

  const max: Goods | null = mine ? { packs: packOf(s).sealed - packOf(s).boosted, boosted: packOf(s).boosted, parts: s.parts } : d.theirGoods;
  const goods = mine ? d.giveGoods : d.getGoods;
  const setGoods = (k: keyof Goods, v: number) => edit((x) => { (mine ? x.giveGoods : x.getGoods)[k] = Math.max(0, Math.min(v, max?.[k] ?? 0, k === "parts" ? 100000 : 50)); });
  const specs = mine ? specialsMine : d.theirSpecials;
  const specOn = mine ? d.giveSpecials : d.getSpecials;

  return (
    <div class="s-page-in td-picker">
      <header class="s-head"><h1>{mine ? "You give" : `From ${d.name}`}</h1><span class="cw-gap" /><button type="button" class="s-btn small" onClick={back}>Done</button></header>
      <Tabs value={kind} onChange={setKind} options={[["cards", `Cards ${picks.length}/${MAX}`], ["goods", "Packs and parts"]]} />
      {kind === "goods" ? (
        !max ? <Spinner /> : (
          <div class="s-list">
            {(["packs", "boosted"] as const).map((k) => (
              <div class="gd-row">
                <span class={cx("gd-art", k === "boosted" && "gold")} />
                <span class="gd-t"><b>{k === "packs" ? "Standard pack" : "Boosted pack"}</b><small>{max[k]} {mine ? "in your stack" : "they have"}</small></span>
                <span class="s-stepper"><button type="button" disabled={!goods[k]} onClick={() => setGoods(k, goods[k] - 1)} aria-label="One fewer">−</button><b>{goods[k]}</b><button type="button" disabled={goods[k] >= Math.min(max[k], 50)} onClick={() => setGoods(k, goods[k] + 1)} aria-label="One more">+</button></span>
              </div>
            ))}
            <div class="gd-row">
              <span class="gd-art parts" />
              <span class="gd-t"><b>Parts</b><small>{max.parts} {mine ? "available" : "they have"}</small></span>
              <input autoComplete="off" data-1p-ignore data-lpignore="true" data-form-type="other" class="s-input gd-in" type="number" inputMode="numeric" min={0} max={max.parts} step={10} value={goods.parts || ""} placeholder="0" aria-label="Parts" onChange={(e) => setGoods("parts", Math.floor(+e.currentTarget.value || 0))} />
            </div>
            {specs.length > 0 && <>
              <h2 class="s-h2">Special editions</h2>
              <div class="se-row">{specs.map((x) => (
                <button type="button" class={cx("se-thumb", specOn.includes(x.id) && "on")} aria-pressed={specOn.includes(x.id)} aria-label={`${x.title}, No. ${x.serial} of ${x.total}`} onClick={() => edit((dd) => { const a = mine ? dd.giveSpecials : dd.getSpecials; const i = a.indexOf(x.id); if (i >= 0) a.splice(i, 1); else if (a.length < MAX) a.push(x.id); })}>
                  <SpecialCard sp={x} w="100%" />
                </button>
              ))}</div>
            </>}
          </div>
        )
      ) : (
        <>
          <input autoComplete="off" data-1p-ignore data-lpignore="true" data-form-type="other" class="s-input" type="search" placeholder="Search number or name" value={q} onInput={(e) => setQ(e.currentTarget.value)} aria-label="Search cards" />
          <div class="s-chips td-rarity-filters">{(["all", ...ORDER] as const).map((t) => (
            <button type="button" class={cx("s-chip", tier === t && "on")} aria-pressed={tier === t} style={t !== "all" ? { "--tc": TIERS[t].color } : undefined} onClick={() => setTier(t)}>{t === "all" ? "All" : <b>{TIERS[t].label}</b>}</button>
          ))}</div>
          <div class="s-chips td-picker-filters">
            <button type="button" class={cx("s-chip", "td-needs-filter", onlyNeeds && "on")} aria-label={mine ? "Filter cards your partner needs" : "Filter cards you need"} aria-pressed={onlyNeeds} onClick={() => setOnlyNeeds(!onlyNeeds)}>Needs</button>
            <button type="button" class={cx("s-chip", "td-wishlist-filter", onlyWishlist && "on")} aria-label={mine ? "Filter cards on your partner's wishlist" : "Filter cards on your wishlist"} aria-pressed={onlyWishlist} onClick={() => setOnlyWishlist(!onlyWishlist)}>Wishlist</button>
            <button type="button" class={cx("s-chip", "td-spares-filter", onlySpares && "on")} aria-label={mine ? "Filter your spare cards" : "Filter your partner's spare cards"} aria-pressed={onlySpares} onClick={() => setOnlySpares(!onlySpares)}>Only Spares</button>
          </div>
          {!list.length ? <div class="s-empty">{needle || tier !== "all" || hasFilters ? "No cards match." : mine ? "Open some packs first." : `${d.name} has no cards yet.`}</div> : (
            <div class="td-grid">
              {list.slice(0, 120).map((t) => {
                const n = t.num, on = onTable(n), total = cards[n].length, stuck = mine && !on && !free(n), other = otherSide[n]?.length ?? 0;
                return (
                  <div class="td-cell" key={n} data-num={n}>
                    <button type="button" class={cx("td-pick", on > 0 && "on", stuck && "held")} aria-pressed={on > 0} onClick={() => tap(n)}>
                      <Mini num={n} foot={total > 1 ? `×${total}` : mine ? "Only copy" : TIERS[t.tier].label} />
                      {on > 0 && <span class="td-on">{total > 1 ? `${on} of ${total}` : "On table"}</span>}
                      {stuck && <span class="td-on td-held" title={[...new Set(cards[n].map((sn) => held.get(`${n}:${sn}`)).filter(Boolean))].join(", ")}>In a trade</span>}
                    </button>
                    <div class="td-picker-cues" aria-label="Trade hints">
                      {other > 0 && <span class="td-picker-cue owned">{mine ? "They have" : "You have"} ×{other}</span>}
                      {mine && isNeeded(n) && <span class="td-picker-cue need">They need</span>}
                      {!mine && isNeeded(n) && <span class="td-picker-cue need">You need</span>}
                      {mine && isWishlisted(n) && <span class="td-picker-cue wishlist">Their wishlist</span>}
                      {!mine && isWishlisted(n) && <span class="td-picker-cue wishlist">Your wishlist</span>}
                    </div>
                    <button type="button" class="td-info" aria-label={`See ${t.name}`} onClick={() => openCard(n, undefined, { serial: cards[n]?.slice().sort((x, y) => x - y)[0], serials: cards[n]?.slice().sort((x, y) => x - y), from: mine ? `You have ${total === 1 ? "1 copy" : `${total} copies`}.` : `${d.name} has ${total === 1 ? "1 copy" : `${total} copies`}.` })}>i</button>
                  </div>
                );
              })}
            </div>
          )}
          {list.length > 120 && <p class="s-dim center">Showing 120 of {list.length}. Search to find the rest.</p>}
        </>
      )}
      {copies !== null && (
        <div class="td-copies" role="dialog">
          <div class="s-head"><b>{BY_NUM.get(copies)!.name} <small class="s-dim">{copies}</small></b><span class="cw-gap" /><button type="button" class="s-btn small" onClick={() => setCopies(null)}>Done</button></div>
          <p class="s-dim">Pick the copies to {mine ? "give" : "ask for"}. Low serials are worth more.{picks.some((p) => p.num === copies && !p.serial) ? ` "Any copy" lets the server pick ${mine ? "your" : "their"} newest.` : ""}</p>
          <div class="s-chips">
            {cards[copies].slice().sort((a, b) => a - b).map((sn) => {
              const on = picks.some((p) => p.num === copies && p.serial === sn), why = held.get(`${copies}:${sn}`);
              return <button type="button" class={cx("s-chip", on && "on", sn <= 10 && "low", why && "held")} aria-pressed={on} aria-disabled={!!why}
                onClick={() => (why ? toast(`No. ${sn} is ${why}.`, true, 3000) : toggleCopy(copies, sn))}>No. {sn}{why && <small> · in use</small>}</button>;
            })}
          </div>
          <button type="button" class="s-chipbtn td-see" onClick={() => openCard(copies, undefined, { serials: cards[copies].slice().sort((a, b) => a - b), from: mine ? "Your card." : `${d.name}'s card.` })}>See the card</button>
        </div>
      )}
    </div>
  );
}

// ---------- offers ----------

function Offers({ list, kind }: { list: Trade[]; kind: "in" | "out" }) {
  const [counterpartyCards, setCounterpartyCards] = useState<Record<string, Record<number, number[]> | null>>({});
  const collectionKeys = [...new Set(list.map((t) => `${t.pack}\u001f${t.with.toLowerCase()}`))].sort();
  const requestKey = collectionKeys.join("\u001e");
  useEffect(() => {
    let active = true;
    const players = new Map<string, { name: string; pack: string }>();
    for (const t of list) players.set(`${t.pack}\u001f${t.with.toLowerCase()}`, { name: t.with, pack: t.pack });
    setCounterpartyCards({});
    Promise.all([...players].map(async ([key, player]) => {
      try {
        return [key, collectionCards(await api.playerCollection(player.name, player.pack))] as const;
      } catch {
        return [key, null] as const;
      }
    })).then((loaded) => { if (active) setCounterpartyCards(Object.fromEntries(loaded)); });
    return () => { active = false; };
  }, [requestKey]);

  if (!list.length) return <div class="s-empty">{kind === "in" ? "No offers right now. When someone wants to trade with you, it shows up here." : "Nothing sent. Offers you send wait here until they answer."}</div>;
  return <div class="s-list">{list.map((t) => {
    const key = `${t.pack}\u001f${t.with.toLowerCase()}`;
    return <Offer key={t.id} t={t} kind={kind} recipientCards={counterpartyCards[key]} />;
  })}</div>;
}

/** `own`: under each card, how many copies of that team you have now (open offers only). */
function Row({ label, cards, goods, specials, whose, own, recipient, recipientCards }: {
  label: string; cards: CardRef[]; goods: Goods; specials: Special[]; whose: string; own?: Record<number, number[]>;
  recipient?: string; recipientCards?: Record<number, number[]> | null;
}) {
  if (!cards.length && !goods.packs && !goods.boosted && !goods.parts && !specials.length) return null;
  return (
    <div class="td-o-side">
      <small>{label}</small>
      <div class="td-o-cards">
        {cards.filter((c) => BY_NUM.has(c.num)).map((c) => (
          <button type="button" class="td-o-card" onClick={() => openCard(c.num, undefined, { serial: c.serial, from: whose === "you" ? "Your copy in this trade." : `${whose}'s copy in this trade.` })}>
            <Mini num={c.num} foot={`No. ${c.serial}`} />
            {own && <small class="td-own">{own[c.num]?.length ? `You have ×${own[c.num].length}` : "You have none"}</small>}
            {recipient && <RecipientCue name={recipient} copies={recipientCards === undefined ? undefined : recipientCards === null ? null : recipientCards[c.num] ?? []} />}
          </button>
        ))}
      </div>
      <Chips goods={goods} specials={specials} />
    </div>
  );
}

function Offer({ t, kind, recipientCards }: { t: Trade; kind: "in" | "out"; recipientCards: Record<number, number[]> | null | undefined }) {
  const [busy, setBusy] = useState(false);
  const run = async (f: () => Promise<void>) => { setBusy(true); try { await f(); } catch (e) { fail(e); api.trades().then(trades.set, () => {}); } setBusy(false); };
  const accept = () => run(async () => {
    const r = await api.acceptTrade(t.id);
    applyState(r.state); applyCollection(r.collection); trades.set(r.trades);
    setPrefs((p) => { for (const c of t.youGet) p.unseen[c.num] = 1; });
    sfx.promote();
    toast(`Trade done with ${t.with}!${t.youGet.length ? ` ${t.youGet.length} ${t.youGet.length === 1 ? "card is" : "cards are"} in your binder.` : ""}${r.sets.length ? ` ${r.sets.join(", ")} set complete!` : ""}`, false, 3800);
  });
  const mine = useStore(inv);
  return (
    <article class="td-offer">
      <header>
        <button type="button" class="td-whob" onClick={() => openProfile(t.with)}><Avatar name={t.with} /></button>
        <p>{kind === "in" ? <><b>{t.with}</b> wants to trade</> : <>Waiting on <b>{t.with}</b></>}<small>{ago(t.createdAt)}</small></p>
      </header>
      <Row label="You give" cards={t.youGive} goods={{ packs: t.youGivePacks, boosted: t.youGiveBoosted, parts: t.youGiveParts }} specials={t.youGiveSpecials} whose="you" own={mine} recipient={t.with} recipientCards={recipientCards} />
      <Row label="You get" cards={t.youGet} goods={{ packs: t.youGetPacks, boosted: t.youGetBoosted, parts: t.youGetParts }} specials={t.youGetSpecials} whose={t.with} own={mine} recipient="you" recipientCards={mine} />
      {kind === "in" && <Fairness
        giveCards={t.youGive} giveGoods={{ packs: t.youGivePacks, boosted: t.youGiveBoosted, parts: t.youGiveParts }} giveSpecials={t.youGiveSpecials.length}
        getCards={t.youGet} getGoods={{ packs: t.youGetPacks, boosted: t.youGetBoosted, parts: t.youGetParts }} getSpecials={t.youGetSpecials.length}
      />}
      <div class={cx("s-row2", kind === "in" && "td-acts3")}>
        {kind === "in"
          ? <><button type="button" class="s-btn" disabled={busy} onClick={accept}>Accept</button><button type="button" class="s-btn ghost" disabled={busy} onClick={() => counterOffer(t)}>Counter</button><button type="button" class="s-btn ghost" disabled={busy} onClick={() => run(async () => trades.set(await api.declineTrade(t.id)))}>Decline</button></>
          : <button type="button" class="s-btn ghost" disabled={busy} onClick={() => run(async () => trades.set(await api.cancelTrade(t.id)))}>Cancel offer</button>}
      </div>
    </article>
  );
}

// ---------- history ----------

const STATUS: Record<string, [string, string]> = { accepted: ["Completed", "✓"], declined: ["Declined", "✕"], cancelled: ["Cancelled", "↺"], failed: ["Called off", "!"] };
const dayLabel = (ms: number) => {
  const d = new Date(ms), today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((+today - +new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 864e5);
  return diff === 0 ? "Today" : diff === 1 ? "Yesterday" : diff < 7 ? d.toLocaleDateString(undefined, { weekday: "long" }) : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
};

function History() {
  const tr = useStore(trades);
  const [f, setF] = useState("all");
  const all = tr.recent, done = all.filter((t) => t.status === "accepted");
  const sum = (k: "youGetPacks" | "youGivePacks" | "youGetParts" | "youGiveParts") => done.reduce((a, t) => a + (t[k] || 0), 0);
  const sign = (n: number) => (n > 0 ? `+${n}` : String(n));
  const counts: Record<string, number> = { all: all.length };
  for (const t of all) counts[t.status] = (counts[t.status] ?? 0) + 1;
  const shown = all.filter((t) => f === "all" || t.status === f);
  let last = "";
  return (
    <>
      <div class="hi-stats">
        <div><b>{done.length}</b><small>trades</small></div>
        <div><b>{done.reduce((a, t) => a + t.youGet.length, 0)}<em>/{done.reduce((a, t) => a + t.youGive.length, 0)}</em></b><small>cards in/out</small></div>
        <div><b>{sign(sum("youGetPacks") - sum("youGivePacks"))}</b><small>packs</small></div>
        <div><b>{sign(sum("youGetParts") - sum("youGiveParts"))}</b><small>parts</small></div>
      </div>
      <div class="s-chips">{["all", "accepted", "declined", "cancelled", "failed"].filter((k) => k === "all" || counts[k]).map((k) => (
        <button type="button" class={cx("s-chip", f === k && "on")} aria-pressed={f === k} onClick={() => setF(k)}>{k === "all" ? "All" : STATUS[k][0]} <em>{counts[k] ?? 0}</em></button>
      ))}</div>
      {!shown.length ? <div class="s-empty">No trades yet.</div> : (
        <div class="s-list">
          {shown.map((t) => {
            const when = t.decidedAt || t.createdAt, day = dayLabel(when), head = day !== last;
            last = day;
            const verb = t.status === "accepted" ? ["Got", "Gave"] : ["Would have got", "Would have given"];
            return (
              <>
                {head && <h3 class="hi-day">{day}</h3>}
                <article class={cx("hi-item", t.status)}>
                  <header>
                    <span class="hi-icon">{STATUS[t.status]?.[1] ?? "·"}</span>
                    <button type="button" class="td-whob" onClick={() => openProfile(t.with)}><Avatar name={t.with} /><b>{t.with}</b></button>
                    <span class={cx("hi-pill", t.status)}>{STATUS[t.status]?.[0] ?? t.status}</span>
                    <time>{new Date(when).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</time>
                  </header>
                  <Row label={verb[0]} cards={t.youGet} goods={{ packs: t.youGetPacks, boosted: t.youGetBoosted, parts: t.youGetParts }} specials={t.youGetSpecials} whose={t.with} />
                  <Row label={verb[1]} cards={t.youGive} goods={{ packs: t.youGivePacks, boosted: t.youGiveBoosted, parts: t.youGiveParts }} specials={t.youGiveSpecials} whose="you" />
                  {t.status === "failed" && <p class="s-dim">Someone no longer had something in it, so it was called off.</p>}
                </article>
              </>
            );
          })}
        </div>
      )}
    </>
  );
}
