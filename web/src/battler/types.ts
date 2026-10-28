// What the server sends (mirrors server/src/battler).

export type Phase = "AUTO" | "TELE" | "END" | "ALL";
export interface Stats { auto: number; tele: number; end: number; rp: [number, number, number] }
export interface RobotCard {
  team: number; name: string; region: string; tier: string; photo: boolean; stats: Stats;
  test_stats: boolean; effect_text: string; effect_test: boolean;
}
export interface Robot extends RobotCard { id: string; season: number }
export interface Support { id: string; kind: "PART" | "LORE"; name: string; season: number; tags: string[]; text: string; flavor: string; draft: boolean }
export interface Rules {
  rounds: number; deck_robots: number; support_cards: number; draw: number; max_copies: number; pit_seconds: number; results_seconds: number;
  strikes: number; start_elo: number; pool_size: number; offer: number; draft_seconds: number; intro_seconds: number; drain: number; recharge: number; repair_battery: number;
}
export interface Catalog { season: number; rp_names: [string, string, string]; rules: Rules; robots: Robot[]; support: Support[]; tags: [string, string[]][] }
export interface Deck { id: string; name: string; captain: number | null; robots: number[]; support: string[]; updated: number }
export interface DeckRow { deck: Deck; problems: string[] }
export interface Profile { elo: number; games: number; wins: number; losses: number; draws: number }
export interface Home { name: string; is_admin: boolean; profile: Profile; active: string | null; owned_teams: number[]; support_owned: Record<string, number>; decks: DeckRow[] }

export interface RobotInst extends RobotCard { inst: number; card: string; from: number; battery: number; broken: number }
export interface SupportInst { inst: number; owner: number; card: string; kind: "PART" | "LORE"; name: string; tags: string[]; text: string }
export interface Plan { attach: [number, number][]; lore: number | null; partners: [number, number]; stations: [number, number, number] }
export interface SeatView {
  name: string; elo: number; picked: boolean; locked: boolean; acked: boolean; rp: number; points: number; hand_count: number; pile_count: number;
  strikes: number; parts_down: number; lore_down: boolean; pool: number[];
}
export interface EmoteView { side: number; id: string; at: number; n: number }
export interface RobotScore {
  inst: number; side: number; station: number; battery: number; power: number; broke: boolean; base: [number, number, number];
  points: [number, number, number]; rp_chance: number; rp_roll: number; rp_hit: boolean;
}
export interface GameEvent { source: string; target: number; text: string }
export interface RoundResult {
  robots: RobotScore[]; phase_totals: [[number, number, number], [number, number, number]]; totals: [number, number]; winner: number | null;
  match_rp: [number, number]; bonus_rp: [number, number]; events: GameEvent[];
}
export interface RoundLog {
  round: number; stations: [[number, number, number], [number, number, number]]; attach: [[number, number][], [number, number][]];
  lore: [number | null, number | null]; result: RoundResult; auto_locked: [boolean, boolean];
}
export interface Outcome { winner: number | null; reason: string; rp: [number, number]; points: [number, number]; elo_before: [number, number]; elo_after: [number, number] }
export type Status = "OPEN" | "DECKS" | "DRAFT" | "PIT" | "RESULTS" | "FINAL" | "CANCELLED";
export interface GameView {
  id: string; rev: number; status: Status; round: number; rounds_total: number; deadline: number;
  seats: (SeatView | null)[]; me: { side: number; hand: number[]; plan: Plan } | null;
  alliances: [[number, number, number], [number, number, number]]; pool_left: number;
  offer: number[]; draft_turn: number; draft_total: number; draft_side: number | null;
  robots: RobotInst[]; support: SupportInst[]; rounds: RoundLog[]; seed_hash: string; seed: string | null; outcome: Outcome | null;
  emotes: EmoteView[]; emote_seq: number; now: number;
}
export interface HistoryRow { game: string; opponent: string; winner: boolean | null; reason: string; rp: [number, number]; points: [number, number]; elo_before: number; elo_after: number; at: number }

export interface Cond { if: "HAS_PART_TAG" | "STATION" | "CAPTAIN" | "LORE_ACTIVE"; tag?: string; min?: number; station?: number; is?: boolean; of?: "TARGET" | "SOURCE" }
export interface Effect { op: string; phase?: Phase; value?: number; percent?: number; rp?: string; tag?: string; scope: string; when?: Cond[]; chance?: number }
export interface FxRow { team: number; draft: Effect[]; published: Effect[]; rev: number; author: string; updated: number; draft_text: string; published_text: string }
