// The Battler: build a deck from the robots you own in FRC Packs and play 1v1, five-round games. The server runs every
// rule (server/src/battler); this page shows what it says and sends what you tap. Screens are hash routes:
// #home, #library, #decks, #deck/<id>, #play, #game/<id>, #history, #admin.
import "./style.css";
import "./battle.css";

// ---------- types (mirror server/src/battler) ----------

type Phase = "AUTO" | "TELE" | "END" | "ALL";
interface Stats { auto: number; tele: number; end: number; rp: [number, number, number] }
interface RobotCard {
  team: number; name: string; region: string; tier: string; photo: boolean; stats: Stats;
  test_stats: boolean; effect_text: string; effect_test: boolean;
}
interface Robot extends RobotCard { id: string; season: number }
interface Support { id: string; kind: "PART" | "LORE"; name: string; season: number; tags: string[]; text: string; flavor: string; draft: boolean }
interface Rules { rounds: number; deck_robots: number; support_cards: number; draw: number; max_copies: number; pit_seconds: number; results_seconds: number; strikes: number; start_elo: number }
interface Catalog { season: number; rp_names: [string, string, string]; rules: Rules; robots: Robot[]; support: Support[]; tags: [string, string[]][] }
interface Deck { id: string; name: string; captain: number | null; robots: number[]; support: string[]; updated: number }
interface DeckRow { deck: Deck; problems: string[] }
interface Profile { elo: number; games: number; wins: number; losses: number; draws: number }
interface Home { name: string; is_admin: boolean; profile: Profile; active: string | null; owned_teams: number[]; support_owned: Record<string, number>; decks: DeckRow[] }

interface RobotInst extends RobotCard { inst: number; card: string; from: number }
interface SupportInst { inst: number; owner: number; card: string; kind: "PART" | "LORE"; name: string; tags: string[]; text: string }
interface Plan { attach: [number, number][]; lore: number | null; stations: [number, number, number] }
interface SeatView { name: string; elo: number; picked: boolean; locked: boolean; acked: boolean; rp: number; points: number; hand_count: number; pile_count: number; strikes: number }
interface RobotScore { inst: number; side: number; station: number; base: [number, number, number]; points: [number, number, number]; rp_chance: number; rp_roll: number; rp_hit: boolean }
interface GameEvent { source: string; target: number; text: string }
interface RoundResult { robots: RobotScore[]; phase_totals: [[number, number, number], [number, number, number]]; totals: [number, number]; winner: number | null; match_rp: [number, number]; bonus_rp: [number, number]; events: GameEvent[] }
interface RoundLog { round: number; stations: [[number, number, number], [number, number, number]]; attach: [[number, number][], [number, number][]]; lore: [number | null, number | null]; result: RoundResult; auto_locked: [boolean, boolean] }
interface Outcome { winner: number | null; reason: string; rp: [number, number]; points: [number, number]; elo_before: [number, number]; elo_after: [number, number] }
type Status = "OPEN" | "DECKS" | "PIT" | "RESULTS" | "FINAL" | "CANCELLED";
interface GameView {
  id: string; rev: number; status: Status; round: number; rounds_total: number; deadline: number;
  seats: (SeatView | null)[]; me: { side: number; hand: number[]; plan: Plan; deck_robots: number[] } | null;
  alliances: [[number, number, number], [number, number, number]]; pool_left: number;
  robots: RobotInst[]; support: SupportInst[]; rounds: RoundLog[]; seed_hash: string; seed: string | null; outcome: Outcome | null;
}
interface HistoryRow { game: string; opponent: string; winner: boolean | null; reason: string; rp: [number, number]; points: [number, number]; elo_before: number; elo_after: number; at: number }

// ---------- small helpers ----------

const $ = <T extends HTMLElement = HTMLElement>(s: string, root: ParentNode = document) => root.querySelector<T>(s);
const main = document.getElementById("main")!;
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;
const TIER_ORDER = ["mythic", "legendary", "rare", "uncommon", "common"];
const STARS: Record<string, number> = { common: 1, uncommon: 2, rare: 3, legendary: 4, mythic: 5 };
const total = (s: Stats) => s.auto + s.tele + s.end;

class ApiError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
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
  offline: "Can't reach the server. Check your connection.",
  stale: "The game moved on. Showing the latest.",
  in_game: "You're already in a game. Finish it first.",
  game_full: "Someone else joined that game first.",
  own_game: "That's your own game.",
  deck_not_ready: "That deck isn't ready to play.",
  not_in_hand: "That card isn't in your hand.",
  not_your_robot: "Parts go on your own robots.",
  bad_stations: "Each robot needs its own station.",
  locked: "You've already locked this round.",
  too_many_decks: "You have the most decks allowed. Delete one first.",
  bad_name: "Give the deck a name (up to 30 letters).",
  no_session: "Sign in to FRC Packs first.",
  bad_effect: "That effect isn't valid.",
  busy: "Busy, try again.",
};
const explain = (e: unknown) => (e instanceof ApiError ? MESSAGES[e.code] ?? `Something went wrong (${e.code}).` : "Something went wrong.");

let toastTimer = 0;
function toast(text: string, bad = false) {
  const t = $("#toast")!;
  t.textContent = text;
  t.classList.toggle("bad", bad);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.hidden = true), 2800);
}

// ---------- data ----------

let CAT: Catalog;
let HOME: Home;
const ROBOT = new Map<number, Robot>();
const SUPPORT = new Map<string, Support>();

async function loadHome() {
  HOME = await call<Home>("GET", "/api/battler/home");
  const e = $("#elo")!;
  e.hidden = false;
  e.innerHTML = `<b>${HOME.profile.elo}</b> Elo`;
}

// ---------- card art ----------

function starScale(tier: string) {
  let s = "";
  for (let i = 0; i < 5; i++) s += i < (STARS[tier] ?? 1) ? "★" : "<i>★</i>";
  return s;
}

function nameScale(n: string) {
  const l = n.length;
  return l <= 12 ? 1 : l <= 15 ? 0.85 : l <= 19 ? 0.7 : l <= 24 ? 0.58 : 0.5;
}

/** The full robot card, the same art as the pack cards. */
function robotCard(r: RobotCard, cw = 260, extra = "") {
  const s = r.stats;
  const pic = r.photo
    ? `<span class="phw"><img class="ph" alt="" draggable="false" decoding="async" loading="lazy" src="/photos/${r.team}.webp"></span>`
    : `<span class="bt-nophoto">#${r.team}</span>`;
  const effect = r.effect_text
    ? `<p>${esc(r.effect_text)}</p>${r.effect_test ? '<em class="bt-flag">Test effect</em>' : ""}`
    : '<p class="tbd">No effect yet</p>';
  return `<div class="slot flipped bt-cardslot ${extra}" style="--cw:${cw}px;--tc:#fff"><div class="float"><div class="tilt rest"><div class="flip card" data-tier="${esc(r.tier)}">
    <div class="face front btf"><div class="inner v2 bt b2" style="--nl:${nameScale(r.name)}">
      <div class="head"><span class="avatar none">${r.team}</span><span class="tname">${esc(r.name)}</span></div>
      <div class="fwrap"><div class="fphoto">${pic}${r.test_stats ? '<span class="bt-teststats">Test stats</span>' : ""}</div>
        <div class="idbar"><span class="num">#${r.team}</span><span class="loc">${esc(r.region)}</span><span class="yr">${CAT?.season ?? 2026}</span></div></div>
      <div class="statrow"><div class="stat"><small>AUTO</small><b>${s.auto}</b></div><div class="stat"><small>TELE</small><b>${s.tele}</b></div><div class="stat"><small>END</small><b>${s.end}</b></div></div>
      <div class="rprow">${s.rp.map((p, i) => `<div class="rp"><i>RP${i + 1}</i><b>${p}%</b></div>`).join("")}</div>
      <div class="effect"><small>UNIQUE EFFECT</small>${effect}</div>
    </div><div class="ftb"><span class="rar" aria-label="${STARS[r.tier] ?? 1} of 5 stars">${starScale(r.tier)}</span><span class="sn">${esc(r.tier.toUpperCase())}</span></div></div>
  </div></div></div></div>`;
}

