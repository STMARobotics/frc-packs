// Typed client for the Rust server's JSON API. The server decides everything that matters (what's in a pack,
// serial numbers, timers); this only asks and shows the answers.

export type Tier = "mythic" | "legendary" | "rare" | "uncommon" | "common";

export interface Team {
  num: number;
  name: string;
  epa: number | null;
  wl: string;
  div: string;
  srank: number;
  loc: string;
  rank: number;
  tier: Tier;
  photo: boolean;
}

export interface Odds {
  slots: Partial<Record<Tier, number>>;
  last: Partial<Record<Tier, number>>;
  mythicBase: number;
  demoMythic: number;
  soft: number;
  hard: number;
  legEvery: number;
}

export interface Recipe {
  id: string;
  name: string;
  where: string;
  season: number;
  event: string;
  claimable: boolean;
  odds: Odds;
  teams: Team[];
}

export interface Card {
  num: number;
  tier: Tier;
  serial: number;
  isNew: boolean;
  copy: number;
  /** Copies of this team in the whole game right now, this one included. */
  inGame?: number;
}

export interface Opening {
  id: number;
  pack: string;
  revealed: number;
  cards: Card[];
  sets: string[];
}

export interface PackState {
  id: string;
  sealed: number;
  /** How many of the sealed packs are boosted (they have their own stack). */
  boosted: number;
  /** How many of the boosted packs are Mythic packs (three Mythics each). */
  mythic: number;
  opened: number;
  pity: { m: number; l: number };
}

export interface Account {
  username: string;
  admin: boolean;
  firstName?: string | null;
  badge?: string | null;
  /** When the username can next be changed (ms), if not now. */
  renameAt?: number | null;
  bio?: string | null;
  /** Teams picked for the profile picture and banner. */
  avatar?: number | null;
  banner?: number | null;
}

export type TierName = "mythic" | "legendary" | "rare" | "uncommon" | "common";
/** Every team's rarity, as the admin sees it: now, and in the recipe file. */
export interface TierOverview {
  pack: string;
  version: number;
  teams: { num: number; name: string; div: string; tier: TierName; base: TierName }[];
  parts: number;
  note: string;
}
export interface TierPreview {
  changes: { num: number; name: string; from: TierName; to: TierName; copies: number }[];
  mythicCopiesLost: number;
  problem: string | null;
}

export interface State {
  account: Account;
  /** Teams whose rarity the admin changed from the recipe file (team number to rarity). */
  tiers?: Record<string, TierName>;
  /** A note to show once; call api.noticeSeen() after showing it. */
  notice?: string | null;
  favorites?: number[];
  /** Collector level: one per `per` different teams; `claimed` levels have paid out. */
  level?: { teams: number; level: number; claimed: number; per: number; reward: number };
  /** Server time in ms, so timers don't depend on the device clock. */
  now: number;
  nextClaimAt: number;
  claimMs: number;
  /** Packs each timer gives. */
  claimPacks: number;
  /** How many missed timers wait to be claimed. */
  bank: number;
  /** Parts from scrapping extra copies, spent on boosted packs. */
  parts: number;
  boostCost: number;
  donateUrl: string | null;
  /** Parts for scrapping one extra copy, by tier. */
  scrapParts: Record<Tier, number>;
  demo: boolean;
  devTools: boolean;
  missions: Mission[];
  streak: Streak;
  wishlist: number[];
  showcase: number[];
  packs: PackState[];
  pending: Opening | null;
}

export interface Report {
  id: number;
  targetId: string;
  target: string;
  reporter: string;
  reason: "username" | "cheating" | "harassment" | "other";
  details: string;
  createdAt: number;
}

export type FeedbackKind = "bug" | "idea" | "other";
export type FeedbackStatus = "open" | "planned" | "done" | "wontfix";

export interface Feedback {
  id: number;
  kind: FeedbackKind;
  title: string;
  details: string;
  status: FeedbackStatus;
  /** A note from the admin, shown next to the status. */
  note: string;
  createdAt: number;
  /** Accepted: it earned its sender a pack (once). */
  rewarded: boolean;
  /** Admin only: who sent it and where they were (page, version, device). */
  username?: string;
  context?: string;
}

