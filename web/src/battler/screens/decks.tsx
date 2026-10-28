import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { call, explain } from "../api";
import { CAT, closeSheet, home, loadHome, openSheet, ROBOT, store, SUPPORT, toast, useStore } from "../store";
import type { Deck, DeckRow } from "../types";
import { cx, Empty, Head, Photo, RobotSheet, Spinner, Stepper, SupportCard, Tabs, Tile, total } from "../ui";

export function Decks() {
  const h = useStore(home)!;
  const [busy, setBusy] = useState(false);
  useEffect(() => { loadHome().catch(() => {}); }, []);
  const create = async () => {
    setBusy(true);
    try {
      const d = await call<DeckRow>("POST", "/api/battler/decks", { name: `Deck ${h.decks.length + 1}`, captain: null, robots: [], support: [] });
      home.set({ ...home.get()!, decks: [...home.get()!.decks, d] });
      location.hash = `#deck/${d.deck.id}`;
    } catch (e) { toast(explain(e), true); setBusy(false); }
  };
  return (
    <div class="b-screen">
      <Head title="Decks" />
      <button type="button" class="b-btn wide" onClick={create} disabled={busy}>{busy ? <Spinner small /> : "New deck"}</button>
      {h.decks.length ? <div class="b-list">{h.decks.map((d) => <DeckLine key={d.deck.id} d={d} href={`#deck/${d.deck.id}`} />)}</div>
        : <Empty>No decks yet.</Empty>}
    </div>
  );
}

export function DeckLine({ d, href, onClick, disabled }: { d: DeckRow; href?: string; onClick?: () => void; disabled?: boolean }) {
  const c = d.deck.captain ? ROBOT.get(d.deck.captain) : null;
  const body = (
    <>
      <span class={cx("b-deckcap", c && `t-${c.tier}`)}>{c ? <Photo team={c.team} has={c.photo} /> : <span>?</span>}</span>
      <span class="b-deckline-m"><b>{d.deck.name}</b><span class={d.problems.length ? "warn" : "ok"}>{d.problems.length ? d.problems[0] : "Ready"}</span></span>
      <span class="b-chev" aria-hidden="true">›</span>
    </>
  );
  return href
    ? <a class="b-deckline" href={href}>{body}</a>
    : <button type="button" class={cx("b-deckline", disabled && "off")} disabled={disabled} onClick={onClick}>{body}</button>;
}

// ---------- the editor ----------

// The deck being edited, shared by the editor and its pickers (which live in the sheet).
const editing = store<Deck | null>(null);