/** A compact robot tile: lists, deck builder, the field. */
function robotTile(r: RobotCard, attrs = "", extra = "", cls = "") {
  const s = r.stats;
  return `<div class="bt-tile t-${esc(r.tier)} ${cls}" ${attrs}>
    <div class="bt-tile-l">${r.photo ? `<img alt="" loading="lazy" src="/photos/${r.team}.webp">` : `<span>#${r.team}</span>`}</div>
    <div class="bt-tile-m">
      <div class="bt-tile-name"><b>${r.team}</b> ${esc(r.name)}</div>
      <div class="bt-tile-stats"><span>A <b>${s.auto}</b></span><span>T <b>${s.tele}</b></span><span>E <b>${s.end}</b></span><span class="bt-dim">RP ${s.rp.join("/")}</span></div>
      ${extra}
    </div>
  </div>`;
}

function supportCard(c: { kind: "PART" | "LORE"; name: string; tags: string[]; text: string }, attrs = "", extra = "", cls = "") {
  const tags = c.kind === "PART" ? c.tags.map((t, i) => `<span class="bt-tag${i ? " sub" : ""}">${esc(t.replace("_", " "))}</span>`).join("") : '<span class="bt-tag lore">FIELD · 1 ROUND</span>';
  return `<div class="bt-sup k-${c.kind.toLowerCase()} ${cls}" ${attrs}>
    <div class="bt-sup-k">${c.kind === "PART" ? "PART" : "LORE"}</div>
    <div class="bt-sup-n">${esc(c.name)}</div>
    <div class="bt-sup-tags">${tags}</div>
    <div class="bt-sup-t">${esc(c.text)}</div>${extra}
  </div>`;
}

// ---------- sheet (bottom drawer) ----------

function openSheet(html: string, onClick?: (el: HTMLElement, e: MouseEvent) => void) {
  const sh = $("#sheet")!, inner = $("#sheetIn")!;
  inner.innerHTML = `<button type="button" class="bt-x" data-close aria-label="Close">×</button>${html}`;
  sh.hidden = false;
  document.body.classList.add("bt-noscroll");
  sh.onclick = (e) => {
    const t = e.target as HTMLElement;
    if (t === sh || t.closest("[data-close]")) return closeSheet();
    if (onClick) onClick(t, e);
  };
}
function closeSheet() {
  $("#sheet")!.hidden = true;
  document.body.classList.remove("bt-noscroll");
}
addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#sheet")!.hidden) closeSheet(); });

function showRobot(r: RobotCard) {
  const names = CAT.rp_names;
  openSheet(`<div class="bt-detail">${robotCard(r, Math.min(300, innerWidth - 64))}
    <dl class="bt-dl">
      <dt>Region</dt><dd>${esc(r.region || "Unknown")}</dd>
      <dt>RP slots</dt><dd>RP1 ${names[0]} · RP2 ${names[1]} · RP3 ${names[2]}</dd>
      <dt>Stats</dt><dd>${r.test_stats ? "Test stats until the Statbotics import runs" : "From Statbotics (normalized season EPA)"}</dd>
      <dt>Effect</dt><dd>${r.effect_text ? esc(r.effect_text) + (r.effect_test ? " (test example)" : "") : "None yet: an admin writes each robot's effect."}</dd>
    </dl></div>`);
}

// ---------- router ----------

let leave: (() => void) | null = null;
function go(hash: string) {
  if (location.hash === hash) route();
  else location.hash = hash;
}
addEventListener("hashchange", route);

async function route() {
  if (leave) { leave(); leave = null; }
  closeSheet();
  main.onclick = null;
  const [name, arg] = (location.hash.slice(1) || "home").split("/");
  document.body.dataset.screen = name;
  try {
    switch (name) {
      case "library": return renderLibrary();
      case "decks": return renderDecks();
      case "deck": return renderDeckEditor(arg);
      case "play": return renderLobby();
      case "game": return renderGame(arg);
      case "history": return renderHistory();
      case "admin": return renderAdmin();
      default: return renderHome();
    }
  } catch (e) {
    main.innerHTML = `<div class="bt-panel"><p>${esc(explain(e))}</p><button class="cta small" data-go="#home">Home</button></div>`;
  }
}

main.addEventListener("click", (e) => {
  const t = (e.target as HTMLElement).closest<HTMLElement>("[data-go]");
  if (t) { e.preventDefault(); go(t.dataset.go!); }
});

// ---------- home ----------

async function renderHome() {
  await loadHome();
  const p = HOME.profile;
  const ready = HOME.decks.filter((d) => !d.problems.length).length;
  main.innerHTML = `
    ${HOME.active ? `<button class="bt-resume" data-go="#game/${HOME.active}"><b>Game in progress</b><span>Tap to rejoin</span></button>` : ""}
    <section class="bt-hello">
      <h1>Hi ${esc(HOME.name)}</h1>
      <div class="bt-record"><span><b>${p.elo}</b>Elo</span><span><b>${p.wins}</b>Wins</span><span><b>${p.losses}</b>Losses</span><span><b>${p.draws}</b>Draws</span></div>
    </section>
    <nav class="bt-menu">
      <button class="bt-big play" data-go="#play"><b>Play</b><span>${ready ? "Find or host a 1v1 game" : "Build a deck first"}</span></button>
      <button class="bt-big" data-go="#decks"><b>Deck Builder</b><span>${plural(HOME.decks.length, "deck")}, ${ready} ready</span></button>
      <button class="bt-big" data-go="#library"><b>Library</b><span>${plural(HOME.owned_teams.length, "robot")} you own, ${CAT.support.length} support cards</span></button>
      <button class="bt-big" data-go="#history"><b>Match history</b><span>${plural(p.games, "game")} played</span></button>
      ${HOME.is_admin ? '<button class="bt-big admin" data-go="#admin"><b>Card admin</b><span>Write and publish robot effects</span></button>' : ""}
    </nav>
    <details class="bt-rules"><summary>How to play</summary>
      <ol>
        <li>A deck is <b>1 Alliance Captain + 10 robots + 15 Part or Lore cards</b>, all from your collection.</li>
        <li>Both players' 10 robots are shuffled into one shared Alliance Deck. Each of the <b>5 rounds</b> you field your Captain plus two robots dealt from it (they can be your opponent's!).</li>
        <li>Each round you draw <b>3 support cards</b>. In the Pit, attach Parts to your robots, play at most <b>one Lore</b> (it hits all six robots), and put your robots in Driver Stations 1–3.</li>
        <li>Lock in. Auto, Tele and End are scored. Winning the round is <b>3 RP</b> (a tie is 1 each), and each robot rolls once for <b>+1 RP</b> at its station's RP chance.</li>
        <li>Most RP after five rounds wins (then most points). Your Elo changes once per game.</li>
      </ol>
      <p class="bt-dim">Cards you play are only used up for that game. Nothing leaves your FRC Packs collection.</p>
    </details>`;
}

// ---------- library ----------

let libTab: "robots" | "PART" | "LORE" = "robots";
let libQuery = "";
async function renderLibrary() {
  if (!HOME) await loadHome();
  const owned = new Set(HOME.owned_teams);
  const draw = () => {
    const q = libQuery.trim().toLowerCase();
    let body = "";
    if (libTab === "robots") {
      const list = CAT.robots
        .filter((r) => owned.has(r.team))
        .filter((r) => !q || String(r.team).includes(q) || r.name.toLowerCase().includes(q) || r.region.toLowerCase().includes(q))
        .sort((a, b) => TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier) || total(b.stats) - total(a.stats));
      body = list.length
        ? `<div class="bt-cardgrid">${list.map((r) => `<button class="bt-cardbtn" data-team="${r.team}" aria-label="${esc(r.name)}">${robotCard(r, 168)}</button>`).join("")}</div>`
        : `<div class="bt-empty">${owned.size ? "No robots match." : 'You don\'t own any robots yet. <a href="/">Open packs in FRC Packs</a> to get some.'}</div>`;
    } else {
      const list = CAT.support.filter((c) => c.kind === libTab).filter((c) => !q || c.name.toLowerCase().includes(q) || c.tags.some((t) => t.toLowerCase().includes(q)) || c.text.toLowerCase().includes(q));
      body = `<div class="bt-supgrid">${list.map((c) => supportCard(c, "", `<div class="bt-own">×${HOME.support_owned[c.id] ?? 0} owned${c.draft ? " · draft" : ""}</div>${c.flavor ? `<div class="bt-flavor">${esc(c.flavor)}</div>` : ""}`)).join("")}</div>`;
    }
    $("#libBody")!.innerHTML = body;
  };
  main.innerHTML = `
    <div class="bt-head"><button class="bt-back" data-go="#home" aria-label="Back">‹</button><h2>Library</h2></div>
    <div class="seg bt-seg" role="tablist">
      <button role="tab" data-tab="robots" aria-selected="${libTab === "robots"}">Robots</button>
      <button role="tab" data-tab="PART" aria-selected="${libTab === "PART"}">Parts</button>
      <button role="tab" data-tab="LORE" aria-selected="${libTab === "LORE"}">Lore</button>
    </div>
    <input class="input bt-search" id="libQ" type="search" placeholder="Search team, name, region, tag…" value="${esc(libQuery)}">
    <p class="bt-note">Support cards are a free starter set for now (${3} of each). Robots come from your FRC Packs collection.</p>
    <div id="libBody"></div>`;
  draw();
  $<HTMLInputElement>("#libQ")!.oninput = (e) => { libQuery = (e.target as HTMLInputElement).value; draw(); };
  main.querySelectorAll<HTMLElement>("[data-tab]").forEach((b) => (b.onclick = () => { libTab = b.dataset.tab as typeof libTab; renderLibrary(); }));
  $("#libBody")!.onclick = (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-team]");
    if (b) showRobot(ROBOT.get(+b.dataset.team!)!);
  };
}

// ---------- decks ----------

async function renderDecks() {
  await loadHome();
  main.innerHTML = `
    <div class="bt-head"><button class="bt-back" data-go="#home" aria-label="Back">‹</button><h2>Deck Builder</h2></div>
    <button class="cta wide" id="newDeck">New deck</button>
    <div class="bt-decklist">${HOME.decks.length ? HOME.decks.map(deckRow).join("") : '<div class="bt-empty">No decks yet. A deck is 1 Captain, 10 robots and 15 Part or Lore cards.</div>'}</div>`;
  $("#newDeck")!.onclick = async () => {
    try {
      const d = await call<DeckRow>("POST", "/api/battler/decks", { name: `Deck ${HOME.decks.length + 1}`, captain: null, robots: [], support: [] });
      go(`#deck/${d.deck.id}`);
    } catch (e) { toast(explain(e), true); }
  };
}

