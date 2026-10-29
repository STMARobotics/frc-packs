// A pretend server for the opening preview (tools/open_preview.cjs): the real app runs unchanged, and every request it
// makes is answered here, in the page. Packs never run out, a few dozen teams of each rarity are in play (only their
// photos ship with the preview), and a bar on the Open tab picks the best card of the next pack.
import raw from "../../data/packs/cmp26.json";
import focus from "../../data/photos/focus.json";
import type { Card, Opening, Recipe, State, Tier } from "../src/api";

/** How many teams of each rarity are in play: the first ones with a photo, in the recipe's order. The build tool picks
    the same teams' photos. */
export const CAST: Record<Tier, number> = { common: 14, uncommon: 10, rare: 8, legendary: 6, mythic: 5 };
const recipe = structuredClone(raw) as unknown as Recipe;
const pool: Record<Tier, number[]> = { common: [], uncommon: [], rare: [], legendary: [], mythic: [] };
for (const t of recipe.teams) {
  if (t.photo && pool[t.tier].length < CAST[t.tier]) pool[t.tier].push(t.num);
  else t.photo = false;
}

type Best = "auto" | "rare" | "legendary" | "mythic";
const KEY = "preview.best";
let best: Best = "auto";
try { best = (localStorage.getItem(KEY) as Best) || "auto"; } catch { /* a fresh choice each visit */ }

const owned = new Map<number, number[]>();
let opened = 0, nextId = 1, held: { kind: string; cards: Card[] } | null = null, pending: Opening | null = null;
const pick = <T,>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];
const weighted = (w: [Tier, number][]): Tier => { let r = Math.random() * w.reduce((a, [, x]) => a + x, 0); for (const [t, x] of w) if ((r -= x) < 0) return t; return w[0][0]; };
const RANK: Tier[] = ["common", "uncommon", "rare", "legendary", "mythic"];

function deal(boosted: boolean, mythic: boolean): Card[] {
  const top: Tier = best === "auto" ? weighted([["rare", 70], ["legendary", 22], ["mythic", 8]]) : best;
  const tiers: Tier[] = mythic
    ? ["common", "uncommon", "mythic", "mythic", "mythic"]
    : [...Array.from({ length: 4 }, () => weighted(boosted ? [["common", 40], ["uncommon", 35], ["rare", 25]] : [["common", 70], ["uncommon", 22], ["rare", 8]])), top];
  tiers.sort((a, b) => RANK.indexOf(a) - RANK.indexOf(b));
  const used = new Set<number>();
  return tiers.map((tier) => {
    let num = pick(pool[tier]);
    for (let i = 0; i < 10 && used.has(num); i++) num = pick(pool[tier]);
    used.add(num);
    const copies = (owned.get(num)?.length ?? 0) + 1;
    return { num, tier, serial: 1 + Math.floor(Math.random() * (tier === "mythic" ? 12 : 60)), isNew: copies === 1, copy: copies, inGame: tier === "mythic" ? 2 + Math.floor(Math.random() * 6) : undefined };
  });
}

