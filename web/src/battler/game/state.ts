// The game being played: what the server last said, with this player's taps applied on top until the server confirms
// them. A tap shows at once (the card lands on the robot right away) and the request goes out behind it; if the server
// refuses, the screen goes back to what the server says. Taps are sent one at a time, in order.
import { ApiError, call, explain } from "../api";
import { store, toast } from "../store";
import type { GameView, Plan, RobotInst, SupportInst } from "../types";

export const game = store<GameView | null>(null);

let server: GameView | null = null; // the last thing the server said
let pending: { id: number; apply: (g: GameView) => void }[] = [];
let queue: Promise<void> = Promise.resolve();
let opN = 0;
export let clockSkew = 0; // server clock minus this device's

/** Shows the server's game with the taps still on their way applied on top. */
function publish() {
  if (!server) return game.set(null);
  if (!pending.length) return game.set(server);
  const g = structuredClone(server);
  for (const p of pending) { try { p.apply(g); } catch { /* the server will say */ } }
  game.set(g);
}

export function receive(g: GameView) {
  if (g.now) clockSkew = g.now - Date.now();
  server = g;
  publish();
}

export function resetGame() {
  server = null;
  pending = [];
  queue = Promise.resolve();
  game.set(null);
}

/** The code from a private game's invite link: someone not in the game needs it to see and join the game. */
let invite = "";
export const setInvite = (code?: string) => { invite = code ?? ""; };
export const inviteCode = () => invite;

export async function fetchGame(id: string, sinceRev = true) {
  const p = new URLSearchParams();
  if (sinceRev && server) { p.set("rev", String(server.rev)); p.set("e", String(server.emote_seq)); }
  if (invite) p.set("code", invite);
  const q = p.toString() ? `?${p}` : "";
  const r = await call<GameView & { same?: boolean }>("GET", `/api/battler/games/${id}${q}`);
  if (!r.same) receive(r);
}

/** Sends one action. `optimistic` changes the shown game right away. */
export function act(action: Record<string, unknown>, optimistic?: (g: GameView) => void): Promise<void> {
  const id = ++opN;
  if (optimistic) { pending.push({ id, apply: optimistic }); publish(); }
  const done = () => { pending = pending.filter((p) => p.id !== id); };
  const run = async () => {
    if (!server) return done();
    const status = server.status, round = server.round, gid = server.id;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const g = await call<GameView>("POST", `/api/battler/games/${gid}/act`, { rev: server!.rev, action });
        done();
        receive(g);
        return;
      } catch (e) {
        if (!(e instanceof ApiError && e.code === "stale")) {
          done();
          toast(explain(e), true);
          await fetchGame(gid, false).catch(() => publish());
          return;
        }
        // The other player changed something (their own pit, usually). Catch up, and if we're still in the same phase of
        // the same round, send the tap again: the server checks every rule against the fresh game anyway.
        try { await fetchGame(gid, false); } catch { break; }
        if (server!.status !== status || server!.round !== round) break;
      }
    }
    done();
    publish();
  };
  const p = queue.then(run);
  queue = p.catch(() => {});
  return p;
}

// ---------- reading the game ----------

export const robotOf = (g: GameView, inst: number | null | undefined): RobotInst | undefined => (inst == null ? undefined : g.robots.find((r) => r.inst === inst));
export const cardOf = (g: GameView, inst: number | null | undefined): SupportInst | undefined => (inst == null ? undefined : g.support.find((c) => c.inst === inst));

/** Whether the game is waiting on this player right now. */
export function myMove(g: GameView) {
  const me = g.me ? g.seats[g.me.side] : null;
  if (!me) return false;
  return (g.status === "DECKS" && !me.picked) || (g.status === "SCHEDULE" && !me.acked) || (g.status === "PIT" && !me.locked) || (g.status === "RESULTS" && !me.acked);
}

// ---------- the taps, with what each one changes on screen right away ----------

const plan = (g: GameView): Plan => g.me!.plan;

export const attach = (part: number, robot: number) =>
  act({ kind: "attach", part, robot }, (g) => { const p = plan(g); p.attach = [...p.attach.filter(([x]) => x !== part), [part, robot]]; if (p.lore === part) p.lore = null; });
export const detach = (part: number) => act({ kind: "detach", part }, (g) => { const p = plan(g); p.attach = p.attach.filter(([x]) => x !== part); });
export const playLore = (card: number | null) =>
  act({ kind: "lore", card }, (g) => { const p = plan(g); p.lore = card; if (card !== null) p.attach = p.attach.filter(([x]) => x !== card); });
export const setStations = (robots: [number, number, number]) => act({ kind: "stations", robots }, (g) => { plan(g).stations = robots; });
export const setPartners = (robots: [number, number]) =>
  act({ kind: "partners", robots }, (g) => {
    const side = g.me!.side, cap = g.alliances[side][0], p = plan(g);
    p.partners = robots;
    p.stations = [cap, robots[0], robots[1]];
    p.attach = p.attach.filter(([, r]) => r === cap || robots.includes(r));
    g.alliances[side] = [cap, robots[0], robots[1]];
  });
export const lock = () => act({ kind: "lock" }, (g) => { g.seats[g.me!.side]!.locked = true; });
export const ack = () => act({ kind: "ack" }, (g) => { g.seats[g.me!.side]!.acked = true; });