function deckRow(d: DeckRow) {
  const c = d.deck.captain ? ROBOT.get(d.deck.captain) : null;
  return `<button class="bt-deckrow" data-go="#deck/${d.deck.id}">
    <div class="bt-deckrow-cap t-${c ? esc(c.tier) : "none"}">${c?.photo ? `<img alt="" src="/photos/${c.team}.webp">` : `<span>${c ? c.team : "?"}</span>`}</div>
    <div><b>${esc(d.deck.name)}</b><span>${c ? `Captain ${c.team} ${esc(c.name)}` : "No captain yet"}</span>
    <span class="${d.problems.length ? "warn" : "ok"}">${d.problems.length ? esc(d.problems[0]) : "Ready to play"}</span></div>
  </button>`;
}

async function renderDeckEditor(id: string) {
  if (!HOME || !HOME.decks.some((d) => d.deck.id === id)) await loadHome();
  const row = HOME.decks.find((d) => d.deck.id === id);
  if (!row) { main.innerHTML = '<div class="bt-empty">That deck is gone. <a href="#decks">Back to decks</a></div>'; return; }
  const d: Deck = JSON.parse(JSON.stringify(row.deck));
  let problems = row.problems;
  let dirty = false;
  const owned = new Set(HOME.owned_teams);

  const draw = () => {
    const parts = d.support.filter((s) => SUPPORT.get(s)?.kind === "PART").length;
    const cap = d.captain ? ROBOT.get(d.captain) : null;
    const counts = new Map<string, number>();
    d.support.forEach((s) => counts.set(s, (counts.get(s) ?? 0) + 1));
    main.innerHTML = `
      <div class="bt-head"><button class="bt-back" id="deckBack" aria-label="Back">‹</button><input class="input bt-deckname" id="deckName" maxlength="30" value="${esc(d.name)}" aria-label="Deck name"></div>
      <div class="bt-counts">
        <span class="${d.captain ? "ok" : ""}">Captain ${d.captain ? 1 : 0}/1</span>
        <span class="${d.robots.length === CAT.rules.deck_robots ? "ok" : ""}">Robots ${d.robots.length}/${CAT.rules.deck_robots}</span>
        <span class="${d.support.length === CAT.rules.support_cards ? "ok" : ""}">Support ${d.support.length}/${CAT.rules.support_cards} <small>Parts ${parts} / Lore ${d.support.length - parts}</small></span>
      </div>
      ${problems.length ? `<ul class="bt-problems">${problems.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>` : '<p class="bt-readyline">Ready to play.</p>'}
      <h3 class="bt-h3">Alliance Captain <small>plays all five rounds</small></h3>
      ${cap ? robotTile(cap, `data-show="${cap.team}"`, `<div class="bt-tile-act"><button class="textbtn" data-pick="captain">Change</button>${owned.has(cap.team) ? "" : '<span class="warn">Not owned</span>'}</div>`) : '<button class="bt-addslot" data-pick="captain">+ Pick a captain</button>'}
      <h3 class="bt-h3">Robots <small>${d.robots.length}/${CAT.rules.deck_robots}, shuffled into the shared Alliance Deck</small></h3>
      <div class="bt-tiles">${d.robots.map((t) => { const r = ROBOT.get(t)!; return robotTile(r, `data-show="${t}"`, `<div class="bt-tile-act"><button class="textbtn" data-remove-robot="${t}">Remove</button>${owned.has(t) ? "" : '<span class="warn">Not owned</span>'}</div>`); }).join("")}</div>
      ${d.robots.length < CAT.rules.deck_robots ? '<button class="bt-addslot" data-pick="robots">+ Add robots</button>' : ""}
      <h3 class="bt-h3">Support <small>${d.support.length}/${CAT.rules.support_cards}, any mix of Part and Lore, up to ${CAT.rules.max_copies} copies each</small></h3>
      <div class="bt-suplist">${[...counts.entries()].map(([sid, k]) => { const c = SUPPORT.get(sid)!; return `<div class="bt-supline k-${c.kind.toLowerCase()}"><span class="bt-supline-k">${c.kind === "PART" ? "P" : "L"}</span><span class="bt-supline-n"><b>${esc(c.name)}</b><small>${esc(c.text)}</small></span><span class="bt-stepper"><button data-sup-minus="${sid}" aria-label="One fewer">−</button><b>${k}</b><button data-sup-plus="${sid}" aria-label="One more" ${k >= CAT.rules.max_copies || d.support.length >= CAT.rules.support_cards ? "disabled" : ""}>+</button></span></div>`; }).join("")}</div>
      ${d.support.length < CAT.rules.support_cards ? '<button class="bt-addslot" data-pick="support">+ Add Part and Lore cards</button>' : ""}
      <div class="bt-savebar">
        <button class="cta small ghost" id="deckDelete">Delete</button>
        <button class="cta small" id="deckSave">${dirty ? "Save" : "Saved"}</button>
      </div>`;
    bind();
  };

  const save = async (quiet = false) => {
    try {
      const r = await call<DeckRow>("PUT", `/api/battler/decks/${d.id}`, { name: d.name, captain: d.captain, robots: d.robots, support: d.support });
      problems = r.problems;
      dirty = false;
      const i = HOME.decks.findIndex((x) => x.deck.id === d.id);
      if (i >= 0) HOME.decks[i] = r;
      if (!quiet) toast(r.problems.length ? "Saved (not ready yet)" : "Saved. Ready to play!");
      if (location.hash === `#deck/${d.id}`) draw(); // a save on the way out mustn't paint over the next screen
    } catch (e) { toast(explain(e), true); }
  };
  const change = () => { dirty = true; draw(); };

  const bind = () => {
    $<HTMLInputElement>("#deckName")!.onchange = (e) => { d.name = (e.target as HTMLInputElement).value; dirty = true; save(true); };
    $("#deckBack")!.onclick = async () => { if (dirty) await save(true); go("#decks"); };
    $("#deckSave")!.onclick = () => save();
    $("#deckDelete")!.onclick = async () => {
      if (!confirm(`Delete "${d.name}"?`)) return;
      await call("DELETE", `/api/battler/decks/${d.id}`).catch(() => {});
      go("#decks");
    };
    main.onclick = (e) => {
      const t = e.target as HTMLElement;
      const rm = t.closest<HTMLElement>("[data-remove-robot]");
      if (rm) { d.robots = d.robots.filter((x) => x !== +rm.dataset.removeRobot!); return change(); }
      const plus = t.closest<HTMLElement>("[data-sup-plus]");
      if (plus) { d.support.push(plus.dataset.supPlus!); return change(); }
      const minus = t.closest<HTMLElement>("[data-sup-minus]");
      if (minus) { const i = d.support.lastIndexOf(minus.dataset.supMinus!); if (i >= 0) d.support.splice(i, 1); return change(); }
      const pick = t.closest<HTMLElement>("[data-pick]");
      if (pick) return pick.dataset.pick === "support" ? pickSupport() : pickRobots(pick.dataset.pick as "captain" | "robots");
      const show = t.closest<HTMLElement>("[data-show]");
      if (show && !t.closest("button")) showRobot(ROBOT.get(+show.dataset.show!)!);
    };
  };

  const pickRobots = (mode: "captain" | "robots") => {
    let q = "";
    const drawPicker = () => {
      const inDeck = new Set([d.captain, ...d.robots]);
      const list = CAT.robots
        .filter((r) => owned.has(r.team))
        .filter((r) => !q || String(r.team).includes(q) || r.name.toLowerCase().includes(q))
        .sort((a, b) => total(b.stats) - total(a.stats));
      const full = mode === "robots" && d.robots.length >= CAT.rules.deck_robots;
      $("#pickList")!.innerHTML = list.length
        ? list.map((r) => {
            const here = mode === "captain" ? d.captain === r.team : d.robots.includes(r.team);
            const taken = inDeck.has(r.team) && !here;
            return robotTile(r, `data-pick-team="${r.team}"`, `<div class="bt-tile-act">${here ? '<span class="ok">In deck ✓</span>' : taken ? '<span class="bt-dim">Already in deck</span>' : ""}</div>`, `${here ? "sel" : ""} ${taken || (full && !here) ? "off" : ""}`);
          }).join("")
        : '<div class="bt-empty">No owned robots match.</div>';
      $("#pickHead")!.textContent = mode === "captain" ? "Pick your Alliance Captain" : `Robots ${d.robots.length}/${CAT.rules.deck_robots}`;
    };
    openSheet(`<h3 id="pickHead"></h3><input class="input bt-search" id="pickQ" type="search" placeholder="Search your robots"><div class="bt-tiles" id="pickList"></div>
      <button class="cta wide" data-close>Done</button>`, (t) => {
      const b = t.closest<HTMLElement>("[data-pick-team]");
      if (!b) return;
      const team = +b.dataset.pickTeam!;
      if (mode === "captain") {
        if (d.robots.includes(team)) d.robots = d.robots.filter((x) => x !== team);
        d.captain = team;
        dirty = true;
        closeSheet();
        draw();
        return;
      }
      if (d.captain === team) return;
      if (d.robots.includes(team)) d.robots = d.robots.filter((x) => x !== team);
      else if (d.robots.length < CAT.rules.deck_robots) d.robots.push(team);
      dirty = true;
      drawPicker();
      draw();
    });
    $<HTMLInputElement>("#pickQ")!.oninput = (e) => { q = (e.target as HTMLInputElement).value.toLowerCase(); drawPicker(); };
    drawPicker();
  };

  const pickSupport = () => {
    let kind: "PART" | "LORE" = "PART";
    const drawPicker = () => {
      const counts = new Map<string, number>();
      d.support.forEach((s) => counts.set(s, (counts.get(s) ?? 0) + 1));
      $("#pickHead")!.textContent = `Support ${d.support.length}/${CAT.rules.support_cards}`;
      $("#supList")!.innerHTML = CAT.support
        .filter((c) => c.kind === kind)
        .map((c) => {
          const k = counts.get(c.id) ?? 0;
          const max = Math.min(CAT.rules.max_copies, HOME.support_owned[c.id] ?? 0);
          return supportCard(c, "", `<div class="bt-stepper"><button data-sp-minus="${c.id}" ${k ? "" : "disabled"} aria-label="One fewer">−</button><b>${k}</b><button data-sp-plus="${c.id}" ${k >= max || d.support.length >= CAT.rules.support_cards ? "disabled" : ""} aria-label="One more">+</button></div>`, k ? "sel" : "");
        })
        .join("");
      $("#sheetIn")!.querySelectorAll<HTMLElement>("[data-kind]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.kind === kind)));
    };
    openSheet(`<h3 id="pickHead"></h3><div class="seg bt-seg"><button data-kind="PART">Parts</button><button data-kind="LORE">Lore</button></div>
      <div class="bt-supgrid" id="supList"></div><button class="cta wide" data-close>Done</button>`, (t) => {
      const k = t.closest<HTMLElement>("[data-kind]");
      if (k) { kind = k.dataset.kind as "PART" | "LORE"; return drawPicker(); }
      const p = t.closest<HTMLButtonElement>("[data-sp-plus]");
      if (p && !p.disabled) { d.support.push(p.dataset.spPlus!); dirty = true; drawPicker(); return draw(); }
      const m = t.closest<HTMLButtonElement>("[data-sp-minus]");
      if (m && !m.disabled) { const i = d.support.lastIndexOf(m.dataset.spMinus!); if (i >= 0) d.support.splice(i, 1); dirty = true; drawPicker(); return draw(); }
    });
    drawPicker();
  };

  draw();
  leave = () => { if (dirty) save(true); };
}

// ---------- lobby ----------

async function renderLobby() {
  await loadHome();
  if (HOME.active) return go(`#game/${HOME.active}`);
  const ready = HOME.decks.filter((d) => !d.problems.length);
  main.innerHTML = `
    <div class="bt-head"><button class="bt-back" data-go="#home" aria-label="Back">‹</button><h2>Play</h2></div>
    ${ready.length ? '<button class="cta wide" id="host">Create game</button>' : '<div class="bt-empty">You need a ready deck to play. <button class="textbtn" data-go="#decks">Build one</button></div>'}
    <h3 class="bt-h3">Open games</h3>
    <div id="lobbyList" class="bt-lobby"><p class="bt-dim">Looking…</p></div>`;
  const host = $("#host");
  if (host) host.onclick = async () => {
    try { const g = await call<GameView>("POST", "/api/battler/games"); go(`#game/${g.id}`); } catch (e) { toast(explain(e), true); }
  };
  let alive = true;
  leave = () => { alive = false; };
  const refresh = async () => {
    try {
      const r = await call<{ games: { id: string; host: string; elo: number; created_at: number }[] }>("GET", "/api/battler/lobby");
      const list = $("#lobbyList");
      if (!list) return;
      list.innerHTML = r.games.length
        ? r.games.map((g) => `<div class="bt-lobbyrow"><div><b>${esc(g.host)}</b><span>${g.elo} Elo · ${ago(g.created_at)}</span></div>${g.host === HOME.name ? '<span class="bt-dim">You</span>' : `<button class="cta small" data-join="${g.id}" ${ready.length ? "" : "disabled"}>Join</button>`}</div>`).join("")
        : '<p class="bt-dim">No open games right now. Create one and share the wait.</p>';
    } catch { /* keep the old list */ }
  };
  $("#lobbyList")!.onclick = async (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-join]");
    if (!b) return;
    b.disabled = true;
    try { await call("POST", `/api/battler/games/${b.dataset.join}/join`); go(`#game/${b.dataset.join}`); } catch (err) { toast(explain(err), true); refresh(); }
  };
  await refresh();
  (async () => { while (alive) { await wait(3000); if (alive) await refresh(); } })();
}

function ago(t: number) {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  return s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)} min ago` : `${Math.floor(s / 3600)} h ago`;
}

// ---------- the game ----------

let G: GameView | null = null;
let selected: number | null = null; // the hand card picked up in the pit
let shownResult = 0; // the last round whose results animation has played
let skipAnim = false;
let lastAnimated = 0; // the last round whose reveal has played

const gameOver = () => { const g = G as GameView | null; return !!g && (g.status === "FINAL" || g.status === "CANCELLED"); };

async function renderGame(id: string) {
  if (!HOME) await loadHome();
  G = null;
  selected = null;
  shownResult = -1;
  let alive = true;
  let timer = 0;
  leave = () => { alive = false; clearInterval(timer); };
  const poll = async () => {
    try {
      const r = await call<GameView & { same?: boolean }>("GET", `/api/battler/games/${id}${G ? `?rev=${G.rev}` : ""}`);
      if (!alive || r.same) return;
      setGame(r);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 404 || e.status === 403)) { alive = false; main.innerHTML = `<div class="bt-empty">${e.status === 404 ? "That game doesn't exist." : "That's not your game."} <button class="textbtn" data-go="#play">Back to Play</button></div>`; }
    }
  };
  await poll();
  (async () => { while (alive) { await wait(gameOver() ? 15000 : 1500); if (alive && document.visibilityState === "visible") await poll(); } })();
  timer = window.setInterval(tickClock, 1000);
}

/** Whether the game is waiting on this player right now. */
function myMove(g: GameView) {
  const me = g.me ? g.seats[g.me.side] : null;
  if (!me) return false;
  return (g.status === "DECKS" && !me.picked) || (g.status === "PIT" && !me.locked) || (g.status === "RESULTS" && !me.acked);
}

function setGame(g: GameView) {
  const prev = G;
  G = g;
  document.title = myMove(g) ? "● Your move · Battler" : "Battler · FRC Packs";
  // A short buzz on phones when the round resolves or the game ends.
  if (prev && prev.status !== g.status && (g.status === "RESULTS" || g.status === "FINAL")) navigator.vibrate?.(40);
  if (shownResult === -1) shownResult = g.status === "RESULTS" ? g.round - 1 : g.rounds.length; // don't replay old results on load
  if (prev && prev.status !== g.status) selected = null;
  // While the round reveal plays, the only thing that can change is the other player tapping Next: don't restart the
  // reveal for that, just say they're ready.
  if (prev && prev.status === "RESULTS" && g.status === "RESULTS" && prev.round === g.round && g.me && prev.seats[g.me.side]?.acked === g.seats[g.me.side]?.acked) {
    const r = $("#oppReady");
    if (r) r.hidden = !g.seats[1 - g.me.side]?.acked;
    return;
  }
  drawGame();
  if (g.status === "FINAL" && prev && prev.status !== "FINAL") loadHome().catch(() => {});
}

async function act(action: Record<string, unknown>) {
  if (!G) return;
  const status = G.status, round = G.round;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const g = await call<GameView>("POST", `/api/battler/games/${G!.id}/act`, { rev: G!.rev, action });
      $("#toast")!.hidden = true; // any "now tap…" hint is done
      setGame(g);
      return;
    } catch (e) {
      if (!(e instanceof ApiError && e.code === "stale")) return toast(explain(e), true);
      // The other player changed something (their own pit, usually). Catch up, and if we're still in the same phase of
      // the same round, send the tap again: the server checks every rule against the fresh game anyway.
      const g = await call<GameView>("GET", `/api/battler/games/${G!.id}`).catch(() => null);
      if (!g) return toast(explain(e), true);
      setGame(g);
      if (g.status !== status || g.round !== round) return toast(explain(e));
    }
  }
}

function tickClock() {
  const el = $("#clock");
  if (!el || !G || !G.deadline) return;
  const s = Math.max(0, Math.round((G.deadline - Date.now()) / 1000));
  el.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  el.classList.toggle("low", s <= 30);
}

const robotOf = (inst: number) => G!.robots.find((r) => r.inst === inst);
const cardOf = (inst: number) => G!.support.find((c) => c.inst === inst);

function gameHeader(g: GameView) {
  const me = g.me!.side, op = 1 - me;
  const a = g.seats[me], b = g.seats[op];
  const dots = Array.from({ length: g.rounds_total }, (_, i) => `<i class="${i + 1 < g.round || (i + 1 === g.round && (g.status === "RESULTS" || g.status === "FINAL")) ? "done" : i + 1 === g.round ? "now" : ""}"></i>`).join("");
  // While a round's results are still being revealed, the RP shown is from before it (no spoilers); the reveal ends by
  // counting it up to the real total.
  const last = g.rounds[g.rounds.length - 1];
  const hiding = !!last && (g.status === "RESULTS" || shownResult < g.rounds.length) && lastAnimated < last.round && !skipAnim;
  const gain = (s: number) => (hiding ? last.result.match_rp[s] + last.result.bonus_rp[s] : 0);
  return `<div class="bt-gh">
    <div class="bt-gh-p me"><b>${esc(a?.name)}</b><span>${a?.elo ?? ""} Elo</span></div>
    <div class="bt-gh-mid"><div class="bt-gh-rp"><b data-rp-to="${a?.rp ?? 0}">${(a?.rp ?? 0) - gain(me)}</b><small>RP</small><b data-rp-to="${b?.rp ?? 0}">${(b?.rp ?? 0) - gain(op)}</b></div><div class="bt-dots">${dots}</div>
      ${g.deadline && !["FINAL", "CANCELLED"].includes(g.status) ? '<div class="bt-clock" id="clock"></div>' : ""}</div>
    <div class="bt-gh-p op"><b>${esc(b?.name ?? "Waiting…")}</b><span>${b ? `${b.elo} Elo` : ""}</span></div>
  </div>`;
}

function drawGame() {
  const g = G!;
  if (!g.me) {
    // Someone opened a game link: they can take the empty seat.
    const host = g.seats[0];
    main.innerHTML = g.status === "OPEN" && host
      ? `<div class="bt-panel center"><h2>${esc(host.name)} wants a game</h2><p class="bt-dim">${host.elo} Elo · 5 rounds · bring a ready deck</p><button class="cta" id="joinLink">Join game</button><button class="textbtn" data-go="#home">Not now</button></div>`
      : `<div class="bt-empty">This game is already full. <button class="textbtn" data-go="#play">Find another</button></div>`;
    const j = $("#joinLink");
    if (j) j.onclick = async () => {
      try { await call("POST", `/api/battler/games/${g.id}/join`); route(); } catch (e) { toast(explain(e), true); }
    };
    return;
  }
  switch (g.status) {
    case "OPEN": main.innerHTML = drawWaiting(g); break;
    case "DECKS": main.innerHTML = gameHeader(g) + drawDeckPick(g); break;
    case "PIT":
      if (shownResult < g.rounds.length) { main.innerHTML = gameHeader(g) + drawResults(g, g.rounds.length - 1, true); break; }
      main.innerHTML = gameHeader(g) + drawPit(g);
      break;
    case "RESULTS": main.innerHTML = gameHeader(g) + drawResults(g, g.rounds.length - 1, false); break;
    case "FINAL":
      if (shownResult < g.rounds.length && g.outcome?.reason === "complete") { main.innerHTML = gameHeader(g) + drawResults(g, g.rounds.length - 1, true); break; }
      main.innerHTML = gameHeader(g) + drawFinal(g);
      break;
    case "CANCELLED": main.innerHTML = `<div class="bt-panel center"><h2>Game called off</h2><p class="bt-dim">It ended before anyone played a round (or both players left), so nobody's rating changed.</p><button class="cta" data-go="#play">Back to Play</button></div>`; break;
  }
  bindGame();
  tickClock();
  if (g.status === "RESULTS" || (shownResult < g.rounds.length && g.rounds.length)) runResults();
}