function state(): State {
  const now = Date.now();
  return {
    account: { username: "you", admin: false, firstName: "You", badge: null, renameAt: null, bio: null, avatar: null, banner: null },
    now, nextClaimAt: now + 3_600_000, claimMs: 7_200_000, claimPacks: 1, bank: 0, parts: 0, donateUrl: null, boostCost: 250,
    scrapParts: { common: 5, uncommon: 12, rare: 40, legendary: 150, mythic: 600 }, demo: false, devTools: false,
    packs: [{ id: recipe.id, sealed: 99, boosted: 9, mythic: 3, opened, pity: { m: 0, l: 0 } }],
    pending, missions: [], streak: { days: 3, today: true, alive: true, every: 7 } as State["streak"],
    level: { teams: owned.size, level: 0, claimed: 0, per: 25, reward: 100 }, wishlist: [], showcase: [], favorites: [], notice: null, tiers: {},
  };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function answer(method: string, path: string, body: Record<string, unknown>): Response {
  if (path.startsWith("/packs/")) return json(recipe);
  if (path === "/photos/focus.json") return json(Object.fromEntries(Object.entries(focus).filter(([n]) => Object.values(pool).some((p) => p.includes(+n)))));
  if (path === "/notice.json") return json(null, 404);
  if (path === "/api/session" || path === "/api/state") return json(state());
  if (path.startsWith("/api/collection/")) return json({ pack: recipe.id, cards: [...owned].map(([num, serials]) => ({ num, serials })), sets: [] });
  if (path === "/api/trades") return json({ incoming: [], outgoing: [], recent: [] });
  if (path === "/api/specials" || path === "/api/feedback/mine") return json([]);
  if (path.startsWith("/api/social/")) return json({ players: [], feed: [] });
  if (path === "/api/hand") {
    const kind = `${!!body.boosted}${!!body.mythic}`;
    if (!held || held.kind !== kind) held = { kind, cards: deal(!!body.boosted, !!body.mythic) };
    return json({ best: held.cards[4].tier, boosted: !!body.boosted });
  }
  if (path === "/api/open") {
    const kind = `${!!body.boosted}${!!body.mythic}`;
    const cards = held?.kind === kind ? held.cards : deal(!!body.boosted, !!body.mythic);
    held = null;
    for (const c of cards) owned.set(c.num, [...(owned.get(c.num) ?? []), c.serial]);
    opened++;
    pending = { id: nextId++, pack: recipe.id, revealed: 0, cards, sets: [] };
    return json({ opening: pending, state: state(), streakReward: false });
  }
  const prog = /^\/api\/openings\/(\d+)\/progress$/.exec(path);
  if (prog) {
    if (pending && pending.id === +prog[1]) { pending.revealed = +(body.revealed ?? 0); if (pending.revealed >= 5) pending = null; }
    return new Response(null, { status: 204 });
  }
  return method === "POST" ? new Response(null, { status: 204 }) : json({ error: "not_in_preview" }, 404);
}

const real = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
  const path = url.pathname.replace(/^.*?(?=\/(api\/|packs\/|photos\/focus\.json|notice\.json))/, "");
  if (!/^\/(api\/|packs\/|photos\/focus\.json|notice\.json)/.test(path)) return real(input, init);
  let body: Record<string, unknown> = {};
  try { body = init?.body ? JSON.parse(String(init.body)) : {}; } catch { /* no body */ }
  await new Promise((r) => setTimeout(r, path === "/api/open" ? 220 : 60)); // a little like a real server
  return answer(init?.method ?? "GET", path, body);
};

// The bar on the Open tab: which best card the next pack has.
function bar() {
  const el = document.createElement("div");
  el.className = "pv-bar";
  el.innerHTML = `<span>Preview · next pack's best card</span><div role="group" aria-label="Next pack's best card"></div>`;
  const group = el.querySelector("div")!;
  const opts: [Best, string][] = [["auto", "Random"], ["rare", "Rare"], ["legendary", "Legendary"], ["mythic", "Mythic"]];
  for (const [v, label] of opts) {
    const b = document.createElement("button");
    b.type = "button"; b.id = `pv-${v}`; b.textContent = label;
    b.setAttribute("aria-pressed", String(v === best));
    b.onclick = () => {
      best = v; held = null;
      try { localStorage.setItem(KEY, v); } catch { /* fine */ }
      for (const x of group.children) x.setAttribute("aria-pressed", String(x === b));
    };
    group.appendChild(b);
  }
  // Under the packs on the Open tab, whenever the tab is drawn.
  const sync = () => { const home = document.querySelector(".op-home"); if (home && el.parentElement !== home) home.appendChild(el); };
  new MutationObserver(sync).observe(document.body, { childList: true, subtree: true });
  addEventListener("hashchange", sync);
  sync();
}
if (document.readyState === "loading") addEventListener("DOMContentLoaded", bar); else bar();
