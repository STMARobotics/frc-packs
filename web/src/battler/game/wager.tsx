// Wagers, in a private match before it starts. Each player puts up a stake (parts, sealed packs, cards, special
// editions, or a pink slip: the robots in the deck they bring), both see both with a meter of how even it is, and both
// accept; then the server takes both stakes into escrow and the winner gets everything. Changing either stake takes
// back both acceptances, and either player can call the wager off and just play.
import { useEffect, useState } from "preact/hooks";
import { call, explain } from "../api";
import { closeSheet, openSheet, ROBOT, toast } from "../store";
import type { GameView, Stake, StakeHeld } from "../types";
import { cx, plural, Spinner, Stepper } from "../ui";
import { fetchGame } from "./state";

const PACK = "cmp26";
const PACK_WORTH = 50, SPECIAL_WORTH = 800; // weighed like the trading post: a sealed pack is 50 parts
const empty: Stake = { parts: 0, packs: 0, boosted: 0, teams: [], specials: [], pink: false };

/** What FRC Packs says about you: what you can stake, and what things are worth. Loaded once per match. */
interface Mine {
  parts: number; standard: number; boosted: number; boostCost: number; scrap: Record<string, number>;
  cards: { num: number; count: number }[]; kept: Set<number>; specials: { id: number; title: string; serial: number; total: number }[];
}
let mine: Promise<Mine> | null = null;
function loadMine(): Promise<Mine> {
  mine ??= (async () => {
    const [s, col, sp] = await Promise.all([
      call<{ parts: number; boostCost: number; scrapParts: Record<string, number>; favorites?: number[]; packs: { id: string; sealed: number; boosted: number; mythic: number }[] }>("GET", "/api/state"),
      call<{ cards: { num: number; serials: number[] }[] }>("GET", `/api/collection/${PACK}`),
      call<{ id: number; title: string; serial: number; total: number }[]>("GET", "/api/specials"),
    ]);
    const p = s.packs.find((x) => x.id === PACK) ?? { sealed: 0, boosted: 0, mythic: 0 };
    return {
      parts: s.parts, standard: p.sealed - p.boosted, boosted: p.boosted - p.mythic, boostCost: s.boostCost, scrap: s.scrapParts,
      cards: col.cards.filter((c) => c.serials.length).map((c) => ({ num: c.num, count: c.serials.length })), kept: new Set(s.favorites ?? []), specials: sp,
    };
  })().catch((e) => { mine = null; throw e; });
  return mine;
}
const worth = (s: Stake, m: Pick<Mine, "boostCost" | "scrap">) =>
  s.parts + s.packs * PACK_WORTH + s.boosted * m.boostCost + s.specials.length * SPECIAL_WORTH + s.teams.reduce((a, t) => a + (m.scrap[ROBOT.get(t)?.tier ?? "common"] ?? 0), 0);
const isEmpty = (s: Stake) => !s.parts && !s.packs && !s.boosted && !s.teams.length && !s.specials.length && !s.pink;

/** The stake as chips: what's in it. */
function StakeChips({ s, held, mine }: { s: Stake; held?: StakeHeld; mine: boolean }) {
  if (isEmpty(s)) return <p class="b-dim b-small">Nothing yet</p>;
  const cards = held ? held.cards.map((c) => `#${c.num} No. ${c.serial}`) : s.teams.map((t) => `#${t} ${ROBOT.get(t)?.name ?? ""}`.trim());
  return (
    <div class="b-stake">
      {!!s.parts && <span class="b-chip">⚙ {s.parts} parts</span>}
      {!!s.packs && <span class="b-chip">{plural(s.packs, "pack")}</span>}
      {!!s.boosted && <span class="b-chip gold">{plural(s.boosted, "boosted pack")}</span>}
      {s.pink && !held && <span class="b-chip pink">Pink slip: {mine ? "your" : "their"} deck</span>}
      {!!s.specials.length && <span class="b-chip gold">{plural(s.specials.length, "special edition")}</span>}
      {cards.map((c) => <span class="b-chip">{c}</span>)}
    </div>
  );
}

