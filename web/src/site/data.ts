// The pack: its teams (ranked and tiered by tools/build_packs.py), rarities, divisions. Loaded once at start.
import type { Recipe, Team, Tier } from "../api";

export const PACK = "cmp26";
export const ORDER: Tier[] = ["mythic", "legendary", "rare", "uncommon", "common"];
export const TIERS: Record<Tier, { label: string; color: string }> = {
  common: { label: "Common", color: "#aab8c4" },
  uncommon: { label: "Uncommon", color: "#7fe0d2" },
  rare: { label: "Rare", color: "#ffc850" },
  legendary: { label: "Legendary", color: "#b478ff" },
  mythic: { label: "Mythic", color: "#3cffdc" },
};
export const STARS: Record<Tier, number> = { common: 1, uncommon: 2, rare: 3, legendary: 4, mythic: 5 };
/** The three bonus RP each season's cards use (same for every card in a season). */
export const RP_NAMES: Record<number, [string, string, string]> = { 2025: ["Auto", "Coral", "Barge"], 2026: ["Energized", "Supercharged", "Traversal"] };

/** A team as the cards show it. `bt` (Battler stats) arrives once the stats import runs. */
export type T = Team & { region?: string; bt?: { auto: number; tele: number; end: number; rp: [number, number, number]; effect?: string } };

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
    BY_NUM.set(t.num, t);
    POOL[t.tier].push(t);
    if (!DIV_TEAMS.has(t.div)) DIV_TEAMS.set(t.div, []);
    DIV_TEAMS.get(t.div)!.push(t);
  }
  DIVS = [...DIV_TEAMS.keys()].sort();
}

/** Rarest first, then by rank. */
export const byRarity = (a: T, b: T) => ORDER.indexOf(a.tier) - ORDER.indexOf(b.tier) || a.rank - b.rank;