function drawWaiting(g: GameView) {
  return `<div class="bt-panel center bt-wait">
    <div class="bt-spinner" aria-hidden="true"></div>
    <h2>Waiting for an opponent</h2>
    <p class="bt-dim">Your game is in the lobby. It's called off if nobody joins within 30 minutes.</p>
    <button class="cta small" id="shareGame">Copy invite link</button>
    <button class="cta small ghost" data-act="cancel">Cancel game</button>
    <p class="bt-fair">Fairness code <code>${g.seed_hash.slice(0, 16)}…</code></p>
  </div>`;
}

function drawDeckPick(g: GameView) {
  const me = g.seats[g.me!.side]!, op = g.seats[1 - g.me!.side]!;
  if (me.picked) return `<div class="bt-panel center"><div class="bt-spinner"></div><h2>Deck locked in</h2><p class="bt-dim">${op.picked ? "Starting…" : `Waiting for ${esc(op.name)} to pick a deck.`}</p><button class="textbtn" data-act="forfeit">Leave game</button></div>`;
  const decks = HOME.decks;
  return `<div class="bt-panel"><h2>Pick your deck</h2><p class="bt-dim">Decks stay private. Ownership is checked again now.</p>
    <div class="bt-decklist">${decks.map((d) => `<button class="bt-deckrow ${d.problems.length ? "off" : ""}" data-deck="${d.deck.id}" ${d.problems.length ? "disabled" : ""}>
      <div class="bt-deckrow-cap t-${esc(ROBOT.get(d.deck.captain ?? 0)?.tier ?? "none")}">${d.deck.captain ? `<span>${d.deck.captain}</span>` : "?"}</div>
      <div><b>${esc(d.deck.name)}</b><span class="${d.problems.length ? "warn" : "ok"}">${d.problems.length ? esc(d.problems[0]) : "Ready"}</span></div></button>`).join("") || '<div class="bt-empty">No decks.</div>'}</div>
    <button class="textbtn" data-act="forfeit">Leave game</button></div>`;
}

