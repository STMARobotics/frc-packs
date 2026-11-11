// The Shop tab (0.14): Standard and Boosted packs for parts, and four slots that change every 4 hours: two cards,
// one Rare or better (once in a long while a Mythic), and a division pack. One slot can be frozen to keep it until
// you've saved up. Each player's stock is their own; the server works it out and checks every buy.
import { useEffect, useState } from "preact/hooks";
import { api, type Shop, type ShopItem } from "../../api";
import { store, useStore } from "../../lib/store";
import { BY_NUM, PACK, TIERS } from "../data";
import { applyCollection, applyState, fail, inv, st, toast } from "../state";
import { Card, cx, Spinner } from "../ui";
import { sfx } from "../sfx";
import { openCard } from "./cardview";
import { openDivision, PackArt } from "./open";
import { useNow } from "./status";

/** The shop as last loaded (the Packs tab uses its pack prices too). */
export const shopData = store<Shop | null>(null);

export async function loadShop() {
  try { shopData.set(await api.shop()); } catch { /* the tab shows a retry */ }
}

/** The refresh countdown, as HH:MM:SS. */
const clock = (ms: number) => {
  const t = Math.max(0, Math.ceil(ms / 1000));
  return [Math.floor(t / 3600), Math.floor((t % 3600) / 60), t % 60].map((n) => String(n).padStart(2, "0")).join(":");
};

/** A division's logo: the official one if it's been added (data/photos/divisions/<name>.png), else an emblem drawn
    here, in the division's own colour. */
const DIV_COLOR: Record<string, string> = {
  Archimedes: "#ff8a3d", Curie: "#3cffdc", Daly: "#ffd34a", Galileo: "#5b8cff",
  Hopper: "#ff5fa2", Johnson: "#7fe07a", Milstein: "#c07bff", Newton: "#ff5b5b",
};
export function DivisionLogo({ name }: { name: string }) {
  const [img, setImg] = useState(true);
  const c = DIV_COLOR[name] ?? "#8fe9ff";
  return (
    <span class="dv-logo" style={{ "--dc": c }} aria-label={`${name} division`}>
      {img ? <img src={`/photos/divisions/${name}.png`} alt="" onError={() => setImg(false)} /> : (
        <svg viewBox="0 0 64 64" aria-hidden="true">
          <path d="M32 3 L58 15 V34 C58 49 46 57 32 61 C18 57 6 49 6 34 V15 Z" fill="rgba(8,12,24,.85)" stroke="var(--dc)" stroke-width="3.5" />
          <path d="M32 11 L50 19 V33 C50 44 42 50 32 53 C22 50 14 44 14 33 V19 Z" fill="var(--dc)" opacity=".18" />
          <text x="32" y="42" text-anchor="middle" font-size="26" font-weight="700" fill="var(--dc)" font-family="var(--display)">{name[0]}</text>
        </svg>
      )}
    </span>
  );
}

const left = (ms: number) => {
  const m = Math.max(0, Math.ceil(ms / 60000)), h = Math.floor(m / 60);
  return h ? `${h}h ${m % 60}m` : `${m}m`;
};

/** A second tap confirms (parts are spent and can't be undone). Returns [armed key, arm-or-run]. */
function useConfirm(): [string, (key: string, run: () => void) => void] {
  const [armed, setArmed] = useState("");
  const go = (key: string, run: () => void) => {
    if (armed !== key) { setArmed(key); setTimeout(() => setArmed((a) => (a === key ? "" : a)), 3500); return; }
    setArmed("");
    run();
  };
  return [armed, go];
}

/** Buys a Standard or Boosted pack for parts: here, and next to Open on the Packs tab. */
export function BuyPack({ kind, cls, short }: { kind: "std" | "boosted"; cls?: string; short?: boolean }) {
  const s = useStore(st)!;
  const sh = useStore(shopData);
  const [armed, confirm] = useConfirm();
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (!shopData.get()) loadShop(); }, []);
  const price = kind === "boosted" ? s.boostCost : sh?.stdPrice;
  if (price == null || (kind === "std" && sh && !sh.on)) return null;
  const buy = () => confirm(kind, async () => {
    setBusy(true);
    try {
      applyState(await api.shopPack(kind));
      sfx.promote();
      loadShop();
    } catch (e) { fail(e); }
    setBusy(false);
  });
  return (
    <button type="button" class={cx("s-btn ghost", armed === kind && "warn", cls)} disabled={busy || s.parts < price} onClick={buy}
      title={s.parts < price ? `${price - s.parts} more parts` : undefined}>
      {armed === kind ? (short ? "Tap again" : `Tap again · ${price}`) : short ? <>⚙ {price.toLocaleString()}</> : <>⚙ Buy · {price.toLocaleString()}</>}
    </button>
  );
}

