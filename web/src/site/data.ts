// The pack: its teams (ranked and tiered by tools/build_packs.py), rarities, divisions. Loaded once at start.
import type { Recipe, Team, Tier } from "../api";

export const PACK = "cmp26";
export const ORDER: Tier[] = ["mythic", "legendary", "rare", "uncommon", "common"];
export const TIERS: Record<Tier, { label: string; color: string }> = {
  common: { label: "Common", color: "#aab8c4" },
  uncommon: { label: "Uncommon", color: "#8bbcf0" },
  rare: { label: "Rare", color: "#ffc850" },
  legendary: { label: "Legendary", color: "#b478ff" },
  mythic: { label: "Mythic", color: "#3cffdc" },
};
export const STARS: Record<Tier, number> = { common: 1, uncommon: 2, rare: 3, legendary: 4, mythic: 5 };

/** A team as the cards show it. `bt` (Battler stats) arrives once the stats import runs. */
export type T = Team & { region?: string; bt?: { auto: number; tele: number; end: number; rp: [number, number, number]; effect?: string; effectName?: string } };

export let RECIPE: Recipe;
export let TEAMS: T[] = [];
export const BY_NUM = new Map<number, T>();
export const POOL: Record<Tier, T[]> = { mythic: [], legendary: [], rare: [], uncommon: [], common: [] };
export let DIVS: string[] = [];
export const DIV_TEAMS = new Map<string, T[]>();

export function setRecipe(r: Recipe, tiers?: Record<string, Tier>) {
  for (const t of r.teams) if (tiers?.[t.num]) t.tier = tiers[t.num];
  RECIPE = r;
  TEAMS = r.teams as T[];
  for (const t of TEAMS) {
    t.bt ??= testStats(t.num, t.epa);
    BY_NUM.set(t.num, t);
    POOL[t.tier].push(t);
    if (!DIV_TEAMS.has(t.div)) DIV_TEAMS.set(t.div, []);
    DIV_TEAMS.get(t.div)!.push(t);
  }
  DIVS = [...DIV_TEAMS.keys()].sort();
}

/** Small, stable variation per team, exactly as the server's (server/src/battler/content.rs, wobble). */
function wobble(team: number, salt: number): number {
  let x = (Math.imul(team, 2654435761) + Math.imul(salt, 40503)) >>> 0;
  x = (x ^ (x >>> 13)) >>> 0;
  x = Math.imul(x, 1274126177) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  return (x % 1000) / 1000 - 0.5;
}

/** The Battler's stats for a team without imported ones, the same numbers the Battler plays with (content.rs,
    test_stats), so a card shows what its robot does in a battle. */
export function testStats(team: number, epa?: number | null): NonNullable<T["bt"]> {
  const e = epa != null && Number.isFinite(epa) && epa > 0 ? epa : 60;
  const n = e / 3, auto = 0.22 + 0.08 * wobble(team, 1), end = 0.16 + 0.08 * wobble(team, 2), tele = 1 - auto - end;
  const strength = Math.min(1, Math.max(0, e / 370));
  const rp = (salt: number) => Math.min(92, Math.max(3, Math.round(12 + 60 * strength + 30 * wobble(team, salt))));
  return { auto: Math.round(n * auto), tele: Math.round(n * tele), end: Math.round(n * end), rp: [rp(3), rp(4), rp(5)] };
}

/** Puts each robot's Battler effect on its card (the Battler has them; the pack file doesn't). */
export function setEffects(fx: Record<string, { name: string | null; text: string }>) {
  for (const [team, { name, text }] of Object.entries(fx)) {
    const t = BY_NUM.get(+team);
    if (t?.bt) { t.bt.effect = text; t.bt.effectName = name ?? undefined; }
  }
}

/** Rarest first, then by rank. */
export const byRarity = (a: T, b: T) => ORDER.indexOf(a.tier) - ORDER.indexOf(b.tier) || a.rank - b.rank;
