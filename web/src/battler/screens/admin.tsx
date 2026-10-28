// Card admin: write each robot's unique effect from parts (so the rules text always matches what the game does), preview
// it in a sample round, save drafts and publish. Published effects apply to games that start afterwards.
import { useEffect, useState } from "preact/hooks";
import { call, explain } from "../api";
import { CAT, closeSheet, home, openSheet, store, toast, useStore } from "../store";
import type { Cond, Effect, FxRow, Phase, Robot, RobotScore } from "../types";
import { Empty, Head, Spinner, Tabs, Tile } from "../ui";

const OPS: [string, string][] = [["ADD_PHASE_FLAT", "+ points"], ["ADD_PHASE_PCT", "+ percent"], ["ADD_PHASE_MULTIPLIER", "× multiplier"], ["ADD_RP_PP", "+ RP chance"], ["PER_PART_TAG", "+ points per part tag"]];
const SCOPES: [string, string][] = [["SELF", "This robot"], ["ALLIES", "Its alliance"], ["ENEMIES", "Opposing robots"], ["FIELD", "All six robots"]];
const CONDS: [string, string][] = [["", "Always"], ["HAS_PART_TAG", "Has part tag"], ["STATION", "In station"], ["CAPTAIN", "Is captain"], ["LORE_ACTIVE", "Lore is active"]];
type Filter = "all" | "none" | "draft" | "published";

const rows = store<Map<number, FxRow>>(new Map());

export function Admin() {
  const h = useStore(home)!;
  const byTeam = useStore(rows);
  const [tests, setTests] = useState<Record<string, string> | null>(null);
  const [err, setErr] = useState("");
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  useEffect(() => {
    if (!h.is_admin) return;
    call<{ effects: FxRow[]; test_effects: Record<string, string> }>("GET", "/api/battler/admin/effects").then(
      (d) => { rows.set(new Map(d.effects.map((f) => [f.team, f]))); setTests(d.test_effects); },
      (e) => setErr(explain(e)),
    );
  }, []);
  if (!h.is_admin) return <div class="b-screen"><Head title="Card admin" /><Empty>Admins only.</Empty></div>;
  if (err) return <div class="b-screen"><Head title="Card admin" /><Empty>{err}</Empty></div>;
  if (!tests) return <div class="b-screen"><Head title="Card admin" /><div class="b-center small"><Spinner /></div></div>;

  const needle = q.trim().toLowerCase();
  const list = CAT.robots
    .filter((r) => !needle || String(r.team).includes(needle) || r.name.toLowerCase().includes(needle))
    .filter((r) => {
      const f = byTeam.get(r.team);
      return filter === "all" || (filter === "none" && !f?.published.length) || (filter === "published" && !!f?.published.length) || (filter === "draft" && !!f?.draft.length && JSON.stringify(f.draft) !== JSON.stringify(f.published));
    })
    .slice(0, 150);
  const done = [...byTeam.values()].filter((f) => f.published.length).length;
  return (
    <div class="b-screen">
      <Head title="Card admin"><span class="b-dim b-small">{done}/{CAT.robots.length} published</span></Head>
      <input class="b-input" type="search" placeholder="Search team or name" value={q} onInput={(e) => setQ(e.currentTarget.value)} />
      <Tabs value={filter} onChange={setFilter} options={[["all", "All"], ["none", "No effect"], ["draft", "Draft"], ["published", "Published"]]} />
      <div class="b-list tight">
        {list.map((r) => {
          const f = byTeam.get(r.team);
          return (
            <Tile key={r.team} r={r} onClick={() => openSheet(() => <Editor r={r} />, true)}>
              {f?.published.length ? <span class="ok b-small">r{f.rev}</span> : f?.draft.length ? <span class="warn b-small">Draft</span> : tests[r.team] ? <span class="b-dim b-small">Test</span> : null}
            </Tile>
          );
        })}
      </div>
    </div>
  );
}

const allTags = () => CAT.tags.flatMap(([b, subs]) => [b, ...subs]);

function Sel({ k, value, options }: { k: string; value: string | undefined; options: ([string, string] | string)[] }) {
  return (
    <select data-k={k} value={value ?? ""}>
      {options.map((o) => { const [v, l] = Array.isArray(o) ? o : [o, o]; return <option value={v}>{l}</option>; })}
    </select>
  );
}