export interface Profile {
  username: string;
  firstName: string | null;
  badge: string | null;
  bio: string | null;
  /** Teams picked for the picture and the banner. */
  avatar: number | null;
  banner: number | null;
  /** Teams owned of each rarity, Mythic first. */
  tiers: [number, number, number, number, number];
  /** Battler record, once they've played. */
  battle: { rating: number; games: number; wins: number; losses: number } | null;
  /** Latest Mythic and Legendary pulls. */
  pulls: { num: number; tier: TierName; serial: number; at: number }[];
  me: boolean;
  joined: number;
  teams: number;
  total: number;
  cards: number;
  sets: number;
  trades: number;
  streak: number;
  /** Sealed standard packs and parts they have (what you can ask for in a trade). */
  packs: number;
  /** Sealed boosted packs they have. */
  boosted: number;
  parts: number;
  showcase: CardRef[];
  rarest: CardRef[];
  wishlist: number[];
}

export interface Mission {
  id: string;
  label: string;
  goal: number;
  progress: number;
  /** Parts it pays. */
  reward: number;
  claimed: boolean;
}

export interface Streak {
  /** Days in a row with a pack opened (0 when the streak has lapsed). */
  days: number;
  /** A pack has been opened today. */
  today: boolean;
  alive: boolean;
  /** A boosted pack every this many days. */
  every: number;
}

export interface Collection {
  pack: string;
  cards: { num: number; serials: number[] }[];
  sets: string[];
}

export interface Invite {
  /** Shown as ABCD-EFGH-JKMN. */
  code: string;
  note: string;
  maxUses: number;
  uses: number;
  createdAt: number;
  usedBy: string[];
}

/** The free-pack rules the admin sets. */
export interface Rules {
  /** Minutes between free packs. */
  claimMinutes: number;
  /** Packs each timer gives. */
  claimPacks: number;
  /** How many missed timers wait to be claimed. */
  bank: number;
  /** Packs a new account starts with. */
  startPacks: number;
  /** Parts a boosted pack costs. */
  boostCost: number;
  /** A donation page (https), or null for none. */
  donateUrl: string | null;
}

export interface AdminUser {
  id: string;
  /** null for a guest account from before sign-in existed. */
  username: string | null;
  admin: boolean;
  disabled: boolean;
  createdAt: number;
  invite: string | null;
  inviteNote: string | null;
  sealed: number;
  opened: number;
  cards: number;
  lastOpenedAt: number | null;
  badge: string | null;
  bio?: string | null;
}

export interface Copy { serial: number; obtained: "pack" | "trade" | "wager" | string; at: number; first: boolean; held: boolean }

export interface Scrapped {
  gained: number;
  scrapped: number;
  /** Extra copies held back: in a pack still being revealed, or in an open trade offer. */
  held: number;
  state: State;
  collection: Collection;
}

export interface CardRef {
  num: number;
  tier: Tier;
  serial: number;
}

export interface Trade {
  id: number;
  /** True when you made the offer. */
  mine: boolean;
  /** The other player. */
  with: string;
  pack: string;
  youGive: CardRef[];
  youGet: CardRef[];
  youGivePacks: number;
  youGetPacks: number;
  youGiveBoosted: number;
  youGetBoosted: number;
  youGiveSpecials: Special[];
  youGetSpecials: Special[];
  youGiveParts: number;
  youGetParts: number;
  status: "open" | "accepted" | "declined" | "cancelled" | "failed";
  createdAt: number;
  decidedAt: number | null;
}

export interface Trades {
  incoming: Trade[];
  outgoing: Trade[];
  recent: Trade[];
}

/** One change to a player's packs, parts or cards, and why (open, scrap, craft, trade 12, claim, ...). */
export interface LedgerEntry {
  at: number;
  item: "packs" | "boosted" | "parts" | "card";
  delta: number;
  detail: string | null;
  reason: string;
}

/** Whether everything adds up: each player's packs, parts and cards against their ledger, and every serial. */
export interface Audit {
  players: number;
  mismatches: { id: string; username: string | null; item: string; have: number; ledger: number }[];
  badSerials: number;
  staleOffers: number;
}

