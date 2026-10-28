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
  not_your_robot: "Parts go on your own robots.",
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
  broken: "That robot is being repaired.",
  too_fast: "Slow down a little.",
};

export const explain = (e: unknown) => (e instanceof ApiError ? MESSAGES[e.code] ?? `Something went wrong (${e.code}).` : "Something went wrong.");
