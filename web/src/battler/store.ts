// App state the screens share: the card catalog, the player's home data, the open sheet and the toast. A store is a value
// plus listeners; `useStore` re-renders a component when it changes. Screens keep everything else in their own state.
import type { ComponentChildren } from "preact";
import { call } from "./api";
import type { Catalog, Home, Robot, Support } from "./types";
import { store } from "../lib/store";

export { store, useStore, type Store } from "../lib/store";

export let CAT: Catalog;
export const ROBOT = new Map<number, Robot>();
export const SUPPORT = new Map<string, Support>();
export const home = store<Home | null>(null);

export async function loadCatalog() {
  CAT = await call<Catalog>("GET", "/api/battler/catalog");
  CAT.robots.forEach((r) => ROBOT.set(r.team, r));
  CAT.support.forEach((c) => SUPPORT.set(c.id, c));
}

/** Fetches the player's home data (decks, Elo, the game they're in). Screens show what they have and refresh behind it. */
export async function loadHome() {
  const h = await call<Home>("GET", "/api/battler/home");
  home.set(h);
  return h;
}

// ---------- toast ----------

export const toastMsg = store<{ text: string; bad: boolean; n: number } | null>(null);
let toastTimer = 0, toastN = 0;
export function toast(text: string, bad = false) {
  toastMsg.set({ text, bad, n: ++toastN });
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastMsg.set(null), 2600);
}
export const hideToast = () => { clearTimeout(toastTimer); toastMsg.set(null); };

// ---------- sheet (bottom drawer) ----------

/** The open sheet: a render function, so what's inside is a live component that updates with the screen behind it. */
export const sheet = store<{ render: () => ComponentChildren; key: number; wide?: boolean } | null>(null);
let sheetN = 0;
export const openSheet = (render: () => ComponentChildren, wide = false) => sheet.set({ render, key: ++sheetN, wide });
export const closeSheet = () => sheet.set(null);

// ---------- preferences kept on this device ----------

export function pref(key: string): boolean { try { return localStorage.getItem(key) === "1"; } catch { return false; } }
export function setPref(key: string, on: boolean) { try { localStorage.setItem(key, on ? "1" : "0"); } catch { /* private mode */ } }

// ---------- photos ----------

/** Fetches and decodes robot photos ahead of time, so a card never appears with an empty photo window (and a flip never
    shows a blank face). Resolves when they're ready or after `ms`, whichever is first. */
const photos = new Map<number, Promise<void>>();
export function preload(teams: number[], ms = 900): Promise<void> {
  const all = teams.filter((t) => ROBOT.get(t)?.photo !== false).map((t) => {
    let p = photos.get(t);
    if (!p) {
      const im = new Image();
      im.decoding = "async";
      im.src = `/photos/${t}.webp`;
      p = im.decode().catch(() => {});
      photos.set(t, p);
    }
    return p;
  });
  return Promise.race([Promise.all(all).then(() => {}), new Promise<void>((r) => setTimeout(r, ms))]);
}