/** status 0 means the server couldn't be reached. */
export class ApiError extends Error {
  constructor(public status: number, public code: string) {
    super(code);
  }
}

async function call<T>(method: "GET" | "POST", path: string, body?: unknown, key?: string): Promise<T> {
  let res: Response;
  try {
    const headers: Record<string, string> = {};
    if (method === "POST") headers["Content-Type"] = "application/json";
    if (key) headers["Idempotency-Key"] = key;
    res = await fetch(path, {
      method,
      credentials: "same-origin",
      headers,
      body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
    });
  } catch {
    throw new ApiError(0, "offline");
  }
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, (data && data.error) || "server_error");
  return data as T;
}

function newKey(): string {
  try {
    return crypto.randomUUID();
  } catch {
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const x = Array.from(b, (v) => v.toString(16).padStart(2, "0")).join("");
    return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
  }
}

/* Actions that change what you own (opening, scrapping, crafting, offering a trade) carry an Idempotency-Key. The
   key stays the same until the server gives an answer, so a retry after a dropped connection (tried here
   automatically, or the player tapping again) can't do the action twice, and a double tap counts once. */
const pending = new Map<string, string>();
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function act<T>(path: string, body?: unknown): Promise<T> {
  const id = path + JSON.stringify(body ?? {});
  let key = pending.get(id);
  if (!key) {
    key = newKey();
    pending.set(id, key);
  }
  for (let attempt = 0; ; attempt++) {
    try {
      const out = await call<T>("POST", path, body, key);
      pending.delete(id);
      return out;
    } catch (e) {
      // No answer, a server hiccup, or the same request still running: safe to ask again with the same key.
      const retry = e instanceof ApiError && (e.status === 0 || e.status >= 500 || e.code === "in_progress");
      if (retry && attempt < 2) {
        await wait(700 * (attempt + 1));
        continue;
      }
      if (!(e instanceof ApiError && e.status === 0)) pending.delete(id); // the server answered: a new tap is a new try
      throw e;
    }
  }
}

export interface Special { id: number; edition: string; team: number; name: string; title: string; serial: number; total: number }
export interface SocialPlayer { name: string; firstName: string | null; badge: string | null; avatar?: number | null; teams: number; mythics: number; legendaries: number; trades: number }
export interface SocialTrade { from: string; to: string; gave: { num: number }[] | null; got: { num: number }[] | null; gavePacks: number; gotPacks: number; at: number }
export interface SocialEvent { kind: "pull" | "set"; who: string; team: number | null; tier: string | null; serial: number | null; division: string | null; at: number }
export interface Social { players: SocialPlayer[]; recent: SocialTrade[]; activity: SocialEvent[] }
/** A player worth trading with: their spares you lack, and yours they lack (wanted ones first). */
export interface TradeMatch { name: string; firstName: string | null; badge: string | null; avatar: number | null; theyHave: number[]; youHave: number[] }

