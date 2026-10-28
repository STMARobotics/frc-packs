// Social: the activity feed (Mythic and Legendary pulls, finished sets, trades) and every player, ranked. Checks for news
// every few seconds while it's on screen.
import { useEffect, useRef, useState } from "preact/hooks";
import type { SocialPlayer } from "../../api";
import { useStore } from "../../lib/store";
import { BY_NUM, TIERS } from "../data";
import { ago, loadSocial, social, st } from "../state";
import { Avatar, Card, cx, Spinner, Tabs } from "../ui";
import { openCard } from "./cardview";
import { openProfile } from "./profile";
import { tradeFor } from "./trade";

type By = "teams" | "mythics" | "legendaries" | "trades";

export function SocialTab({ active }: { active: boolean }) {
  const d = useStore(social);
  const me = useStore(st)!.account.username.toLowerCase();
  const [pg, setPg] = useState<"act" | "ppl">("act");
  const [by, setBy] = useState<By>("teams");
  useEffect(() => {
    if (!active) return;
    loadSocial();
    const t = setInterval(() => { if (document.visibilityState === "visible") loadSocial(); }, 8000);
    return () => clearInterval(t);
  }, [active]);
  if (!d) return <div class="s-center small"><Spinner /></div>;
  const rows = d.players.slice().sort((a, b) => b[by] - a[by] || b.teams - a.teams);
  return (
    <div class="s-screen s-social">
      <Tabs value={pg} onChange={setPg} options={[["act", "Activity"], ["ppl", "Players"]]} />
      {pg === "act" ? <Activity /> : (
        <>
          <div class="s-chips">{(["teams", "mythics", "legendaries", "trades"] as By[]).map((b) => (
            <button type="button" class={cx("s-chip", by === b && "on")} aria-pressed={by === b} onClick={() => setBy(b)}>{b[0].toUpperCase() + b.slice(1)}</button>
          ))}</div>
          <div class="s-list">
            {rows.map((p, i) => (
              <div key={p.name} class="so-row">
                <i>{i + 1}</i>
                <button type="button" class="so-who" onClick={() => openProfile(p.name)}><Avatar name={p.name} /><Who p={p} /></button>
                <span class="so-n"><b>{p[by]}</b><small>{by}</small></span>
                {p.name.toLowerCase() !== me && <button type="button" class="s-chipbtn" onClick={() => tradeFor(p.name)}>Trade</button>}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export function Who({ p }: { p: SocialPlayer }) {
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
              <span class="fe-t"><b>{e.who}</b> pulled <b style={{ color: TIERS[e.tier as "mythic"].color }}>{TIERS[e.tier as "mythic"].label}</b> · {BY_NUM.get(e.team)!.name}{e.serial && e.serial <= 10 ? <span class="s-bdg g">No. {e.serial}</span> : null}<time>{ago(e.at)}</time></span>
              <button type="button" class="fe-c" aria-label={`See ${BY_NUM.get(e.team)!.name}`} onClick={() => openCard(e.team!, undefined, { serial: e.serial ?? undefined, from: `${e.who}'s pull.` })}>
                <Card num={e.team} serial={e.serial ?? undefined} w="56px" />
              </button>
            </>
          ) : e.kind === "set" ? (
            <span class="fe-t">🏆 <b>{e.who}</b> finished the <b>{e.division}</b> set<time>{ago(e.at)}</time></span>
          ) : (
            <span class="fe-t">⇄ <b>{e.who}</b> traded {names(e.gave)} to <b>{e.other}</b> for {names(e.got)}<time>{ago(e.at)}</time></span>
          )}
        </div>
      ))}
    </div>
  );
}
