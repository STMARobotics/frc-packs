// A card up close. The same view wherever it's opened from (binder, profile, trade, pack): the card (hold it to turn
// it), its badges, keep / pin / wishlist, scrapping extras, the main action, and the team's facts behind Details.
import { useState } from "preact/hooks";
import { api } from "../../api";
import { useStore } from "../../lib/store";
import { BY_NUM, PACK, RECIPE, RP_NAMES, TIERS } from "../data";
import { fail, heldCopies, inv, st, toast } from "../state";
import { back, closeAll, cx, push, TiltCard } from "../ui";
import { sfx } from "../sfx";
import { scrapped } from "./workshop";
import { offerFromBinder } from "./trade";

export interface CardOpts {
  /** A copy's serial, when it's someone's particular copy (not yours). */
  serial?: number;
  /** Whose card it is, shown under the facts. */
  from?: string;
  /** The main button. */
  action?: { label: string; run: () => void };
}

export function openCard(num: number, _nav?: number[], o: CardOpts = {}) {
  push(() => <CardView num={num} o={o} />, "card");
}

/** Serials worth bragging about: No. 1, the first ten, and a serial that matches the team number. */
function badges(num: number, serials: number[]) {
  const b: [string, string][] = [];
  if (serials.includes(1)) b.push(["g", "First print"]);
  else if (serials.some((x) => x > 0 && x <= 10)) b.push(["g", "Low serial"]);
  if (serials.includes(num)) b.push(["t", "Team match"]);
  if (serials.length > 1) b.push(["p", `${serials.length} copies`]);
  return b;
}