function stationOf(plan: Plan, inst: number) {
  return plan.stations.indexOf(inst as never) + 1;
}

function fieldTile(r: RobotInst, opts: { station?: number; captain?: boolean; parts?: SupportInst[]; mine?: boolean; target?: boolean; score?: RobotScore; hidden?: boolean }) {
  const names = CAT.rp_names;
  const st = opts.station ?? 0;
  const rp = st ? r.stats.rp[st - 1] : null;
  const partChips = (opts.parts ?? []).map((p) => `<span class="bt-pchip">${esc(p.name)}${opts.mine ? `<button data-detach="${p.inst}" aria-label="Remove ${esc(p.name)}">×</button>` : ""}</span>`).join("");
  const stations = opts.mine
    ? `<div class="bt-stations" role="group" aria-label="Driver station">${[1, 2, 3].map((n) => `<button data-station="${n}" data-robot="${r.inst}" aria-pressed="${st === n}">${n}</button>`).join("")}</div>`
    : st ? `<span class="bt-stbadge">S${st}</span>` : "";
  const s = opts.score;
  return `<div class="bt-ft t-${esc(r.tier)} ${opts.target ? "target" : ""} ${opts.mine ? "mine" : ""}" data-robot-tile="${r.inst}">
    <div class="bt-ft-top">
      <div class="bt-ft-pic">${r.photo ? `<img alt="" src="/photos/${r.team}.webp">` : `<span>#${r.team}</span>`}${opts.captain ? '<i class="bt-cap" title="Alliance Captain">C</i>' : ""}</div>
      <div class="bt-ft-id"><b>${r.team}</b><span>${esc(r.name)}</span></div>
      ${stations}
    </div>
    <div class="bt-ft-stats">
      ${s ? s.points.map((p, i) => `<span class="ph${i}" data-pts="${p}" data-base="${s.base[i]}"><small>${["A", "T", "E"][i]}</small><b>${p}</b></span>`).join("") : `<span><small>A</small><b>${r.stats.auto}</b></span><span><small>T</small><b>${r.stats.tele}</b></span><span><small>E</small><b>${r.stats.end}</b></span>`}
      ${s ? `<span class="bt-roll" data-hit="${s.rp_hit}" title="RP${s.station} chance"><small>RP${s.station}</small><b>${s.rp_chance}%</b><em>${s.rp_hit ? "+1" : "–"}</em></span>` : rp !== null ? `<span class="rp" title="${names[st - 1]} RP at station ${st}"><small>RP${st}</small><b>${rp}%</b></span>` : `<span class="rp bt-dim"><small>RP</small><b>${r.stats.rp.join("/")}</b></span>`}
    </div>
    ${r.effect_text ? `<div class="bt-ft-fx">${esc(r.effect_text)}</div>` : ""}
    ${partChips ? `<div class="bt-ft-parts">${partChips}</div>` : ""}
  </div>`;
}

function drawPit(g: GameView) {
  const side = g.me!.side, op = 1 - side;
  const me = g.seats[side]!, them = g.seats[op]!;
  const plan = g.me!.plan;
  const myBots = g.alliances[side];
  const selCard = selected !== null ? cardOf(selected) : null;
  const attachedTo = (inst: number) => plan.attach.filter(([, r]) => r === inst).map(([p]) => cardOf(p)!).filter(Boolean);
  const planned = new Set([...plan.attach.map(([p]) => p), ...(plan.lore !== null ? [plan.lore] : [])]);
  const hand = g.me!.hand.map((i) => cardOf(i)!).filter(Boolean);
  const loreCard = plan.lore !== null ? cardOf(plan.lore) : null;
  const locked = me.locked;
  const robotsByStation = [...myBots].sort((a, b) => stationOf(plan, a) - stationOf(plan, b));
  return `
    <section class="bt-side op">
      <h3>${esc(them.name)}'s alliance <span class="bt-lockst ${them.locked ? "on" : ""}">${them.locked ? "Locked ✓" : "In the pit…"}</span></h3>
      <div class="bt-field compact">${g.alliances[op].map((i) => fieldTile(robotOf(i)!, { captain: i === g.alliances[op][0] })).join("")}</div>
      <p class="bt-note">Their parts, lore and stations stay hidden until you both lock. They hold ${plural(them.hand_count, "card")}.</p>
    </section>
    <section class="bt-side me">
      <h3>Your alliance <small>${locked ? "Locked" : "tap a card, then a robot"}</small></h3>
      <div class="bt-field">${robotsByStation.map((i) => fieldTile(robotOf(i)!, { station: stationOf(plan, i), captain: i === myBots[0], parts: attachedTo(i), mine: !locked, target: !locked && selCard?.kind === "PART" })).join("")}</div>
    </section>
    <section class="bt-hand">
      <h3>Your hand <small>${plural(hand.length, "card")} · ${me.pile_count} left to draw</small></h3>
      <div class="bt-handrow">${hand.length ? hand.map((c) => supportCard(c, `data-hand="${c.inst}" role="button" tabindex="0"`, planned.has(c.inst) ? `<div class="bt-inplay">${plan.lore === c.inst ? "Lore slot" : "Attached"}</div>` : "", `${selected === c.inst ? "sel" : ""} ${planned.has(c.inst) ? "used" : ""}`)).join("") : '<p class="bt-dim">No cards in hand.</p>'}</div>
    </section>
    <section class="bt-side lore">
      <div class="bt-loreslot ${!locked && selCard?.kind === "LORE" ? "target" : ""} ${loreCard ? "full" : ""}" data-lore-slot>
        <small>YOUR LORE THIS ROUND (0–1)</small>
        ${loreCard ? `<b>${esc(loreCard.name)}</b><span>${esc(loreCard.text)}</span>${locked ? "" : '<button class="textbtn" data-lore-clear>Take back</button>'}` : `<span class="bt-dim">${selCard?.kind === "LORE" ? "Tap here to play it" : "No lore played. Lore hits all six robots for one round."}</span>`}
      </div>
    </section>
    <div class="bt-lockbar">
      ${locked ? `<div class="bt-waitlock"><div class="bt-spinner small"></div>${them.locked ? "Revealing…" : `Locked in. Waiting for ${esc(them.name)}.`}</div>` : `<button class="cta wide" data-act="lock">Lock pit</button>`}
      <button class="textbtn bt-forfeit" data-act="forfeit">Forfeit</button>
    </div>
    ${me.strikes ? `<p class="bt-note warn">You missed ${plural(me.strikes, "pit timer")}. Missing ${CAT.rules.strikes} forfeits the game.</p>` : ""}`;
}

function bindGame() {
  const share = $("#shareGame");
  if (share) share.onclick = async () => {
    const url = `${location.origin}/battle.html#game/${G!.id}`;
    try {
      if (navigator.share) await navigator.share({ title: "Battler", text: "Play me in the Battler", url });
      else { await navigator.clipboard.writeText(url); toast("Invite link copied."); }
    } catch { /* closed the share sheet */ }
  };
  main.onclick = (e) => {
    const t = e.target as HTMLElement;
    const a = t.closest<HTMLElement>("[data-act]");
    if (a) {
      const k = a.dataset.act!;
      if (k === "forfeit" && !confirm(G!.status === "DECKS" ? "Leave this game? Nobody's rating changes." : "Forfeit this game? It counts as a loss.")) return;
      if (k === "ack") { shownResult = G!.rounds.length; if (G!.status !== "RESULTS") return drawGame(); }
      return void act({ kind: k });
    }
    const deck = t.closest<HTMLElement>("[data-deck]");
    if (deck) return void act({ kind: "pick_deck", deck: deck.dataset.deck });
    if (G!.status !== "PIT") {
      const rt = t.closest<HTMLElement>("[data-robot-tile]");
      if (rt) showRobot(robotOf(+rt.dataset.robotTile!)!);
      return;
    }
    const plan = G!.me!.plan;
    const det = t.closest<HTMLElement>("[data-detach]");
    if (det) return void act({ kind: "detach", part: +det.dataset.detach! });
    const stb = t.closest<HTMLElement>("[data-station]");
    if (stb) {
      const n = +stb.dataset.station!, inst = +stb.dataset.robot!;
      const st = [...plan.stations] as [number, number, number];
      const cur = st.indexOf(inst);
      if (cur === n - 1) return;
      [st[cur], st[n - 1]] = [st[n - 1], st[cur]];
      return void act({ kind: "stations", robots: st });
    }
    if (t.closest("[data-lore-clear]")) return void act({ kind: "lore", card: null });
    const h = t.closest<HTMLElement>("[data-hand]");
    if (h) {
      const inst = +h.dataset.hand!;
      const c = cardOf(inst);
      // Tapping a card already in play takes it back.
      if (plan.lore === inst) return void act({ kind: "lore", card: null });
      if (plan.attach.some(([p]) => p === inst)) return void act({ kind: "detach", part: inst });
      selected = selected === inst ? null : inst;
      if (c) toast(c.kind === "PART" ? "Now tap one of your robots to attach it." : "Now tap the lore slot to play it.");
      return drawGame();
    }
    const slot = t.closest<HTMLElement>("[data-lore-slot]");
    if (slot && selected !== null && cardOf(selected)?.kind === "LORE") {
      const card = selected;
      selected = null;
      return void act({ kind: "lore", card });
    }
    const rt = t.closest<HTMLElement>("[data-robot-tile]");
    if (rt) {
      const inst = +rt.dataset.robotTile!;
      if (selected !== null && cardOf(selected)?.kind === "PART" && G!.alliances[G!.me!.side].includes(inst as never)) {
        const part = selected;
        selected = null;
        return void act({ kind: "attach", part, robot: inst });
      }
      showRobot(robotOf(inst)!);
    }
  };
}