export function ShopTab({ active }: { active: boolean }) {
  const s = useStore(st)!;
  const sh = useStore(shopData);
  const cards = useStore(inv);
  const now = useNow();
  const [armed, confirm] = useConfirm();
  const [busy, setBusy] = useState("");
  useEffect(() => { if (active) loadShop(); }, [active]);
  // New stock on the hour mark: load it.
  useEffect(() => { if (active && sh && now >= sh.endsAt) loadShop(); }, [active, sh?.endsAt, now >= (sh?.endsAt ?? Infinity)]);
  if (!sh) return <div class="s-center small"><Spinner /></div>;
  if (!sh.on) return <div class="s-screen"><div class="s-empty">The shop is closed right now. Check back soon.</div></div>;

  const buy = (it: ShopItem) => confirm(it.slot, async () => {
    setBusy(it.slot);
    try {
      const r = await api.shopBuy(it);
      applyState(r.state);
      shopData.set(r.shop);
      if (r.card) {
        applyCollection(await api.collection(PACK));
        sfx.promote();
        if (r.sets.length) toast(`${r.sets.join(" and ")} set done · +1 pack`);
        openCard(r.card.num, undefined, { serial: r.card.serial, from: "Bought in the shop." });
      } else if (r.division) {
        openDivision(r.division);
      }
    } catch (e) {
      fail(e);
      if ((e as { code?: string }).code === "shop_changed" || (e as { code?: string }).code === "price_changed") loadShop();
    }
    setBusy("");
  });
  const freeze = async (it: ShopItem) => {
    setBusy(`f-${it.slot}`);
    try {
      shopData.set(await api.shopFreeze(it.frozen ? null : it.slot, sh.window));
      sfx.tick();
    } catch (e) { fail(e); loadShop(); }
    setBusy("");
  };

  // Six slots, three to a row: the three cards, then the Standard, Boosted and division packs.
  const slot = (it: ShopItem) => {
    const t = it.num != null ? BY_NUM.get(it.num) : undefined;
    const have = it.num != null ? cards[it.num]?.length ?? 0 : 0;
    const wish = it.num != null && (s.wishlist ?? []).includes(it.num);
    const short = it.price - s.parts;
    return (
      <article class={cx("sh-item", it.sold && "sold", it.frozen && "frozen", it.tier && `t-${it.tier}`)} key={it.slot}>
        <div class="sh-what">
          {it.kind === "card" && t ? (
            <button type="button" class="sh-card" onClick={() => openCard(it.num!, undefined, { from: "In your shop." })} aria-label={`See ${t.name}`}>
              <Card num={it.num!} w="100cqw" />
            </button>
          ) : <div class="sh-pack"><PackArt k="std" label={it.division} />{it.division && <DivisionLogo name={it.division} />}</div>}
          {wish && <span class="sh-wish" title="On your wishlist">♥</span>}
          {it.frozen && <span class="sh-ice" aria-hidden="true" />}
        </div>
        <div class="sh-info">
          <small style={it.tier ? { color: TIERS[it.tier].color } : undefined}>{it.tier ? TIERS[it.tier].label : "Division"}{it.kind === "card" ? (have ? ` · ×${have}` : " · New") : ""}</small>
          <button type="button" class={cx("sh-freeze", it.frozen && "on")} disabled={it.sold || busy === `f-${it.slot}`} aria-pressed={it.frozen}
            aria-label={it.frozen ? "Unfreeze" : "Freeze"} title={it.frozen ? "Frozen: it stays when the shop changes. Tap to unfreeze." : "Freeze: keep it when the shop changes"} onClick={() => freeze(it)}>❄</button>
        </div>
        <button type="button" class={cx("s-btn small wide", armed === it.slot && "warn")} disabled={it.sold || short > 0 || busy === it.slot} onClick={() => buy(it)}
          title={short > 0 ? `${short.toLocaleString()} more parts` : undefined}>
          {it.sold ? "Bought" : armed === it.slot ? "Tap again" : `⚙ ${it.price.toLocaleString()}`}
        </button>
      </article>
    );
  };
  const packSlot = (k: "std" | "boosted") => (
    <article class="sh-item" key={k}>
      <div class="sh-what"><div class="sh-pack"><PackArt k={k === "boosted" ? "gold" : "std"} /></div></div>
      <div class="sh-info"><small>{k === "boosted" ? "Boosted" : "Standard"}</small></div>
      <BuyPack kind={k} cls="small wide" short />
    </article>
  );
  const items = (slots: string[]) => sh.items.filter((i) => slots.includes(i.slot));

  return (
    <div class="s-screen sh-shop">
      <header class="sh-head"><h1>Shop</h1></header>
      {/* The refresh, front and centre: when the cards and the division pack change. */}
      <div class="sh-refresh" role="timer" aria-label={`New stock in ${left(sh.endsAt - now)}`}
        style={{ "--left": Math.max(0, Math.min(1, (sh.endsAt - now) / (4 * 3600_000))).toFixed(4) }}>
        <small>Refreshes in</small>
        <b>{clock(sh.endsAt - now)}</b>
      </div>
      <div class="sh-grid">
        {items(["c1", "c2", "c3"]).map(slot)}
        {packSlot("std")}
        {packSlot("boosted")}
        {items(["div"]).map(slot)}
      </div>
    </div>
  );
}