/** The wager on a private match, under the deck pick. */
export function WagerPanel({ g }: { g: GameView }) {
  const side = g.me!.side, op = 1 - side, them = g.seats[op]!;
  const w = g.stakes;
  const [m, setM] = useState<Mine | null>(null);
  const [busy, setBusy] = useState("");
  useEffect(() => { loadMine().then(setM, () => {}); }, []);
  const run = async (what: string, method: string, path: string) => {
    setBusy(what);
    try { await call(method, `/api/battler/games/${g.id}/wager${path}`); await fetchGame(g.id, false); } catch (e) { toast(explain(e), true); }
    setBusy("");
  };
  if (g.wager === "none" || !w) {
    return (
      <div class="b-wager">
        <div class="b-wager-h"><b>No wager</b><span class="b-dim b-small">Put something up: the winner takes both stakes.</span></div>
        <button type="button" class="b-btn ghost small" onClick={() => editStake(g, empty)}>Add a wager</button>
      </div>
    );
  }
  const locked = g.wager === "locked";
  const a = w.stakes[side], b = w.stakes[op], va = m ? worth(a, m) : 0, vb = m ? worth(b, m) : 0;
  const lean = va + vb ? (vb - va) / (va + vb) : 0; // -1: all yours on the line, +1: all theirs
  return (
    <div class={cx("b-wager", locked && "locked")}>
      <div class="b-wager-h"><b>{locked ? "Wager locked in" : "Wager"}</b><span class="b-dim b-small">{locked ? "Winner takes both stakes." : "Both accept, then it's locked until the match ends."}</span></div>
      <div class="b-wager-side">
        <small>You put up {w.accepted[side] && <em class="ok">accepted</em>}</small>
        <StakeChips s={a} held={locked ? w.held[side] : undefined} mine />
      </div>
      <div class="b-wager-side">
        <small>{them.name} puts up {w.accepted[op] && <em class="ok">accepted</em>}</small>
        <StakeChips s={b} held={locked ? w.held[op] : undefined} mine={false} />
      </div>
      {!locked && m && (
        <div class="b-meter" title="How even the stakes are, weighed like the trading post">
          <span class="b-meter-bar"><i class="me" style={{ flexGrow: va || 1 }} /><i class="op" style={{ flexGrow: vb || 1 }} /></span>
          <small class="b-dim">{Math.abs(lean) < 0.15 ? "About even" : lean > 0 ? "Their stake is bigger" : "Your stake is bigger"}{a.pink || b.pink ? " (plus a deck)" : ""}</small>
        </div>
      )}
      {!locked && (
        <div class="b-wager-btns">
          <button type="button" class="b-btn ghost small" disabled={!!busy} onClick={() => editStake(g, a)}>Change mine</button>
          <button type="button" class="b-btn small" disabled={!!busy || w.accepted[side]} onClick={() => run("accept", "POST", "/accept")}>
            {busy === "accept" ? <Spinner small /> : w.accepted[side] ? "Accepted" : "Accept"}
          </button>
          <button type="button" class="b-link" disabled={!!busy} onClick={() => run("off", "DELETE", "")}>Call it off</button>
        </div>
      )}
    </div>
  );
}

function editStake(g: GameView, start: Stake) {
  openSheet(() => <StakeEditor g={g} start={start} />);
}

