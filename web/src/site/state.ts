// What the server says about this player (packs, timers, parts, collection, trades), kept in stores the screens read.
// Everything that matters comes from the server; this only keeps the latest answer and a few display preferences.
import { api, explain, type Collection, type State, type Trades } from "../api";
import { store } from "../lib/store";
import { PACK } from "./data";

export const st = store<State | null>(null);
/** Your cards: team number to serials (the first is the one you got first). */
export const inv = store<Record<number, number[]>>({});
export const sets = store<Set<string>>(new Set());
export const trades = store<Trades>({ incoming: [], outgoing: [], recent: [] });
/** Server clock minus this device's, so timers don't depend on the device clock. */
export let skew = 0;

// ---------- preferences kept on this device ----------

const PREFS = "frcpacks.prefs";
interface Prefs { muted: boolean; wheel2: boolean; unseen: Record<number, 1> }
function readPrefs(): Prefs {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS) || "{}");
    return { muted: p.muted === true, wheel2: p.wheel2 === true, unseen: p.unseen && typeof p.unseen === "object" && !Array.isArray(p.unseen) ? p.unseen : {} };
  } catch { return { muted: false, wheel2: false, unseen: {} }; }
}
export const prefs = store<Prefs>(readPrefs());
export function setPrefs(f: (p: Prefs) => void) {
  const n = structuredClone(prefs.get());
  f(n);
  prefs.set(n);
  try { localStorage.setItem(PREFS, JSON.stringify(n)); } catch { /* private mode */ }
}

// ---------- applying answers ----------

export function applyState(s: State) {
  skew = s.now - Date.now();
  st.set(s);
}

export function applyCollection(c: Collection) {
  const m: Record<number, number[]> = {};
  for (const x of c.cards) m[x.num] = x.serials;
  inv.set(m);
  sets.set(new Set(c.sets));
}

export const packOf = (s: State) => s.packs.find((p) => p.id === PACK) ?? { id: PACK, sealed: 0, boosted: 0, mythic: 0, opened: 0, pity: { m: 0, l: 0 } };

let syncing = false;
/** Asks the server for the latest (another tab or device may have changed things). */
export async function sync() {
  if (syncing) return;
  syncing = true;
  try {
    const [s, c, t] = await Promise.all([api.state(), api.collection(PACK), api.trades().catch(() => null)]);
    applyState(s);
    applyCollection(c);
    if (t) trades.set(t);
  } catch { /* keep what we have */ }
  syncing = false;
}

export async function loadTrades() {
  try { trades.set(await api.trades()); } catch { /* keep the old list */ }
}

// ---------- toast ----------

export const toastMsg = store<{ text: string; bad: boolean; n: number } | null>(null);
let toastTimer = 0, toastN = 0;
export function toast(text: string, bad = false, ms = 2800) {
  toastMsg.set({ text, bad, n: ++toastN });
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastMsg.set(null), ms);
}
export function fail(e: unknown) {
  const s = (e as { status?: number })?.status;
  toast(s === 0 ? "Can't reach the server." : s === 401 ? "You've been signed out. Reload to sign in." : explain(e), true, 3600);
}

// ---------- little helpers about your cards ----------

export const owns = (num: number) => (inv.get()[num]?.length ?? 0) > 0;
export const isFav = (num: number) => (st.get()?.favorites ?? []).includes(num);
export const wished = (num: number) => (st.get()?.wishlist ?? []).includes(num);
export const pinned = (num: number) => (st.get()?.showcase ?? []).includes(num);

/** Copies the server won't scrap yet: in the pack being revealed, or in an open trade offer. Keyed "team:serial". */
export function heldCopies(): Set<string> {
  const h = new Set<string>();
  st.get()?.pending?.cards.forEach((c) => h.add(`${c.num}:${c.serial}`));
  const t = trades.get();
  [...t.outgoing, ...t.incoming].forEach((x) => x.youGive.forEach((c) => h.add(`${c.num}:${c.serial}`)));
  return h;
}

export const ago = (t: number) => {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  return s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
};