function CardView({ num, o }: { num: number; o: CardOpts }) {
  const t = BY_NUM.get(num)!;
  const s = useStore(st)!;
  const mine = useStore(inv)[num] ?? [];
  const [facts, setFacts] = useState(false);
  const [busy, setBusy] = useState("");
  const [armed, setArmed] = useState(0);
  const owned = mine.length > 0;
  const serial = o.serial ?? (o.from ? undefined : mine[0]);
  const fav = (s.favorites ?? []).includes(num), wish = (s.wishlist ?? []).includes(num), pin = (s.showcase ?? []).includes(num);
  const names = RP_NAMES[RECIPE.season] ?? ["RP1", "RP2", "RP3"];

  const toggle = async (what: "fav" | "wish" | "pin") => {
    setBusy(what);
    try {
      if (what === "fav") { const l = await api.setFavorite(PACK, num, !fav); st.set({ ...st.get()!, favorites: l }); toast(!fav ? "Kept. It will never be scrapped." : "No longer kept.", false, 1800); }
      if (what === "wish") { const l = await api.setWish(PACK, num, !wish); st.set({ ...st.get()!, wishlist: l }); }
      if (what === "pin") {
        const list = (s.showcase ?? []).filter((n) => n !== num);
        if (!pin) { if (list.length >= 3) { setBusy(""); return toast("Your profile shows 3 cards. Unpin one first.", true); } list.push(num); }
        const l = await api.setShowcase(PACK, list);
        st.set({ ...st.get()!, showcase: l });
      }
      sfx.tick();
    } catch (e) { fail(e); }
    setBusy("");
  };

  // Scrapping from here: the first copy (the one you got first) is always kept, and so is a card you keep.
  const held = heldCopies();
  const free = mine.filter((x) => !held.has(`${num}:${x}`)).length;
  const canScrap = owned && !o.from && t.tier !== "mythic" && !fav;
  const each = s.scrapParts[t.tier] ?? 0, extras = free - 1;
  const scrap = async (count: number) => {
    if (armed !== count) { setArmed(count); setTimeout(() => setArmed(0), 3500); return; } // a second tap confirms
    setBusy("scrap");
    try { scrapped(await api.scrap(PACK, num, count)); } catch (e) { fail(e); }
    setArmed(0); setBusy("");
  };

  const b = owned && !o.from ? badges(num, mine) : serial ? badges(num, [serial]) : [];
  return (
    <div class={cx("s-cardview", facts && "facts")}>
      <div class="cw-top">
        {owned
          ? <>
              <button type="button" class={cx("s-icon", pin && "on")} disabled={busy === "pin"} onClick={() => toggle("pin")} aria-pressed={pin} aria-label="Pin to profile">{pin ? "★" : "☆"}</button>
              <button type="button" class={cx("s-icon", fav && "on")} disabled={busy === "fav"} onClick={() => toggle("fav")} aria-pressed={fav} aria-label="Keep">{fav ? "♥" : "♡"}</button>
            </>
          : <button type="button" class={cx("s-icon wide", wish && "on")} disabled={busy === "wish"} onClick={() => toggle("wish")} aria-pressed={wish}>{wish ? "♥ Wishlist" : "♡ Wishlist"}</button>}
        <span class="cw-gap" />
        <button type="button" class="s-icon" onClick={back} aria-label="Close">×</button>
      </div>
      <div class="cw-stage">
        {facts ? (
          <dl class="cw-facts">
            <dt>Team</dt><dd>{num} · {t.name}</dd>
            <dt>Rarity</dt><dd style={{ color: TIERS[t.tier].color }}>{TIERS[t.tier].label}</dd>
            <dt>Division</dt><dd>{t.div}</dd>
            {t.loc && <><dt>From</dt><dd>{t.loc}</dd></>}
            <dt>EPA</dt><dd>{t.epa == null ? "–" : Math.round(t.epa)} · #{t.rank} at Champs</dd>
            <dt>Record</dt><dd>{t.wl}</dd>
            {owned && !o.from && <><dt>Serials</dt><dd>{mine.map((x) => `No. ${x}`).join(" · ")}</dd></>}
            {o.serial && <><dt>Serial</dt><dd>No. {o.serial}</dd></>}
            <dt>Battler</dt><dd>{t.bt ? `AUTO ${t.bt.auto} · TELE ${t.bt.tele} · END ${t.bt.end}` : "Stats coming soon"}</dd>
            <dt>RP slots</dt><dd>{names.map((n, i) => `RP${i + 1} ${n}`).join(" · ")}</dd>
          </dl>
        ) : <TiltCard num={num} serial={serial} w="min(310px, 80vw, calc((100svh - 250px) / 1.4))" />}
      </div>
      {b.length > 0 && !facts && <div class="cw-badges">{b.map(([k, l]) => <span class={`s-bdg ${k}`}>{l}</span>)}</div>}
      <p class="cw-note">{o.from ? `${o.from} ` : ""}{owned ? `You own ${mine.length === 1 ? "1 copy" : `${mine.length} copies`}.` : "You don't have this one yet."}</p>
      <div class="cw-bottom">
        <div class="s-row2">
          {o.action ? <button type="button" class="s-btn" onClick={() => closeAll(o.action!.run)}>{o.action.label}</button>
            : owned && !o.from ? <button type="button" class="s-btn" onClick={() => closeAll(() => offerFromBinder(num))}>Offer in a trade</button> : null}
          <button type="button" class="s-btn ghost" onClick={() => setFacts(!facts)}>{facts ? "Card" : "Details"}</button>
        </div>
        {canScrap && extras > 0 && (
          <div class="s-row2">
            <button type="button" class={cx("s-chipbtn", armed === 1 && "warn")} disabled={busy === "scrap"} onClick={() => scrap(1)}>{armed === 1 ? "Tap again" : `Scrap 1 · +${each}`}</button>
            {extras > 1 && <button type="button" class={cx("s-chipbtn", armed === extras && "warn")} disabled={busy === "scrap"} onClick={() => scrap(extras)}>{armed === extras ? "Tap again" : `Scrap all ${extras} · +${each * extras}`}</button>}
          </div>
        )}
        {owned && !o.from && mine.length > 1 && free < 2 && t.tier !== "mythic" && <small class="s-dim">Your extra copies are in a pack you're opening or a trade offer.</small>}
      </div>
    </div>
  );
}