export function DeckEditor({ id }: { id: string }) {
  const h = useStore(home)!;
  const row = h.decks.find((x) => x.deck.id === id);
  // Set before the first paint, so the editor never shows an empty frame.
  if (row && editing.get()?.id !== id) editing.set(structuredClone(row.deck));
  const d = useStore(editing);
  const [problems, setProblems] = useState<string[]>(row?.problems ?? []);
  const [saving, setSaving] = useState<"saved" | "pending" | "saving">("saved");
  const timer = useRef(0);
  const latest = useRef<Deck | null>(null);
  const owned = useMemo(() => new Set(h.owned_teams), [h.owned_teams]);

  useEffect(() => {
    if (!row) loadHome().catch(() => {});
    return () => { flush(); editing.set(null); };
  }, [id]);

  const save = async () => {
    const deck = latest.current;
    if (!deck) return;
    latest.current = null;
    setSaving("saving");
    try {
      const r = await call<DeckRow>("PUT", `/api/battler/decks/${deck.id}`, { name: deck.name, captain: deck.captain, robots: deck.robots, support: deck.support });
      setProblems(r.problems);
      const hh = home.get()!;
      home.set({ ...hh, decks: hh.decks.map((x) => (x.deck.id === deck.id ? r : x)) });
    } catch (e) { toast(explain(e), true); }
    setSaving(latest.current ? "pending" : "saved");
  };
  const flush = () => { if (timer.current) { clearTimeout(timer.current); timer.current = 0; save(); } };
  const change = (f: (d: Deck) => void) => {
    const n = structuredClone(editing.get()!);
    f(n);
    editing.set(n);
    latest.current = n;
    setSaving("pending");
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { timer.current = 0; save(); }, 500);
  };

  if (!row) return <div class="b-screen"><Head title="Deck" back="#decks" /><Empty>That deck is gone.</Empty></div>;
  if (!d) return null;

  const rules = CAT.rules;
  const cap = d.captain ? ROBOT.get(d.captain) : null;
  const counts = new Map<string, number>();
  d.support.forEach((s) => counts.set(s, (counts.get(s) ?? 0) + 1));

  const fill = () => change((d) => {
    // Strongest owned robots for the empty slots (best total as captain), then a mix of the starter Parts and Lore.
    const best = CAT.robots.filter((r) => owned.has(r.team)).sort((a, b) => total(b.stats) - total(a.stats)).map((r) => r.team);
    d.robots = d.robots.filter((t) => owned.has(t) && t !== d.captain);
    if (!d.captain || !owned.has(d.captain)) d.captain = best.find((t) => !d.robots.includes(t)) ?? null;
    for (const t of best) if (d.robots.length < rules.deck_robots && t !== d.captain && !d.robots.includes(t)) d.robots.push(t);
    const parts = CAT.support.filter((c) => c.kind === "PART").map((c) => c.id), lore = CAT.support.filter((c) => c.kind === "LORE").map((c) => c.id);
    const count = (id: string) => d.support.filter((x) => x === id).length;
    const add = (ids: string[], full: () => boolean) => {
      for (let round = 0; round < rules.max_copies; round++)
        for (const id of ids) if (!full() && count(id) < Math.min(rules.max_copies, h.support_owned[id] ?? 0) && count(id) === round) d.support.push(id);
    };
    // About a quarter Lore (one to play most rounds), the rest Parts, as many different cards as fit.
    const loreNow = () => d.support.filter((x) => SUPPORT.get(x)?.kind === "LORE").length;
    add(lore, () => loreNow() >= 4 || d.support.length >= rules.support_cards);
    add(parts, () => d.support.length >= rules.support_cards);
  });

  const remove = async () => {
    if (!confirm(`Delete "${d.name}"?`)) return;
    clearTimeout(timer.current); timer.current = 0; latest.current = null;
    try {
      await call("DELETE", `/api/battler/decks/${d.id}`);
      const hh = home.get()!;
      home.set({ ...hh, decks: hh.decks.filter((x) => x.deck.id !== d.id) });
    } catch { /* gone already */ }
    location.hash = "#decks";
  };

  const parts = d.support.filter((s) => SUPPORT.get(s)?.kind === "PART").length;
  return (
    <div class="b-screen b-editor">
      <Head title={<input class="b-input b-deckname" maxLength={30} value={d.name} aria-label="Deck name" onInput={(e) => { const v = e.currentTarget.value; change((x) => { x.name = v; }); }} />} back="#decks">
        <span class={cx("b-savestate", saving)}>{saving === "saved" ? "Saved" : "Saving…"}</span>
      </Head>
      <div class="b-counts">
        <span class={cx(!!d.captain && "ok")}>Captain {d.captain ? 1 : 0}/1</span>
        <span class={cx(d.robots.length === rules.deck_robots && "ok")}>Robots {d.robots.length}/{rules.deck_robots}</span>
        <span class={cx(d.support.length === rules.support_cards && "ok")}>Support {d.support.length}/{rules.support_cards}</span>
      </div>
      {problems.length > 0 && saving === "saved" && (
        <div class="b-problems">
          <span>{problems[0]}{problems.length > 1 ? ` (+${problems.length - 1} more)` : ""}</span>
          <button type="button" class="b-btn small" onClick={fill}>Auto-fill</button>
        </div>
      )}

      <h2 class="b-h2">Captain</h2>
      {cap
        ? <Tile r={cap} onClick={() => openSheet(() => <RobotSheet r={cap} />)}><button type="button" class="b-link" onClick={(e) => { e.stopPropagation(); openSheet(() => <RobotPicker mode="captain" owned={owned} change={change} />); }}>Change</button>{!owned.has(cap.team) && <span class="warn">Not owned</span>}</Tile>
        : <button type="button" class="b-add" onClick={() => openSheet(() => <RobotPicker mode="captain" owned={owned} change={change} />)}>+ Captain</button>}

      <h2 class="b-h2">Robots <small>{d.robots.length}/{rules.deck_robots}</small></h2>
      <div class="b-list tight">
        {d.robots.map((t) => {
          const r = ROBOT.get(t)!;
          return <Tile key={t} r={r} onClick={() => openSheet(() => <RobotSheet r={r} />)}><button type="button" class="b-icon-x" aria-label={`Remove ${r.name}`} onClick={(e) => { e.stopPropagation(); change((x) => { x.robots = x.robots.filter((y) => y !== t); }); }}>×</button>{!owned.has(t) && <span class="warn">Not owned</span>}</Tile>;
        })}
      </div>
      {d.robots.length < rules.deck_robots && <button type="button" class="b-add" onClick={() => openSheet(() => <RobotPicker mode="robots" owned={owned} change={change} />)}>+ Robots</button>}

      <h2 class="b-h2">Support <small>{parts} Parts · {d.support.length - parts} Lore</small></h2>
      <div class="b-list tight">
        {[...counts.entries()].map(([sid, k]) => {
          const c = SUPPORT.get(sid)!;
          return (
            <div key={sid} class={cx("b-supline", c.kind === "LORE" ? "lore" : "part")}>
              <span class="b-supline-k">{c.kind === "PART" ? "P" : "L"}</span>
              <span class="b-supline-n"><b>{c.name}</b><small>{c.text}</small></span>
              <Stepper n={k} minus={() => change((x) => { x.support.splice(x.support.lastIndexOf(sid), 1); })} plus={() => change((x) => { x.support.push(sid); })} canPlus={k < Math.min(rules.max_copies, h.support_owned[sid] ?? 0) && d.support.length < rules.support_cards} />
            </div>
          );
        })}
      </div>
      {d.support.length < rules.support_cards && <button type="button" class="b-add" onClick={() => openSheet(() => <SupportPicker change={change} />, true)}>+ Parts and Lore</button>}

      <button type="button" class="b-link danger" onClick={remove}>Delete deck</button>
    </div>
  );
}