// ---------- results ----------

function drawResults(g: GameView, idx: number, replay: boolean) {
  const log = g.rounds[idx];
  if (!log) return "";
  const side = g.me!.side, op = 1 - side;
  const r = log.result;
  const score = (inst: number) => r.robots.find((x) => x.inst === inst)!;
  const partsOn = (s: number, inst: number) => log.attach[s].filter(([, rb]) => rb === inst).map(([p]) => cardOf(p)!).filter(Boolean);
  const lore = (s: number) => (log.lore[s] !== null ? cardOf(log.lore[s]!) : null);
  const won = r.winner === null ? "tie" : r.winner === side ? "win" : "loss";
  const myRp = r.match_rp[side] + r.bonus_rp[side], opRp = r.match_rp[op] + r.bonus_rp[op];
  // The captain never changes, so this round's first robot per side is it.
  const tiles = (s: number) => log.stations[s].map((inst) => fieldTile(robotOf(inst)!, { station: score(inst).station, captain: inst === g.alliances[s][0], parts: partsOn(s, inst), score: score(inst) })).join("");
  const me = g.seats[side]!, them = g.seats[op]!;
  const waiting = g.status === "RESULTS" && me.acked;
  return `<div class="bt-results" data-round="${log.round}">
    <h2 class="bt-rtitle">Round ${log.round} results</h2>
    <div class="bt-lores">
      ${[side, op].map((s) => { const l = lore(s); return `<div class="bt-lorecard ${l ? "" : "none"} ${s === side ? "me" : "op"}"><small>${s === side ? "Your lore" : `${esc(g.seats[s]!.name)}'s lore`}</small>${l ? `<b>${esc(l.name)}</b><span>${esc(l.text)}</span>` : "<span>None played</span>"}</div>`; }).join("")}
    </div>
    <div class="bt-board">
      <div class="bt-board-row head"><span></span><span>You</span><span>${esc(them.name)}</span></div>
      ${["Auto", "Tele", "End"].map((p, k) => `<div class="bt-board-row ph" data-phase="${k}"><span>${p}</span><b data-to="${r.phase_totals[side][k]}">${r.phase_totals[side][k]}</b><b data-to="${r.phase_totals[op][k]}">${r.phase_totals[op][k]}</b></div>`).join("")}
      <div class="bt-board-row tot"><span>Total</span><b>${r.totals[side]}</b><b>${r.totals[op]}</b></div>
    </div>
    <div class="bt-verdict ${won}">${won === "win" ? "You won the round" : won === "loss" ? "You lost the round" : "Tied round"}
      <span>+${r.match_rp[side]} RP for the result, +${r.bonus_rp[side]} from robot rolls = <b>+${myRp} RP</b> (them +${opRp})</span></div>
    <section class="bt-side me"><h3>Your alliance${log.auto_locked[side] ? ' <span class="warn">auto-locked</span>' : ""}</h3><div class="bt-field">${tiles(side)}</div></section>
    <section class="bt-side op"><h3>${esc(them.name)}${log.auto_locked[op] ? ' <span class="warn">auto-locked</span>' : ""}</h3><div class="bt-field">${tiles(op)}</div></section>
    ${r.events.length ? `<details class="bt-log"><summary>What triggered (${r.events.length})</summary><ul>${r.events.map((ev) => `<li><b>${esc(ev.source)}</b> ${esc(ev.text)}</li>`).join("")}</ul></details>` : ""}
    <div class="bt-lockbar">
      ${waiting ? `<div class="bt-waitlock"><div class="bt-spinner small"></div>Waiting for ${esc(them.name)}…</div>` : `<button class="cta wide" data-act="ack">${replay ? "Continue" : log.round >= g.rounds_total ? "See final result" : "Next round"}</button>`}
      <span class="bt-oppready" id="oppReady" ${them.acked ? "" : "hidden"}>${esc(them.name)} is ready for the next round</span>
      <button class="textbtn" id="skipAnim">Skip animation</button>
    </div>
  </div>`;
}

let animToken = 0;
async function runResults() {
  const box = $(".bt-results");
  if (!box) return;
  const round = +box.dataset.round!;
  const token = ++animToken;
  const fast = skipAnim || box.dataset.played === "1" || lastAnimated >= round;
  $("#skipAnim")?.addEventListener("click", () => { skipAnim = true; finishAnim(box); });
  if (fast) return finishAnim(box);
  lastAnimated = round;
  box.classList.add("anim");
  // Phase by phase: totals count up, robots' phase numbers light up.
  for (let k = 0; k < 3; k++) {
    if (token !== animToken) return;
    box.querySelectorAll<HTMLElement>(`.bt-board-row[data-phase="${k}"] b`).forEach((b) => countUp(b, +b.dataset.to!));
    box.querySelectorAll<HTMLElement>(`.bt-ft-stats .ph${k}`).forEach((s) => s.classList.add("lit"));
    box.querySelector(`.bt-board-row[data-phase="${k}"]`)?.classList.add("lit");
    await wait(900);
  }
  box.querySelector(".bt-board-row.tot")?.classList.add("lit");
  await wait(500);
  for (const roll of box.querySelectorAll<HTMLElement>(".bt-roll")) {
    if (token !== animToken) return;
    roll.classList.add("rolling");
    await wait(320);
    roll.classList.remove("rolling");
    roll.classList.add("done");
  }
  box.querySelector(".bt-verdict")?.classList.add("lit");
  box.classList.add("finished");
  document.querySelectorAll<HTMLElement>("[data-rp-to]").forEach((b) => countUp(b, +b.dataset.rpTo!));
}
function finishAnim(box: HTMLElement) {
  animToken++;
  box.dataset.played = "1";
  box.classList.add("anim", "finished");
  box.querySelectorAll(".bt-board-row, .bt-ft-stats span, .bt-verdict").forEach((e) => e.classList.add("lit"));
  box.querySelectorAll(".bt-roll").forEach((e) => e.classList.add("done"));
  box.querySelectorAll<HTMLElement>(".bt-board-row b[data-to]").forEach((b) => (b.textContent = b.dataset.to!));
  document.querySelectorAll<HTMLElement>("[data-rp-to]").forEach((b) => (b.textContent = b.dataset.rpTo!));
}

