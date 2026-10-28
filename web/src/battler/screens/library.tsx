import { useMemo, useState } from "preact/hooks";
import { CAT, home, openSheet, useStore } from "../store";
import { Card, Empty, Head, RobotSheet, SupportCard, Tabs, TIER_ORDER, total } from "../ui";
import type { Robot } from "../types";

let tab: "robots" | "PART" | "LORE" = "robots";
let query = "";

export function Library() {
  const h = useStore(home)!;
  const [t, setT] = useState(tab);
  const [q, setQ] = useState(query);
  tab = t; query = q;
  const owned = useMemo(() => new Set(h.owned_teams), [h]);
  const needle = q.trim().toLowerCase();
  const robots = useMemo(
    () => CAT.robots.filter((r) => owned.has(r.team)).sort((a, b) => TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier) || total(b.stats) - total(a.stats)),
    [owned],
  );
  const shownRobots = needle ? robots.filter((r) => String(r.team).includes(needle) || r.name.toLowerCase().includes(needle) || r.region.toLowerCase().includes(needle)) : robots;
  const support = CAT.support.filter((c) => c.kind === t && (!needle || c.name.toLowerCase().includes(needle) || c.text.toLowerCase().includes(needle) || c.tags.some((x) => x.toLowerCase().includes(needle))));
  const show = (r: Robot) => openSheet(() => <RobotSheet r={r} />);

  return (
    <div class="b-screen">
      <Head title="Library" />
      <Tabs value={t} onChange={setT} options={[["robots", `Robots ${robots.length}`], ["PART", "Parts"], ["LORE", "Lore"]]} />
      <input class="b-input" type="search" placeholder="Search" value={q} onInput={(e) => setQ(e.currentTarget.value)} />
      {t === "robots" ? (
        shownRobots.length ? (
          <div class="b-cardgrid">
            {shownRobots.map((r) => <button key={r.team} type="button" class="b-cardbtn" onClick={() => show(r)} aria-label={`${r.team} ${r.name}`}><Card r={r} w="var(--gw)" /></button>)}
          </div>
        ) : <Empty>{robots.length ? "No robots match." : <>No robots yet. <a href="/">Open packs</a> to get some.</>}</Empty>
      ) : (
        <div class="b-supgrid">
          {support.map((c) => <SupportCard key={c.id} c={c}><span class="b-own">×{h.support_owned[c.id] ?? 0}{c.draft ? " · draft" : ""}</span></SupportCard>)}
        </div>
      )}
    </div>
  );
}