type Change = (f: (d: Deck) => void) => void;

function RobotPicker({ mode, owned, change }: { mode: "captain" | "robots"; owned: Set<number>; change: Change }) {
  const d = useStore(editing);
  const [q, setQ] = useState("");
  if (!d) return null;
  const needle = q.trim().toLowerCase();
  const list = CAT.robots.filter((r) => owned.has(r.team) && (!needle || String(r.team).includes(needle) || r.name.toLowerCase().includes(needle))).sort((a, b) => total(b.stats) - total(a.stats));
  const full = mode === "robots" && d.robots.length >= CAT.rules.deck_robots;
  const tap = (team: number) => {
    if (mode === "captain") {
      change((x) => { x.robots = x.robots.filter((y) => y !== team); x.captain = team; });
      return closeSheet();
    }
    if (d.captain === team) return;
    change((x) => {
      if (x.robots.includes(team)) x.robots = x.robots.filter((y) => y !== team);
      else if (x.robots.length < CAT.rules.deck_robots) x.robots.push(team);
    });
  };
  return (
    <div class="b-picker">
      <h2>{mode === "captain" ? "Captain" : `Robots ${d.robots.length}/${CAT.rules.deck_robots}`}</h2>
      <input class="b-input" type="search" placeholder="Search your robots" value={q} onInput={(e) => setQ(e.currentTarget.value)} />
      <div class="b-list tight">
        {list.map((r) => {
          const here = mode === "captain" ? d.captain === r.team : d.robots.includes(r.team);
          const taken = !here && (d.captain === r.team || d.robots.includes(r.team));
          return <Tile key={r.team} r={r} sel={here} off={taken || (full && !here)} onClick={() => tap(r.team)}>{here ? <span class="ok">✓</span> : taken ? <span class="b-dim b-small">{d.captain === r.team ? "Captain" : "In deck"}</span> : null}</Tile>;
        })}
        {!list.length && <Empty>No owned robots match.</Empty>}
      </div>
      {mode === "robots" && <button type="button" class="b-btn wide sticky" onClick={closeSheet}>Done</button>}
    </div>
  );
}

function SupportPicker({ change }: { change: Change }) {
  const d = useStore(editing);
  const h = useStore(home)!;
  const [kind, setKind] = useState<"PART" | "LORE">("PART");
  if (!d) return null;
  const counts = new Map<string, number>();
  d.support.forEach((s) => counts.set(s, (counts.get(s) ?? 0) + 1));
  return (
    <div class="b-picker">
      <h2>Support {d.support.length}/{CAT.rules.support_cards}</h2>
      <Tabs value={kind} onChange={setKind} options={[["PART", "Parts"], ["LORE", "Lore"]]} />
      <div class="b-supgrid">
        {CAT.support.filter((c) => c.kind === kind).map((c) => {
          const k = counts.get(c.id) ?? 0;
          const max = Math.min(CAT.rules.max_copies, h.support_owned[c.id] ?? 0);
          return (
            <SupportCard key={c.id} c={c} sel={k > 0}>
              <Stepper n={k} minus={() => change((x) => { x.support.splice(x.support.lastIndexOf(c.id), 1); })} plus={() => change((x) => { x.support.push(c.id); })} canPlus={k < max && d.support.length < CAT.rules.support_cards} />
            </SupportCard>
          );
        })}
      </div>
      <button type="button" class="b-btn wide sticky" onClick={closeSheet}>Done</button>
    </div>
  );
}