export const api = {
  /** The signed-in account's state. Fails with 401 `sign_in`, or `guest` for a guest account from before sign-in. */
  session: () => call<State>("POST", "/api/session"),
  signup: (code: string, username: string, password: string, firstName: string) =>
    call<State>("POST", "/api/signup", { code, username, password, firstName }),
  login: (username: string, password: string) => call<State>("POST", "/api/login", { username, password }),
  logout: () => call<void>("POST", "/api/logout"),
  changeUsername: (username: string, password: string) => call<State>("POST", "/api/account/username", { username, password }),
  changeFirstName: (firstName: string) => call<State>("POST", "/api/account/name", { firstName }),
  changePassword: (current: string, next: string) => call<void>("POST", "/api/password", { current, new: next }),
  state: () => call<State>("GET", "/api/state"),
  claim: () => call<State>("POST", "/api/claim"),
  /** Pick up a pack: its cards are decided now; only the best rarity comes back, for the glow. */
  /** `boosted` picks the kind: true for a boosted pack, false for a standard one; left out, boosted goes first. */
  hand: (pack: string, boosted?: boolean, mythic = false) => call<{ best: Tier; boosted: boolean }>("POST", "/api/hand", { pack, boosted, mythic }),
  open: (pack: string, boosted?: boolean, mythic = false) => act<{ opening: Opening; state: State; streakReward: boolean }>("/api/open", { pack, boosted, mythic }),
  progress: (id: number, revealed: number) => call<void>("POST", `/api/openings/${id}/progress`, { revealed }),
  collection: (pack: string) => call<Collection>("GET", `/api/collection/${encodeURIComponent(pack)}`),
  /** Scrap extra copies of one team (the first copy is always kept). */
  scrap: (pack: string, num: number, count: number) => act<Scrapped>("/api/scrap", { pack, num, count }),
  /** Scraps one particular copy (never a team's first). */
  scrapCopy: (pack: string, num: number, serial: number) => act<Scrapped>("/api/scrap", { pack, num, count: 1, serial }),
  /** Every copy you have of one team, oldest first. */
  copies: (pack: string, num: number) => call<Copy[]>("GET", `/api/copies/${encodeURIComponent(pack)}/${num}`),
  /** Scrap every extra copy of these tiers. */
  scrapExtras: (pack: string, tiers: Tier[]) => act<Scrapped>("/api/scrap/extras", { pack, tiers }),
  /** Players whose username contains `q`, for picking who to trade with. */
  specials: () => call<Special[]>("GET", "/api/specials"),
  playerSpecials: (name: string) => call<Special[]>("GET", `/api/players/${encodeURIComponent(name)}/specials`),
  social: (pack: string) => call<Social>("GET", `/api/social/${encodeURIComponent(pack)}`),
  players: (q: string) => call<string[]>("GET", `/api/players?q=${encodeURIComponent(q)}`),
  playerCollection: (name: string, pack: string) =>
    call<Collection>("GET", `/api/players/${encodeURIComponent(name)}/collection/${encodeURIComponent(pack)}`),
  trades: () => call<Trades>("GET", "/api/trades"),
  /** Offer one copy each of `give` (your teams) for one copy each of `want` (theirs). */
  offerTrade: (to: string, pack: string, give: number[], want: number[], extra?: { givePacks: number; wantPacks: number; giveBoosted: number; wantBoosted: number; giveParts: number; wantParts: number; giveSpecials?: number[]; wantSpecials?: number[]; giveSerials?: number[]; wantSerials?: number[] }) =>
    act<Trades>("/api/trades", { to, pack, give, want, ...extra }),
  acceptTrade: (id: number) =>
    call<{ sets: string[]; state: State; collection: Collection; trades: Trades }>("POST", `/api/trades/${id}/accept`),
  declineTrade: (id: number) => call<Trades>("POST", `/api/trades/${id}/decline`),
  cancelTrade: (id: number) => call<Trades>("POST", `/api/trades/${id}/cancel`),
  /** The server's push key (null when push isn't set up), and turning notifications on or off for this browser. */
  pushKey: () => call<{ key: string | null }>("GET", "/api/push/key"),
  pushSubscribe: (sub: { endpoint: string; keys: { p256dh: string; auth: string } }) => call<void>("POST", "/api/push/subscribe", sub),
  pushUnsubscribe: (endpoint: string) => call<void>("POST", "/api/push/unsubscribe", { endpoint }),
  /** A player's profile: showcase, stats, rarest cards, wishlist. */
  profile: (name: string, pack: string) => call<Profile>("GET", `/api/players/${encodeURIComponent(name)}/profile/${encodeURIComponent(pack)}`),
  /** Save your bio, picture and banner (teams you own, or null). */
  editProfile: (pack: string, bio: string, avatar: number | null, banner: number | null) =>
    call<{ bio: string | null; avatar: number | null; banner: number | null }>("POST", "/api/profile", { pack, bio, avatar, banner }),
  /** Players worth trading with, best first. */
  tradeMatches: (pack: string) => call<TradeMatch[]>("GET", `/api/trade-matches/${encodeURIComponent(pack)}`),
  /** Put a team on your wishlist or take it off; returns the whole list. */
  setFavorite: (pack: string, team: number, on: boolean) => call<number[]>("POST", "/api/favorites", { pack, team, on }),
  setWish: (pack: string, team: number, on: boolean) => call<number[]>("POST", "/api/wishlist", { pack, team, on }),
  /** Pin up to 3 teams you own to your profile. */
  setShowcase: (pack: string, teams: number[]) => call<number[]>("POST", "/api/showcase", { pack, teams }),
  /** Send a bug report, idea or other note to the admin. `context` says where you were and on what device. */
  sendFeedback: (kind: FeedbackKind, title: string, details: string, context: string) =>
    call<void>("POST", "/api/feedback", { kind, title, details, context }),
  /** What you've sent and how each is doing. */
  myFeedback: () => call<Feedback[]>("GET", "/api/feedback/mine"),
  noticeSeen: () => call<void>("POST", "/api/notice/seen", {}),
  /** Report a player to the admin: reason is username, cheating, harassment or other. */
  report: (username: string, reason: string, details: string) => call<void>("POST", "/api/report", { username, reason, details }),
  /** Collect a finished daily mission's parts. */
  claimLevel: () => call<State>("POST", "/api/level/claim"),
  claimMission: (id: string) => call<State>("POST", `/api/missions/${encodeURIComponent(id)}/claim`),
  /** Spend parts on a boosted pack. */
  craft: () => act<State>("/api/craft"),
  /** Spend 10,000 parts on a Mythic pack (three Mythics). */
  craftMythic: () => act<State>("/api/craft/mythic"),
  /** The pack recipe. `v` (the app version) makes each release fetch it fresh: the file is cached for hours. */
  recipe: (pack: string, v = "") => call<Recipe>("GET", `/packs/${encodeURIComponent(pack)}.json${v ? `?v=${encodeURIComponent(v)}` : ""}`),
  dev: {
    demo: (on: boolean) => call<State>("POST", "/api/dev/demo", { on }),
    pack: (pack: string) => call<State>("POST", "/api/dev/pack", { pack }),
    skipTimer: () => call<State>("POST", "/api/dev/skip-timer"),
    reset: () => call<State>("POST", "/api/dev/reset"),
  },
  admin: {
    invites: () => call<Invite[]>("GET", "/api/admin/invites"),
    makeInvites: (note: string, uses: number, count: number) =>
      call<Invite[]>("POST", "/api/admin/invites", { note, uses, count }),
    deleteInvite: (code: string) => call<void>("POST", `/api/admin/invites/${encodeURIComponent(code)}/delete`),
    users: () => call<AdminUser[]>("GET", "/api/admin/users"),
    resetPassword: (id: string) => call<{ password: string }>("POST", `/api/admin/users/${id}/password`),
    badge: (id: string, badge: string) => call<void>("POST", `/api/admin/users/${id}/badge`, { badge }),
    rename: (id: string, username: string) => call<void>("POST", `/api/admin/users/${id}/rename`, { username }),
    clearBio: (id: string) => call<void>("POST", `/api/admin/users/${id}/clear-bio`, {}),
    reports: () => call<Report[]>("GET", "/api/admin/reports"),
    feedback: () => call<Feedback[]>("GET", "/api/admin/feedback"),
    feedbackStatus: (id: number, status: FeedbackStatus, note: string) =>
      call<{ rewarded: boolean }>("POST", `/api/admin/feedback/${id}/status`, { status, note }),
    resolveReport: (id: number) => call<void>("POST", `/api/admin/reports/${id}/resolve`),
    givePacks: (id: string, count: number) => call<void>("POST", `/api/admin/users/${id}/packs`, { count }),
    setAdmin: (id: string, admin: boolean) => call<void>("POST", `/api/admin/users/${id}/admin`, { admin }),
    setDisabled: (id: string, disabled: boolean) => call<void>("POST", `/api/admin/users/${id}/disabled`, { disabled }),
    deleteUser: (id: string, confirm: string) => call<void>("POST", `/api/admin/users/${id}/delete`, { confirm }),
    settings: () => call<Rules>("GET", "/api/admin/settings"),
    saveSettings: (r: Rules) => call<Rules>("POST", "/api/admin/settings", r),
    /** An unlimited throwaway pack for trying the opening flow. Rolled like a real one; nothing is saved. */
    testPack: (pack: string, boosted = false) =>
      call<{ cards: { num: number; tier: Tier }[] }>("POST", "/api/admin/test-pack", { pack, boosted }),
    ledger: (id: string) => call<LedgerEntry[]>("GET", `/api/admin/users/${id}/ledger`),
    audit: () => call<Audit>("GET", "/api/admin/audit"),
    retier: () => call<{ players: number; compensated: number }>("POST", "/api/admin/retier", {}),
    tiers: () => call<TierOverview>("GET", "/api/admin/tiers"),
    previewTiers: (w: { tiers: Record<string, TierName> }) => call<TierPreview>("POST", "/api/admin/tiers/preview", w),
    applyTiers: (w: { tiers: Record<string, TierName>; parts: number; note: string }) => call<TierOverview>("POST", "/api/admin/tiers/apply", w),
  },
};

