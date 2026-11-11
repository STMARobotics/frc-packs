// Social: the activity feed (Mythic and Legendary pulls, finished sets, trades) and everyone, ranked and searchable;
// tapping a name opens their profile page. Checks for news every few seconds while it's on screen.
import { useEffect, useRef, useState } from "preact/hooks";
import type { SocialPlayer } from "../../api";
import { useStore } from "../../lib/store";
import { BY_NUM, TIERS } from "../data";
import { ago, loadSocial, social, st } from "../state";
import { Avatar, Card, cx, Spinner } from "../ui";
import { openCard } from "./cardview";
import { openProfile } from "./profile";

type By = "teams" | "mythics" | "legendaries" | "trades";

/** Players and Activity, two of the Trade tab's sections since 0.14 (`pg` says which; it has no tabs of its own). */
export function SocialTab({ active, pg }: { active: boolean; pg: "act" | "ppl" }) {
  const d = useStore(social);
  const me = useStore(st)!.account.username.toLowerCase();
  const [by, setBy] = useState<By>("teams");
  const [q, setQ] = useState("");
  useEffect(() => {
    if (!active) return;
    loadSocial();
    const t = setInterval(() => { if (document.visibilityState === "visible") loadSocial(); }, 8000);
    return () => clearInterval(t);
  }, [active]);
  if (!d) return <div class="s-center small"><Spinner /></div>;
  const v = q.trim().toLowerCase();
  const ranked = d.players.slice().sort((a, b) => b[by] - a[by] || b.teams - a.teams);
  const rows = ranked.map((p, i) => [p, i] as const).filter(([p]) => !v || p.name.toLowerCase().includes(v) || (p.firstName ?? "").toLowerCase().includes(v));
  return (
    <div class="s-screen s-social">
      {pg === "act" ? <Activity /> : (
        <>
          <input autoComplete="off" data-1p-ignore data-lpignore="true" data-form-type="other" class="s-input" type="search" placeholder="Find a player" value={q} onInput={(e) => setQ(e.currentTarget.value)} autoCapitalize="none" spellcheck={false} aria-label="Find a player" />
          <div class="s-chips">{(["teams", "mythics", "legendaries", "trades"] as By[]).map((b) => (
            <button type="button" class={cx("s-chip", by === b && "on")} aria-pressed={by === b} onClick={() => setBy(b)}>{b[0].toUpperCase() + b.slice(1)}</button>
          ))}</div>
          <div class="s-list">
            {rows.map(([p, i]) => (
              <button type="button" key={p.name} class={cx("so-row", p.name.toLowerCase() === me && "me")} onClick={() => openProfile(p.name)}>
                <i>{i + 1}</i>
                <span class="so-who"><Avatar name={p.name} team={p.avatar} /><Who p={p} /></span>
                <span class="so-n"><b>{p[by]}</b><small>{by}</small></span>
              </button>
            ))}
            {!rows.length && <p class="s-dim">No player matches that.</p>}
          </div>
        </>
      )}
    </div>
  );
}

export function Who({ p }: { p: Pick<SocialPlayer, "name" | "firstName" | "badge"> }) {
  return <span class="so-name">{p.firstName ? <>{p.firstName} <small>{p.name}</small></> : p.name}{p.badge && <em class="s-badge">{p.badge}</em>}</span>;
}

interface Ev { kind: "pull" | "set" | "trade"; who: string; at: number; team?: number | null; tier?: string | null; serial?: number | null; division?: string | null; other?: string; gave?: { num: number }[] | null; got?: { num: number }[] | null }

function Activity() {
  const d = useStore(social)!;
  const seen = useRef<Set<string> | null>(null);
  const ev: Ev[] = [...d.activity];
  for (const t of d.recent) ev.push({ kind: "trade", who: t.from, other: t.to, at: t.at, gave: t.gave, got: t.got });
  // Pulls show the team's rarity today, not the one recorded at the time.
  for (const e of ev) if (e.kind === "pull" && e.team && BY_NUM.has(e.team)) e.tier = BY_NUM.get(e.team)!.tier;
  const list = ev.filter((e) => e.kind !== "pull" || e.tier === "mythic" || e.tier === "legendary").sort((a, b) => b.at - a.at).slice(0, 30);
  const key = (e: Ev) => `${e.kind}:${e.who}:${e.at}`;
  const first = !seen.current;
  const fresh = (e: Ev) => !first && !seen.current!.has(key(e));
  useEffect(() => { seen.current = new Set(list.map(key)); });
  if (!list.length) return <div class="s-empty">Nothing yet. Mythic and Legendary pulls and trades show up here.</div>;
  const names = (c?: { num: number }[] | null) => (c ?? []).map((x) => x.num).filter((n) => BY_NUM.has(n)).join(", ") || "packs";
  return (
    <div class="s-list">
      {list.map((e) => (
        <div key={key(e)} class={cx("so-ev", fresh(e) && "fresh")}>
          {e.kind === "pull" && e.team && BY_NUM.has(e.team) ? (
            <>
              <span class="fe-t"><Name n={e.who} /> pulled <b style={{ color: TIERS[e.tier as "mythic"].color }}>{TIERS[e.tier as "mythic"].label}</b> · {BY_NUM.get(e.team)!.name}{e.serial && e.serial <= 10 ? <span class="s-bdg g">No. {e.serial}</span> : null}<time>{ago(e.at)}</time></span>
              <button type="button" class="fe-c" aria-label={`See ${BY_NUM.get(e.team)!.name}`} onClick={() => openCard(e.team!, undefined, { serial: e.serial ?? undefined, from: `${e.who}'s pull.` })}>
                <Card num={e.team} serial={e.serial ?? undefined} w="56px" />
              </button>
            </>
          ) : e.kind === "set" ? (
            <span class="fe-t">🏆 <Name n={e.who} /> finished the <b>{e.division}</b> set<time>{ago(e.at)}</time></span>
          ) : (
            <details class="fe-trade">
              <summary class="fe-t">⇄ <Name n={e.who} /> traded {names(e.gave)} to <Name n={e.other ?? ""} /> for {names(e.got)}<time>{ago(e.at)}</time></summary>
              {/* The cards themselves (#93), each side under who gave it. */}
              {([[e.who, e.gave], [e.other ?? "", e.got]] as const).map(([who, cs]) => (cs ?? []).some((c) => BY_NUM.has(c.num)) && (
                <div class="fe-side"><small>{who} gave</small><div class="fe-cards">{(cs ?? []).filter((c) => BY_NUM.has(c.num)).map((c) => (
                  <button type="button" class="fe-c" aria-label={`See ${BY_NUM.get(c.num)!.name}`} onClick={() => openCard(c.num, undefined, { from: `In ${e.who}'s trade with ${e.other}.` })}><Card num={c.num} w="56px" /></button>
                ))}</div></div>
              ))}
            </details>
          )}
        </div>
      ))}
    </div>
  );
}

/** A player's name in the feed: tap it for their profile. */
const Name = ({ n }: { n: string }) => <button type="button" class="fe-name" onClick={() => openProfile(n)}>{n}</button>;
