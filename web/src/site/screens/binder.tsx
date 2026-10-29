// The binder: every team you own (or, with Missing on, every team in the pack), filtered by rarity or division set,
// searchable; and the workshop, where extra copies become parts and parts become boosted packs.
import { useEffect, useMemo, useState } from "preact/hooks";
import { api } from "../../api";
import { useStore } from "../../lib/store";
import { byRarity, DIV_TEAMS, DIVS, ORDER, POOL, RECIPE, TEAMS, TIERS, type T } from "../data";
import { applyState, fail, inv, prefs, setPrefs, sets, specials, st, toast } from "../state";
import { Card, cx, Ghost, Tabs } from "../ui";
import { openCard } from "./cardview";
import { Workshop } from "./workshop";
import { SpecialRow } from "./special";

const PAGE = 48;
// Kept between visits to the tab.
let filter = "all", query = "", missing = false, page: "cards" | "workshop" = "cards";

export function Binder({ active }: { active: boolean }) {
  const cards = useStore(inv);
  const s = useStore(st)!;
  const done = useStore(sets);
  const p = useStore(prefs);
  const mine = useStore(specials);
  const [f, setF] = useState(filter);
  const [q, setQ] = useState(query);
  const [miss, setMiss] = useState(missing);
  const [pg, setPg] = useState(page);
  const [shown, setShown] = useState(PAGE);
  filter = f; query = q; missing = miss; page = pg;

  // New marks last one visit: leaving the binder clears them.
  useEffect(() => { if (!active && Object.keys(prefs.get().unseen).length) setPrefs((x) => { x.unseen = {}; }); }, [active]);

  const owned = useMemo(() => TEAMS.filter((t) => cards[t.num]?.length).sort(byRarity), [cards]);
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const t of ORDER) c[t] = 0;
    for (const t of owned) c[t.tier]++;
    return c;
  }, [owned]);

  const needle = q.trim().toLowerCase();
  const isDiv = f.startsWith("div:");
  const inFilter = (t: T) => f === "all" || (isDiv ? t.div === f.slice(4) : t.tier === f);
  const matches = (t: T) => String(t.num).startsWith(needle) || t.name.toLowerCase().includes(needle) || (t.loc || "").toLowerCase().includes(needle);
  const list = needle
    ? TEAMS.filter((t) => inFilter(t) && matches(t)).sort((a, b) => (cards[b.num]?.length ? 1 : 0) - (cards[a.num]?.length ? 1 : 0) || byRarity(a, b)) // yours first
    : miss ? TEAMS.filter(inFilter).sort(byRarity) : owned.filter(inFilter);
  useEffect(() => setShown(PAGE), [f, q, miss]);

  const level = s.level;
  const waiting = level ? level.level - level.claimed : 0;
  const [claiming, setClaiming] = useState(false);
  const claimLevel = async () => {
    setClaiming(true);
    try { applyState(await api.claimLevel()); toast("Parts collected."); } catch (e) { fail(e); }
    setClaiming(false);
  };

  return (
    <div class="s-screen s-binder">
      <section class="s-prog">
        <div class="s-prog-h"><b>{RECIPE.name}</b><span>{owned.length} of {TEAMS.length}</span></div>
        <div class="s-bar"><i style={{ transform: `scaleX(${owned.length / TEAMS.length})` }} /></div>
        {level && (
          <div class="s-level">
            <span>Level <b>{level.level}</b></span>
            {waiting > 0
              ? <button type="button" class="s-btn small" disabled={claiming} onClick={claimLevel}>Collect +{waiting * level.reward} parts</button>
              : <small class="s-dim">{(level.level + 1) * level.per - level.teams} teams to level {level.level + 1}</small>}
          </div>
        )}
      </section>
      <Tabs value={pg} onChange={setPg} options={[["cards", "Cards"], ["workshop", "Workshop"]]} />
      {pg === "workshop" ? <Workshop /> : (
        <>
          <SpecialRow list={mine} />
          <input class="s-input" type="search" placeholder="Search number, name or place" value={q} onInput={(e) => setQ(e.currentTarget.value)} aria-label="Search the binder" />
          <div class="s-filters">
            <select class="s-select" value={isDiv ? "all" : f} onChange={(e) => setF(e.currentTarget.value)} aria-label="Rarity">
              <option value="all">All rarities</option>
              {ORDER.map((t) => <option value={t}>{TIERS[t].label} {counts[t]}/{POOL[t].length}</option>)}
            </select>
            <select class="s-select" value={isDiv ? f : "all"} onChange={(e) => setF(e.currentTarget.value)} aria-label="Set">
              <option value="all">All sets</option>
              {DIVS.map((d) => { const have = DIV_TEAMS.get(d)!.filter((t) => cards[t.num]?.length).length; return <option value={`div:${d}`}>{d} {have}/{DIV_TEAMS.get(d)!.length}{done.has(d) ? " ✓" : ""}</option>; })}
            </select>
            <button type="button" class={cx("s-chip", miss && "on")} aria-pressed={miss} onClick={() => setMiss(!miss)}>Missing</button>
          </div>
          {!list.length ? (
            <div class="s-empty">{needle ? "No team matches." : owned.length ? "None of these yet." : "Your binder is empty. Open a pack and every robot you pull lands here."}</div>
          ) : (
            <div class="s-grid">
              {list.slice(0, shown).map((t) => {
                const serials = cards[t.num];
                const nav = list.slice(0, shown).map((x) => x.num);
                return serials?.length ? (
                  <button key={t.num} type="button" class="s-cell" onClick={() => openCard(t.num, nav)} aria-label={`${t.name}, team ${t.num}, ${TIERS[t.tier].label}`}>
                    <Card num={t.num} serial={serials[0]} w="var(--gw)">
                      {serials.length > 1 && <span class="s-count">×{serials.length}</span>}
                      {p.unseen[t.num] && <span class="s-new">NEW</span>}
                      {(s.favorites ?? []).includes(t.num) && <span class="s-fav" aria-label="Kept">♥</span>}
                    </Card>
                  </button>
                ) : (
                  <button key={t.num} type="button" class="s-cell" onClick={() => openCard(t.num, nav)} aria-label={`${t.name}, team ${t.num}, not owned yet`}>
                    <Ghost num={t.num} w="var(--gw)">{(s.wishlist ?? []).includes(t.num) && <span class="s-wish">♥</span>}</Ghost>
                  </button>
                );
              })}
            </div>
          )}
          {list.length > shown && <button type="button" class="s-btn ghost wide" onClick={() => setShown(shown + PAGE)}>Show more</button>}
        </>
      )}
    </div>
  );
}