/** Friendly words for the server's error codes. */
export function explain(e: unknown): string {
  if (!(e instanceof ApiError)) return "Something went wrong. Try again.";
  const words: Record<string, string> = {
    offline: "Can't reach FRC Packs. Check your connection.",
    bad_login: "That username and password don't match.",
    disabled: "This account is turned off. Ask the person who invited you.",
    too_many_attempts: "Too many tries. Wait 15 minutes and try again.",
    bad_invite: "That invite code doesn't exist. Check it and try again.",
    invite_used: "That invite code has already been used.",
    username_taken: "That username is taken. Try another.",
    rename_too_soon: "You can change your username once every 14 days.",
    bad_username: "Usernames are 3 to 20 letters, numbers or underscores.",
    bad_password: "Passwords need at least 8 characters.",
    bad_first_name: "Enter your first name.",
    no_session: "You've been signed out. Reload to sign in again.",
    not_admin: "Only the admin account can do that.",
    not_yourself: "You can't do that to your own account.",
    confirm_mismatch: "The name you typed doesn't match.",
    not_found: "That no longer exists. Reload the page.",
    not_enough_parts: "Not enough parts yet. Scrap some extra copies first.",
    no_extras: "No extra copies of that card to scrap.",
    extras_held: "Those copies are in a pack you're still opening or in a trade offer. Finish the pack or cancel the offer first.",
    unknown_player: "There's no player with that username.",
    not_owned: "One of those cards isn't available to trade any more.",
    bad_bio: "Keep your bio to 160 characters and 3 lines.",
    trade_stale: "One of the cards in that trade isn't there any more, so the trade was called off.",
    trade_gone: "That trade was already answered or called off.",
    too_many_offers: "You have 20 offers waiting. Cancel some first.",
    bad_trade: "Each side needs something: up to 5 different cards, packs or parts.",
    not_your_trade: "That trade isn't yours to answer.",
    not_enough_to_trade: "You don't have that many packs or parts to trade (boosted packs can't be traded).",
    they_lack: "They don't have that many packs or parts.",
    too_new: "New accounts can trade packs and parts after their first day. You can trade cards right away.",
    they_too_new: "They joined today. New accounts can trade packs and parts after their first day.",
    trade_limit: "You can take in up to 10 packs and 2,000 parts a day through trades. Try a smaller trade, or tomorrow.",
    their_trade_limit: "They've taken in as many packs or parts as they can today through trades. Try a smaller trade, or tomorrow.",
    in_progress: "Still working on that. Give it a moment.",
    mission_not_ready: "That mission isn't finished yet.",
    wishlist_full: "Your wishlist is full (50). Take something off first.",
    username_not_allowed: "That username isn't allowed. Pick something else.",
    too_much_feedback: "You've sent a lot of feedback today. Thank you! Try again tomorrow.",
    admin_only: "The beta isn't open to everyone yet.",
    too_many_reports: "You've sent a lot of reports today. The admin will look at them.",
  };
  return words[e.code] ?? "Something went wrong. Try again.";
}

export type Api = typeof api;