/** What you put up. */
function StakeEditor({ g, start }: { g: GameView; start: Stake }) {
  const [m, setM] = useState<Mine | null>(null);
  const [s, setS] = useState<Stake>({ ...empty, ...start });
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { loadMine().then(setM, (e) => toast(explain(e), true)); }, []);
  if (!m) return <div class="b-center small"><Spinner /></div>;
  const n = (t: number) => s.teams.filter((x) => x === t).length;
  const add = (t: number) => setS({ ...s, teams: [...s.teams, t] });
  const sub = (t: number) => { const i = s.teams.lastIndexOf(t); setS({ ...s, teams: s.teams.filter((_, j) => j !== i) }); };
  const needle = q.trim().toLowerCase();
  const list = m.cards
    .filter((c) => !m.kept.has(c.num) && (!needle || String(c.num).startsWith(needle) || (ROBOT.get(c.num)?.name ?? "").toLowerCase().includes(needle)))
    .sort((x, y) => (n(y.num) - n(x.num)) || (ROBOT.get(x.num)?.name ?? "").localeCompare(ROBOT.get(y.num)?.name ?? ""))
    .slice(0, 40);
  const save = async () => {
    setBusy(true);
    try { await call("PUT", `/api/battler/games/${g.id}/wager`, s); closeSheet(); await fetchGame(g.id, false); } catch (e) { toast(explain(e), true); }
    setBusy(false);
  };
  return (
    <div class="b-stakeed">
      <h2>Your stake</h2>
      <label class="b-stakerow"><span>Parts <small>{m.parts} available</small></span>
        <input class="b-input b-num" type="number" inputMode="numeric" min={0} max={m.parts} step={10} value={s.parts || ""} placeholder="0" onInput={(e) => setS({ ...s, parts: Math.max(0, Math.min(m.parts, Math.floor(+e.currentTarget.value || 0))) })} />
      </label>
      <div class="b-stakerow"><span>Packs <small>{m.standard} sealed</small></span><Stepper n={s.packs} minus={() => setS({ ...s, packs: s.packs - 1 })} plus={() => setS({ ...s, packs: s.packs + 1 })} canPlus={s.packs < m.standard} /></div>
      <div class="b-stakerow"><span>Boosted packs <small>{m.boosted} sealed</small></span><Stepper n={s.boosted} minus={() => setS({ ...s, boosted: s.boosted - 1 })} plus={() => setS({ ...s, boosted: s.boosted + 1 })} canPlus={s.boosted < m.boosted} /></div>
      <label class="b-check b-stakerow pinkrow"><input type="checkbox" checked={s.pink} onChange={(e) => setS({ ...s, pink: e.currentTarget.checked })} />
        <span>Pink slip <small>One copy of every robot in the deck you bring (Kept teams stay yours)</small></span>
      </label>
      {!!m.specials.length && (
        <>
          <h3 class="b-h2">Special editions</h3>
          {m.specials.map((x) => (
            <label class="b-check b-stakerow"><input type="checkbox" checked={s.specials.includes(x.id)} onChange={(e) => setS({ ...s, specials: e.currentTarget.checked ? [...s.specials, x.id] : s.specials.filter((y) => y !== x.id) })} />
              <span>{x.title} <small>No. {x.serial} of {x.total}</small></span></label>
          ))}
        </>
      )}
      <h3 class="b-h2">Cards {!!s.teams.length && <small>{s.teams.length} chosen</small>}</h3>
      <input class="b-input" type="search" placeholder="Search number or name" value={q} onInput={(e) => setQ(e.currentTarget.value)} aria-label="Search your cards" />
      <div class="b-stakecards">
        {list.map((c) => {
          const r = ROBOT.get(c.num);
          return (
            <div class={cx("b-stakecard", n(c.num) > 0 && "on")}>
              <span><b>#{c.num}</b> {r?.name ?? ""}<small class={`t-${r?.tier ?? "common"}`}>{r?.tier ?? ""} · {plural(c.count, "copy", "copies")}</small></span>
              <Stepper n={n(c.num)} minus={() => sub(c.num)} plus={() => add(c.num)} canPlus={n(c.num) < c.count && s.teams.length < 20} />
            </div>
          );
        })}
        {!list.length && <p class="b-dim b-small">No cards match.</p>}
      </div>
      <p class="b-dim b-small">Worth about {worth(s, m)} parts{s.pink ? ", plus your deck" : ""}. Kept cards can't be staked.</p>
      <button type="button" class="b-btn wide sticky" disabled={busy} onClick={save}>{busy ? <Spinner small /> : isEmpty(s) ? "Put up nothing" : "Put it up"}</button>
    </div>
  );
}

/** After the match: what the wager did. */
export function WagerResult({ g }: { g: GameView }) {
  const w = g.stakes;
  if (!w || (w.status !== "settled" && w.status !== "returned")) return null;
  const side = g.me!.side;
  const text = w.status === "returned" ? "No winner, so both stakes went back." : w.winner === side ? `You won ${g.seats[1 - side]!.name}'s stake. It's in your collection.` : `${g.seats[1 - side]!.name} took your stake.`;
  return <div class={cx("b-wager", "result", w.status === "settled" && (w.winner === side ? "won" : "lost"))}><b>Wager</b><p>{text}</p></div>;
}