function countUp(el: HTMLElement, to: number) {
  const start = performance.now();
  const step = (t: number) => {
    const k = Math.min(1, (t - start) / 700);
    el.textContent = String(Math.round(to * (1 - Math.pow(1 - k, 3))));
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// ---------- final ----------

function drawFinal(g: GameView) {
  const o = g.outcome!;
  const side = g.me!.side, op = 1 - side;
  const res = o.winner === null ? "draw" : o.winner === side ? "win" : "loss";
  const d = o.elo_after[side] - o.elo_before[side];
  const why = o.reason === "forfeit" ? (res === "win" ? `${esc(g.seats[op]!.name)} forfeited.` : "You forfeited.") : o.reason === "timeout" ? (res === "win" ? `${esc(g.seats[op]!.name)} ran out the pit timer.` : "You ran out the pit timer.") : "";
  return `<div class="bt-final ${res}">
    <h1>${res === "win" ? "Victory" : res === "loss" ? "Defeat" : "Draw"}</h1>
    ${why ? `<p class="bt-dim">${why}</p>` : ""}
    <div class="bt-finalscore"><div><b>${o.rp[side]}</b><small>your RP</small></div><span>–</span><div><b>${o.rp[op]}</b><small>${esc(g.seats[op]!.name)}</small></div></div>
    <p class="bt-tiebreak">Points ${o.points[side]} – ${o.points[op]}${o.rp[0] === o.rp[1] ? " (RP tied, so points decide)" : ""}</p>
    <div class="bt-elochange ${d >= 0 ? "up" : "down"}">${o.elo_before[side]} → <b>${o.elo_after[side]}</b> Elo <span>${d >= 0 ? "+" : ""}${d}</span></div>
    ${g.rounds.length ? `<table class="bt-rounds"><thead><tr><th>Round</th><th>You</th><th>${esc(g.seats[op]!.name)}</th><th>RP</th></tr></thead><tbody>
      ${g.rounds.map((r) => `<tr><td>${r.round}</td><td>${r.result.totals[side]}</td><td>${r.result.totals[op]}</td><td>+${r.result.match_rp[side] + r.result.bonus_rp[side]} / +${r.result.match_rp[op] + r.result.bonus_rp[op]}</td></tr>`).join("")}
    </tbody></table>` : ""}
    <div class="cta-row"><button class="cta" data-go="#play">Play again</button><button class="cta ghost" data-go="#home">Home</button></div>
    <details class="bt-log"><summary>Fairness check</summary><p>Every shuffle and roll in this game came from one secret number, locked in before the game started. Its fingerprint (SHA-256) was shown from the start:</p>
      <code class="bt-code">${g.seed_hash}</code><p>The number itself, revealed now:</p><code class="bt-code">${g.seed}</code>
      <p class="bt-dim">SHA-256 of the number as 8 little-endian bytes gives the fingerprint above, so it couldn't have been changed mid-game.</p></details>
  </div>`;
}

// ---------- history ----------

async function renderHistory() {
  const r = await call<{ games: HistoryRow[] }>("GET", "/api/battler/history");
  main.innerHTML = `<div class="bt-head"><button class="bt-back" data-go="#home" aria-label="Back">‹</button><h2>Match history</h2></div>
    ${r.games.length ? `<div class="bt-lobby">${r.games.map((h) => { const d = h.elo_after - h.elo_before; return `<div class="bt-lobbyrow ${h.winner === true ? "win" : h.winner === false ? "loss" : "draw"}"><div><b>${h.winner === true ? "Won" : h.winner === false ? "Lost" : "Draw"} vs ${esc(h.opponent)}</b><span>${h.rp[0]}–${h.rp[1]} RP · ${h.points[0]}–${h.points[1]} pts${h.reason !== "complete" ? ` · ${esc(h.reason)}` : ""} · ${ago(h.at)}</span></div><span class="bt-delta ${d >= 0 ? "up" : "down"}">${d >= 0 ? "+" : ""}${d}</span></div>`; }).join("")}</div>` : '<div class="bt-empty">No games yet.</div>'}`;
}

// ---------- admin: robot effects ----------

interface FxRow { team: number; draft: Effect[]; published: Effect[]; rev: number; author: string; updated: number; draft_text: string; published_text: string }
interface Cond { if: "HAS_PART_TAG" | "STATION" | "CAPTAIN" | "LORE_ACTIVE"; tag?: string; min?: number; station?: number; is?: boolean; of?: "TARGET" | "SOURCE" }
interface Effect { op: string; phase?: Phase; value?: number; percent?: number; rp?: string; tag?: string; scope: string; when?: Cond[]; chance?: number }

async function renderAdmin() {
  if (!HOME) await loadHome();
  if (!HOME.is_admin) { main.innerHTML = '<div class="bt-empty">Admins only.</div>'; return; }
  const data = await call<{ effects: FxRow[]; test_effects: Record<string, string> }>("GET", "/api/battler/admin/effects");
  const byTeam = new Map(data.effects.map((f) => [f.team, f]));
  let q = "";
  let filter: "all" | "none" | "published" | "draft" = "all";
  const drawList = () => {
    const list = CAT.robots
      .filter((r) => !q || String(r.team).includes(q) || r.name.toLowerCase().includes(q))
      .filter((r) => {
        const f = byTeam.get(r.team);
        return filter === "all" || (filter === "none" && !f?.published.length) || (filter === "published" && !!f?.published.length) || (filter === "draft" && !!f?.draft.length && JSON.stringify(f.draft) !== JSON.stringify(f.published));
      })
      .slice(0, 120);
    $("#fxList")!.innerHTML = list.map((r) => {
      const f = byTeam.get(r.team);
      const state = f?.published.length ? `<span class="ok">Published r${f.rev}</span>` : f?.draft.length ? '<span class="warn">Draft</span>' : data.test_effects[r.team] ? '<span class="bt-dim">Test example</span>' : '<span class="bt-dim">No effect</span>';
      return robotTile(r, `data-fx-team="${r.team}"`, `<div class="bt-tile-act">${state}</div>`);
    }).join("");
  };
  const done = data.effects.filter((f) => f.published.length).length;
  main.innerHTML = `<div class="bt-head"><button class="bt-back" data-go="#home" aria-label="Back">‹</button><h2>Card admin</h2></div>
    <p class="bt-note">Every robot needs a human-written unique effect (spec §4.5). ${done} of ${CAT.robots.length} published. Effects are built from parts, not typed, so the rules text always matches what the game does. Published effects apply to games that start afterwards; games in progress keep the version they started with.</p>
    <input class="input bt-search" id="fxQ" type="search" placeholder="Search team or name">
    <div class="seg bt-seg">${(["all", "none", "draft", "published"] as const).map((f) => `<button data-fxf="${f}" aria-selected="${filter === f}">${f === "none" ? "No effect" : f[0].toUpperCase() + f.slice(1)}</button>`).join("")}</div>
    <div class="bt-tiles" id="fxList"></div>`;
  drawList();
  $<HTMLInputElement>("#fxQ")!.oninput = (e) => { q = (e.target as HTMLInputElement).value.toLowerCase(); drawList(); };
  main.onclick = (e) => {
    const t = e.target as HTMLElement;
    const f = t.closest<HTMLElement>("[data-fxf]");
    if (f) { filter = f.dataset.fxf as typeof filter; main.querySelectorAll<HTMLElement>("[data-fxf]").forEach((b) => b.setAttribute("aria-selected", String(b === f))); return drawList(); }
    const row = t.closest<HTMLElement>("[data-fx-team]");
    if (row) editEffect(ROBOT.get(+row.dataset.fxTeam!)!, byTeam.get(+row.dataset.fxTeam!), (saved) => { byTeam.set(saved.team, saved); drawList(); });
  };
}

const OPS: [string, string][] = [["ADD_PHASE_FLAT", "+ points"], ["ADD_PHASE_PCT", "+ percent"], ["ADD_PHASE_MULTIPLIER", "× multiplier"], ["ADD_RP_PP", "+ RP chance"], ["PER_PART_TAG", "+ points per part tag"]];
const SCOPES: [string, string][] = [["SELF", "This robot"], ["ALLIES", "Its alliance"], ["ENEMIES", "Opposing robots"], ["FIELD", "All six robots"]];
const CONDS: [string, string][] = [["", "Always"], ["HAS_PART_TAG", "Has part tag"], ["STATION", "In station"], ["CAPTAIN", "Is captain"], ["LORE_ACTIVE", "Lore is active"]];

function allTags() {
  return CAT.tags.flatMap(([b, subs]) => [b, ...subs]);
}

function editEffect(r: Robot, f: FxRow | undefined, onSaved: (f: FxRow) => void) {
  let fx: Effect[] = JSON.parse(JSON.stringify(f?.draft?.length ? f.draft : f?.published ?? []));
  if (!fx.length) fx = [{ op: "ADD_PHASE_FLAT", phase: "TELE", value: 5, scope: "SELF" }];
  let station = 1, captain = false;
  const opt = (list: [string, string][] | string[], v: string | undefined) => list.map((o) => { const [val, label] = Array.isArray(o) ? o : [o, o]; return `<option value="${val}" ${val === (v ?? "") ? "selected" : ""}>${label}</option>`; }).join("");
  const row = (e: Effect, i: number) => {
    const c = e.when?.[0];
    return `<div class="bt-fxrow" data-i="${i}">
      <div class="bt-fxgrid">
        <label>Does<select data-k="op">${opt(OPS, e.op)}</select></label>
        ${e.op === "ADD_RP_PP" ? `<label>RP<select data-k="rp">${opt([["RP1", `RP1 ${CAT.rp_names[0]}`], ["RP2", `RP2 ${CAT.rp_names[1]}`], ["RP3", `RP3 ${CAT.rp_names[2]}`], ["STATION", "Its station's"]], e.rp)}</select></label>` : `<label>Phase<select data-k="phase">${opt(["AUTO", "TELE", "END", "ALL"], e.phase)}</select></label>`}
        ${e.op === "PER_PART_TAG" ? `<label>Tag<select data-k="tag">${opt(allTags(), e.tag)}</select></label>` : ""}
        ${e.op === "ADD_PHASE_MULTIPLIER" ? `<label>Percent<input type="number" data-k="percent" min="110" max="400" step="10" value="${e.percent ?? 200}"></label>` : `<label>Amount<input type="number" data-k="value" min="-100" max="300" value="${e.value ?? 5}"></label>`}
        <label>Who<select data-k="scope">${opt(SCOPES, e.scope)}</select></label>
        <label>Chance %<input type="number" data-k="chance" min="0" max="99" placeholder="always" value="${e.chance ?? ""}"></label>
        <label>Only if<select data-k="if">${opt(CONDS, c?.if)}</select></label>
        ${c?.if === "HAS_PART_TAG" ? `<label>Tag<select data-k="ctag">${opt(allTags(), c.tag)}</select></label><label>At least<input type="number" data-k="cmin" min="1" max="6" value="${c.min ?? 1}"></label>` : ""}
        ${c?.if === "STATION" ? `<label>Station<select data-k="cst">${opt(["1", "2", "3"], String(c.station ?? 1))}</select></label>` : ""}
        ${c?.if === "CAPTAIN" ? `<label>Captain?<select data-k="cis">${opt([["true", "is captain"], ["false", "isn't captain"]], String(c.is ?? true))}</select></label>` : ""}
        ${c && c.if !== "LORE_ACTIVE" ? `<label>Checked on<select data-k="cof">${opt([["TARGET", "the robot affected"], ["SOURCE", "this robot"]], c.of ?? "TARGET")}</select></label>` : ""}
      </div>
      ${fx.length > 1 ? `<button class="textbtn" data-del="${i}">Remove this effect</button>` : ""}
    </div>`;
  };
  const draw = () => {
    $("#fxRows")!.innerHTML = fx.map(row).join("") + (fx.length < 3 ? '<button class="bt-addslot" data-add>+ Add another effect</button>' : "");
    preview();
  };
  let pv = 0;
  const preview = async () => {
    const my = ++pv;
    try {
      const out = await call<{ valid: boolean; error: string | null; text: string; with: { totals: [number, number]; robots: RobotScore[] }; without: { totals: [number, number]; robots: RobotScore[] } }>("POST", "/api/battler/admin/preview", { team: r.team, effects: fx, station, captain, seed: 7 });
      if (my !== pv) return;
      const w = out.with.robots.find((x) => x.inst === 1)!, wo = out.without.robots.find((x) => x.inst === 1)!;
      $("#fxText")!.innerHTML = out.valid ? `<b>${esc(out.text)}</b>` : `<span class="warn">${esc(out.error)}</span>`;
      $("#fxSim")!.innerHTML = out.valid ? `Sample round (station ${station}${captain ? ", captain" : ""}, vs average robots): this robot scores <b>${w.points.join(" / ")}</b> (without the effect ${wo.points.join(" / ")}); RP chance ${w.rp_chance}% (was ${wo.rp_chance}%). Alliance ${out.with.totals[0]} vs ${out.with.totals[1]} (was ${out.without.totals[0]}).` : "";
      ($("#fxPublish") as HTMLButtonElement).disabled = !out.valid;
    } catch (e) { $("#fxText")!.textContent = explain(e); }
  };
  const read = (el: HTMLElement) => {
    const i = +el.closest<HTMLElement>("[data-i]")!.dataset.i!;
    const e = fx[i];
    const k = el.dataset.k!;
    const v = (el as HTMLInputElement).value;
    const num = v === "" ? undefined : +v;
    switch (k) {
      case "op": e.op = v; if (v === "ADD_RP_PP") { e.rp = e.rp ?? "STATION"; delete e.phase; } else { e.phase = e.phase ?? "TELE"; delete e.rp; } if (v === "ADD_PHASE_MULTIPLIER") { e.percent = e.percent ?? 200; delete e.value; } else { e.value = e.value ?? 5; delete e.percent; } if (v === "PER_PART_TAG") e.tag = e.tag ?? "MECHANICAL"; else delete e.tag; break;
      case "phase": e.phase = v as Phase; break;
      case "rp": e.rp = v; break;
      case "tag": e.tag = v; break;
      case "value": e.value = num ?? 0; break;
      case "percent": e.percent = num ?? 200; break;
      case "scope": e.scope = v; break;
      case "chance": if (num && num > 0) e.chance = num; else delete e.chance; break;
      case "if": e.when = v ? [{ if: v as Cond["if"], ...(v === "HAS_PART_TAG" ? { tag: "MECHANICAL", min: 1 } : v === "STATION" ? { station: 1 } : v === "CAPTAIN" ? { is: true } : {}) }] : undefined; if (!v) delete e.when; break;
      case "ctag": e.when![0].tag = v; break;
      case "cmin": e.when![0].min = num ?? 1; break;
      case "cst": e.when![0].station = +v; break;
      case "cis": e.when![0].is = v === "true"; break;
      case "cof": e.when![0].of = v as "TARGET" | "SOURCE"; break;
    }
    const redraw = ["op", "if"].includes(k);
    if (redraw) draw(); else preview();
  };
  const save = async (publish: boolean) => {
    if (publish && !confirm(`Publish this effect for ${r.team} ${r.name}? Games that start from now on use it.`)) return;
    try {
      const out = await call<FxRow>("PUT", `/api/battler/admin/effects/${r.team}`, { effects: fx, publish });
      const merged: FxRow = { ...(f ?? { team: r.team, draft: [], published: [], rev: 0, author: "", updated: 0, draft_text: "", published_text: "" }), ...out };
      onSaved(merged);
      toast(publish ? "Published." : "Draft saved.");
      if (publish) closeSheet();
    } catch (e) { toast(explain(e), true); }
  };
  openSheet(`<div class="bt-fxed">
      <h3>${r.team} ${esc(r.name)}</h3>
      <div class="bt-fxnow">${f?.published.length ? `Published (r${f.rev}): ${esc(f.published_text)}` : "Nothing published yet."}</div>
      <div id="fxRows"></div>
      <div class="bt-fxprev"><small>RULES TEXT (generated)</small><div id="fxText"></div><div id="fxSim" class="bt-dim"></div>
        <div class="bt-fxsimopts"><label>Preview in station <select id="fxSt"><option>1</option><option>2</option><option>3</option></select></label><label><input type="checkbox" id="fxCap"> as captain</label></div></div>
      <div class="cta-row"><button class="cta small ghost" id="fxDraft">Save draft</button><button class="cta small" id="fxPublish">Publish</button></div>
    </div>`, (t) => {
    if (t.closest("[data-add]")) { fx.push({ op: "ADD_PHASE_FLAT", phase: "AUTO", value: 5, scope: "SELF" }); return draw(); }
    const del = t.closest<HTMLElement>("[data-del]");
    if (del) { fx.splice(+del.dataset.del!, 1); return draw(); }
    if (t.id === "fxDraft") return void save(false);
    if (t.id === "fxPublish") return void save(true);
  });
  $("#fxRows")!.addEventListener("change", (e) => read(e.target as HTMLElement));
  $("#fxSt")!.addEventListener("change", (e) => { station = +(e.target as HTMLSelectElement).value; preview(); });
  $("#fxCap")!.addEventListener("change", (e) => { captain = (e.target as HTMLInputElement).checked; preview(); });
  draw();
}

// ---------- start ----------

async function start() {
  try {
    CAT = await call<Catalog>("GET", "/api/battler/catalog");
    CAT.robots.forEach((r) => ROBOT.set(r.team, r));
    CAT.support.forEach((c) => SUPPORT.set(c.id, c));
    await loadHome();
    route();
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      main.innerHTML = '<div class="bt-panel center"><h2>Sign in first</h2><p class="bt-dim">The Battler uses your FRC Packs account and the robots you own there.</p><a class="cta" href="/">Sign in to FRC Packs</a></div>';
      return;
    }
    main.innerHTML = `<div class="bt-panel center"><h2>Couldn't load the Battler</h2><p class="bt-dim">${esc(explain(e))}</p><button class="cta" id="retry">Try again</button></div>`;
    $("#retry")!.onclick = () => location.reload();
  }
}

start();
