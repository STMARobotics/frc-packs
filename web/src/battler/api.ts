// Talking to /api/battler. The server runs every rule; the page only shows what it says and sends taps.

export class ApiError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}

export async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let r: Response;
  try {
    // Every write is JSON, even with nothing to send: the server refuses other writes (a guard against cross-site forms).
    const write = method !== "GET";
    r = await fetch(path, { method, headers: write ? { "Content-Type": "application/json" } : {}, body: write ? JSON.stringify(body ?? {}) : undefined, credentials: "same-origin" });
  } catch {
    throw new ApiError(0, "offline");
  }
  if (r.status === 204) return undefined as T;
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(r.status, (data && data.error) || "server_error");
  return data as T;
}

const MESSAGES: Record<string, string> = {
  offline: "Can't reach the server.",
  stale: "The game moved on.",
  in_game: "You're already in a game.",
  game_full: "Someone else joined first.",
  own_game: "That's your own game.",
  deck_not_ready: "That deck isn't ready.",
  not_in_hand: "That card isn't in your hand.",
  not_your_robot: "Choose one of your robots on the field.",
  bad_stations: "Each robot needs its own station.",
  locked: "You've already locked in.",
  too_many_decks: "Deck limit reached. Delete one first.",
  bad_name: "Name the deck (up to 30 letters).",
  no_session: "Sign in to FRC Packs first.",
  bad_effect: "That effect isn't valid.",
  busy: "Busy, try again.",
  not_your_turn: "Not your pick yet.",
  not_offered: "That robot was taken.",
  bad_partners: "Pick two different robots.",
  not_in_pool: "That robot isn't in your pool.",
  scheduled_partners: "Your partners are fixed by the match schedule.",
  no_drafting: "This game uses a match schedule. There is no draft.",
  too_fast: "Slow down a little.",
  too_new: "New accounts can stake cards, packs and parts after their first day.",
  they_too_new: "They joined today. New accounts can stake after their first day.",
  trade_limit: "That's more than you can take in today (10 packs and 2,000 parts a day, like trades).",
  their_trade_limit: "That's more than they can take in today (10 packs and 2,000 parts a day, like trades).",
  bad_stake: "That stake is too big.",
  under_review: "Wagers are paused on your account while we take a look.",
  they_under_review: "They can't wager right now.",
};

export const explain = (e: unknown) => (e instanceof ApiError ? MESSAGES[e.code] ?? `Something went wrong (${e.code}).` : "Something went wrong.");
