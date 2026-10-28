// The workshop: scrap extra copies for parts (your first copy of every team, and anything you keep, is never scrapped),
// and spend parts on boosted packs.
import { useState } from "preact/hooks";
import { api, type Tier, type Scrapped } from "../../api";
import { useStore } from "../../lib/store";
import { BY_NUM, ORDER, PACK, TIERS } from "../data";
import { applyCollection, applyState, fail, heldCopies, inv, prefs, setPrefs, st, toast, trades } from "../state";
import { cx } from "../ui";
import { sfx } from "../sfx";

const MYTHIC_COST = 10000;
const SCRAPPABLE: Tier[] = ["common", "uncommon", "rare", "legendary"]; // Mythic copies are never scrapped

function readPick(): Record<Tier, boolean> {
  const p: Record<Tier, boolean> = { common: true, uncommon: true, rare: true, legendary: false, mythic: false };
  try { const s = JSON.parse(localStorage.getItem("frcpacks.scrap") || "null"); if (s) for (const t of SCRAPPABLE) if (typeof s[t] === "boolean") p[t] = s[t]; } catch { /* default */ }
  return p;
}

/** After a scrap: the new state and collection, and copies that are gone are no longer marked new. */
export function scrapped(r: Scrapped) {
  applyState(r.state);
  applyCollection(r.collection);
  setPrefs((p) => { for (const k of Object.keys(p.unseen)) if (!r.collection.cards.some((c) => c.num === +k)) delete p.unseen[+k]; });
  sfx.whoosh();
  if (r.scrapped) toast(`Scrapped ${r.scrapped} ${r.scrapped === 1 ? "copy" : "copies"} · +${r.gained} parts${r.held ? ` · ${r.held} held back` : ""}`);
}

export function Workshop() {
  const s = useStore(st)!;
  const cards = useStore(inv);
  useStore(trades);
  useStore(prefs);
  const [pick, setPick] = useState(readPick);
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState("");

  // Extra copies by tier that scrapping takes now, counted the way the server does: of the copies not held back, all
  // but one. `held` are extras that have to wait (in the pack being revealed, or in a trade offer).
  const held = heldCopies(), fav = new Set(s.favorites ?? []);
  const ex: Record<string, number> = { held: 0 };
  for (const t of ORDER) ex[t] = 0;
  for (const [k, serials] of Object.entries(cards)) {
    const t = BY_NUM.get(+k);
    if (!t || serials.length < 2 || fav.has(+k)) continue;
    const free = serials.filter((x) => !held.has(`${k}:${x}`)).length, now = Math.max(0, free - 1);
    ex[t.tier] += now;
    if (pick[t.tier]) ex.held += serials.length - 1 - now;
  }
  const tiers = SCRAPPABLE.filter((t) => pick[t]);
  const n = tiers.reduce((a, t) => a + ex[t], 0);
  const gain = tiers.reduce((a, t) => a + ex[t] * (s.scrapParts[t] ?? 0), 0);
  const skipped = SCRAPPABLE.filter((t) => !pick[t] && ex[t]);
  const cost = s.boostCost;

  const toggle = (t: Tier) => {
    const p = { ...pick, [t]: !pick[t] };
    setPick(p); setArmed(false);
    try { localStorage.setItem("frcpacks.scrap", JSON.stringify(p)); } catch { /* private mode */ }
  };
  const scrap = async () => {
    if (!armed) { setArmed(true); setTimeout(() => setArmed(false), 3500); return; }
    setArmed(false); setBusy("scrap");
    try { scrapped(await api.scrapExtras(PACK, tiers)); } catch (e) { fail(e); }
    setBusy("");
  };
  const craft = async (mythic: boolean) => {
    setBusy(mythic ? "mythic" : "craft");
    try {
      applyState(await (mythic ? api.craftMythic() : api.craft()));
      sfx.promote();
      toast(mythic ? "Mythic pack crafted. It's in its own stack on the Open tab." : "Boosted pack crafted. It's in its own gold stack on the Open tab.");
    } catch (e) { fail(e); }
    setBusy("");
  };

  return (
    <div class="s-workshop">
      <section class="s-panel">
        <div class="s-parts"><span>Parts</span><b>{s.parts.toLocaleString()}</b></div>
        <div class="s-bar gold"><i style={{ transform: `scaleX(${Math.min(1, s.parts / cost)})` }} /></div>
        <small class="s-dim">{s.parts >= cost ? `${Math.floor(s.parts / cost)} boosted pack${s.parts >= cost * 2 ? "s" : ""} ready` : `${cost - s.parts} more for a boosted pack`}</small>
        <button type="button" class="s-btn wide" disabled={s.parts < cost || !!busy} onClick={() => craft(false)}>Craft boosted pack · {cost}</button>
        {s.parts >= MYTHIC_COST && <button type="button" class="s-btn ghost wide" disabled={!!busy} onClick={() => craft(true)}>Mythic pack · {MYTHIC_COST.toLocaleString()} (3 Mythics)</button>}
        <small class="s-dim">Boosted packs have better odds: Legendary or better in about half, Mythic 4× as likely.</small>
      </section>
      <section class="s-panel">
        <h2 class="s-h2">Scrap extra copies</h2>
        <div class="s-chips">
          {SCRAPPABLE.map((t) => (
            <button type="button" class={cx("s-chip", pick[t] && "on")} aria-pressed={pick[t]} style={{ "--tc": TIERS[t].color }} onClick={() => toggle(t)} title={`+${s.scrapParts[t] ?? 0} parts each`}>
              <b>{TIERS[t].label}</b> <em>{ex[t]}</em>
            </button>
          ))}
        </div>
        <button type="button" class={cx("s-btn wide", armed && "warn")} disabled={!n || !!busy} onClick={scrap}>
          {!n ? "No extras to scrap" : armed ? `Tap again to scrap ${n}` : `Scrap ${n} extra${n === 1 ? "" : "s"} · +${gain} parts`}
        </button>
        {ex.held > 0 && <small class="s-dim">{ex.held} {ex.held === 1 ? "extra waits" : "extras wait"} for the pack you're opening or a trade offer.</small>}
        {skipped.length > 0 && <small class="s-dim">{skipped.reduce((a, t) => a + ex[t], 0)} more in {skipped.map((t) => TIERS[t].label).join(" and ")}. Tap to include.</small>}
        <small class="s-dim">Your first copy of every team, and cards you keep, are never scrapped.</small>
      </section>
    </div>
  );
}