interface Preview { valid: boolean; error: string | null; text: string; with: { totals: [number, number]; robots: RobotScore[] }; without: { totals: [number, number]; robots: RobotScore[] } }

function Editor({ r }: { r: Robot }) {
  const f = rows.get().get(r.team);
  const [fx, setFx] = useState<Effect[]>(() => {
    const start: Effect[] = structuredClone(f?.draft?.length ? f.draft : f?.published ?? []);
    return start.length ? start : [{ op: "ADD_PHASE_FLAT", phase: "TELE", value: 5, scope: "SELF" }];
  });
  const [station, setStation] = useState(1);
  const [captain, setCaptain] = useState(false);
  const [part, setPart] = useState("");
  const [pv, setPv] = useState<Preview | string | null>(null);

  useEffect(() => {
    let live = true;
    call<Preview>("POST", "/api/battler/admin/preview", { team: r.team, effects: fx, station, captain, seed: 7, parts: part ? [part, part] : [] })
      .then((out) => { if (live) setPv(out); }, (e) => { if (live) setPv(explain(e)); });
    return () => { live = false; };
  }, [JSON.stringify(fx), station, captain, part]);

  const edit = (i: number, k: string, v: string) => {
    const n = structuredClone(fx);
    const e = n[i];
    const num = v === "" ? undefined : +v;
    switch (k) {
      case "op":
        e.op = v;
        if (v === "ADD_RP_PP") { e.rp = e.rp ?? "STATION"; delete e.phase; } else { e.phase = e.phase ?? "TELE"; delete e.rp; }
        if (v === "ADD_PHASE_MULTIPLIER") { e.percent = e.percent ?? 200; delete e.value; } else { e.value = e.value ?? 5; delete e.percent; }
        if (v === "PER_PART_TAG") e.tag = e.tag ?? "MECHANICAL"; else delete e.tag;
        break;
      case "phase": e.phase = v as Phase; break;
      case "rp": e.rp = v; break;
      case "tag": e.tag = v; break;
      case "value": e.value = num ?? 0; break;
      case "percent": e.percent = num ?? 200; break;
      case "scope": e.scope = v; break;
      case "chance": if (num && num > 0) e.chance = num; else delete e.chance; break;
      case "if":
        if (v) e.when = [{ if: v as Cond["if"], ...(v === "HAS_PART_TAG" ? { tag: "MECHANICAL", min: 1 } : v === "STATION" ? { station: 1 } : v === "CAPTAIN" ? { is: true } : {}) }];
        else delete e.when;
        break;
      case "ctag": e.when![0].tag = v; break;
      case "cmin": e.when![0].min = num ?? 1; break;
      case "cst": e.when![0].station = +v; break;
      case "cis": e.when![0].is = v === "true"; break;
      case "cof": e.when![0].of = v as "TARGET" | "SOURCE"; break;
    }
    setFx(n);
  };

  const save = async (publish: boolean) => {
    if (publish && !confirm(`Publish this effect for ${r.team} ${r.name}? Games that start from now on use it.`)) return;
    try {
      const out = await call<FxRow>("PUT", `/api/battler/admin/effects/${r.team}`, { effects: fx, publish });
      const m = new Map(rows.get());
      m.set(r.team, { ...(f ?? { team: r.team, draft: [], published: [], rev: 0, author: "", updated: 0, draft_text: "", published_text: "" }), ...out });
      rows.set(m);
      toast(publish ? "Published." : "Draft saved.");
      if (publish) closeSheet();
    } catch (e) { toast(explain(e), true); }
  };

  const p = typeof pv === "object" ? pv : null;
  const w = p?.with.robots.find((x) => x.inst === 1), wo = p?.without.robots.find((x) => x.inst === 1);
  return (
    <div class="b-fxed">
      <h2>{r.team} {r.name}</h2>
      <p class="b-dim b-small">{f?.published.length ? `Published r${f.rev}: ${f.published_text}` : "Nothing published yet."}</p>
      {fx.map((e, i) => {
        const c = e.when?.[0];
        return (
          <div class="b-fxrow" key={i} onChange={(ev) => { const t = ev.target as HTMLSelectElement; if (t.dataset.k) edit(i, t.dataset.k, t.value); }}>
            <div class="b-fxgrid">
              <label>Does<Sel k="op" value={e.op} options={OPS} /></label>
              {e.op === "ADD_RP_PP"
                ? <label>RP<Sel k="rp" value={e.rp} options={[["RP1", `RP1 ${CAT.rp_names[0]}`], ["RP2", `RP2 ${CAT.rp_names[1]}`], ["RP3", `RP3 ${CAT.rp_names[2]}`], ["STATION", "Its station's"]]} /></label>
                : <label>Phase<Sel k="phase" value={e.phase} options={["AUTO", "TELE", "END", "ALL"]} /></label>}
              {e.op === "PER_PART_TAG" && <label>Tag<Sel k="tag" value={e.tag} options={allTags()} /></label>}
              {e.op === "ADD_PHASE_MULTIPLIER"
                ? <label>Percent<input type="number" data-k="percent" min={110} max={400} step={10} value={e.percent ?? 200} /></label>
                : <label>Amount<input type="number" data-k="value" min={-100} max={300} value={e.value ?? 5} /></label>}
              <label>Who<Sel k="scope" value={e.scope} options={SCOPES} /></label>
              <label>Chance %<input type="number" data-k="chance" min={0} max={99} placeholder="always" value={e.chance ?? ""} /></label>
              <label>Only if<Sel k="if" value={c?.if} options={CONDS} /></label>
              {c?.if === "HAS_PART_TAG" && <><label>Tag<Sel k="ctag" value={c.tag} options={allTags()} /></label><label>At least<input type="number" data-k="cmin" min={1} max={6} value={c.min ?? 1} /></label></>}
              {c?.if === "STATION" && <label>Station<Sel k="cst" value={String(c.station ?? 1)} options={["1", "2", "3"]} /></label>}
              {c?.if === "CAPTAIN" && <label>Captain?<Sel k="cis" value={String(c.is ?? true)} options={[["true", "is captain"], ["false", "isn't captain"]]} /></label>}
              {c && c.if !== "LORE_ACTIVE" && <label>Checked on<Sel k="cof" value={c.of ?? "TARGET"} options={[["TARGET", "the robot affected"], ["SOURCE", "this robot"]]} /></label>}
            </div>
            {fx.length > 1 && <button type="button" class="b-link" onClick={() => setFx(fx.filter((_, j) => j !== i))}>Remove</button>}
          </div>
        );
      })}
      {fx.length < 3 && <button type="button" class="b-add" onClick={() => setFx([...fx, { op: "ADD_PHASE_FLAT", phase: "AUTO", value: 5, scope: "SELF" }])}>+ Another effect</button>}
      <div class="b-fxprev">
        <small>RULES TEXT</small>
        {typeof pv === "string" ? <span class="warn">{pv}</span> : p ? (p.valid ? <b>{p.text}</b> : <span class="warn">{p.error}</span>) : <Spinner small />}
        {p?.valid && w && wo && <span class="b-dim b-small">Sample round: scores {w.points.join(" / ")} (without: {wo.points.join(" / ")}), RP chance {w.rp_chance}% (was {wo.rp_chance}%). Alliance {p.with.totals[0]} vs {p.with.totals[1]} (was {p.without.totals[0]}).</span>}
        <div class="b-fxopts">
          <label>Station <select value={String(station)} onChange={(e) => setStation(+e.currentTarget.value)}><option>1</option><option>2</option><option>3</option></select></label>
          <label><input type="checkbox" checked={captain} onChange={(e) => setCaptain(e.currentTarget.checked)} /> Captain</label>
          <label>Parts <select value={part} onChange={(e) => setPart(e.currentTarget.value)}><option value="">none</option>{CAT.support.filter((c) => c.kind === "PART").map((c) => <option value={c.id}>{c.name}</option>)}</select></label>
        </div>
      </div>
      <div class="b-row2">
        <button type="button" class="b-btn ghost" onClick={() => save(false)}>Save draft</button>
        <button type="button" class="b-btn" disabled={!p?.valid} onClick={() => save(true)}>Publish</button>
      </div>
    </div>
  );
}

