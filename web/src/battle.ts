// The Battler: build a deck from the robots you own in FRC Packs and play 1v1, five-round games. The server runs every
// rule (server/src/battler); this page shows what it says and sends what you tap. Screens are hash routes:
// #home, #library, #decks, #deck/<id>, #play, #game/<id>, #history, #admin.
import "./style.css";
import "./battle.css";
import "./arena.css";

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
interface SeatView { name: string; elo: number; picked: boolean; locked: boolean; acked: boolean; rp: number; points: number; hand_count: number; pile_count: number; strikes: number; face_down: number[]; lore_down: boolean }
interface EmoteView { side: number; id: string; at: number; n: number }
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
  emotes: EmoteView[]; emote_seq: number; now: number;
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
      ${r.effect_text ? `<div class="bt-tile-fx">${esc(r.effect_text)}</div>` : ""}
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

// Cards in the hand are role="button" divs: Enter or Space taps them, like a button.
main.addEventListener("keydown", (e) => {
  const t = e.target as HTMLElement;
  if ((e.key === "Enter" || e.key === " ") && t.getAttribute("role") === "button" && t.tagName !== "BUTTON") {
    e.preventDefault();
    t.click();
  }
});

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
      ${problems.length ? '<button class="bt-addslot" id="deckFill">Fill the rest automatically</button>' : ""}
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
    const fill = $("#deckFill");
    if (fill) fill.onclick = () => {
      // Strongest owned robots for the empty slots (best total as captain), then a mix of the starter Parts and Lore.
      const best = CAT.robots.filter((r) => owned.has(r.team)).sort((a, b) => total(b.stats) - total(a.stats)).map((r) => r.team);
      d.robots = d.robots.filter((t) => owned.has(t) && t !== d.captain);
      if (!d.captain || !owned.has(d.captain)) d.captain = best.find((t) => !d.robots.includes(t)) ?? null;
      for (const t of best) if (d.robots.length < CAT.rules.deck_robots && t !== d.captain && !d.robots.includes(t)) d.robots.push(t);
      const parts = CAT.support.filter((c) => c.kind === "PART").map((c) => c.id), lore = CAT.support.filter((c) => c.kind === "LORE").map((c) => c.id);
      const count = (id: string) => d.support.filter((x) => x === id).length;
      const add = (ids: string[], until: () => boolean) => {
        for (let round = 0; round < CAT.rules.max_copies; round++)
          for (const id of ids) if (!until() && count(id) < Math.min(CAT.rules.max_copies, HOME.support_owned[id] ?? 0) && count(id) === round) d.support.push(id);
      };
      // About a quarter Lore (one to play most rounds), the rest Parts, as many different cards as fit.
      const loreNow = () => d.support.filter((x) => SUPPORT.get(x)?.kind === "LORE").length;
      add(lore, () => loreNow() >= 4 || d.support.length >= CAT.rules.support_cards);
      add(parts, () => d.support.length >= CAT.rules.support_cards);
      dirty = true;
      save();
    };
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
//
// The match is an arena, laid out like the TCG battlers it borrows from (Marvel Snap's simultaneous turns and reveal,
// Hearthstone's board: you at the bottom, them at the top): the three driver stations are three lanes with your robot
// facing theirs; your hand fans along the bottom and you drag (or tap) cards onto robots or the lore banner; you watch
// the other player put cards down face down, see their hand shrink and their lock, and trade quick emotes. When both
// lock, the round is revealed as a sequence (flips, lore, Auto/Tele/End lane by lane into a tug-of-war bar, the round
// banner, one RP die per robot) instead of a results page.

let G: GameView | null = null;
let selected: number | null = null; // the hand card picked up in the pit
let pickedRobot: number | null = null; // your robot picked up to move to another station
let shownResult = 0; // results of rounds before this one have been seen
let skipAnim = false;
let lastAnimated = 0; // the last round whose reveal has played
let clockSkew = 0; // server clock minus this device's
let seenEmote = 0;
let dragging = false;
let pendingDraw = false;
const seenDown = new Map<number, number>(); // face-down cards already shown per robot (so only new ones animate in)

const gameOver = () => { const g = G as GameView | null; return !!g && (g.status === "FINAL" || g.status === "CANCELLED"); };

// ---------- sound (synthesized, no files) ----------

let audio: AudioContext | null = null;
const muted = () => { try { return localStorage.getItem("bt-mute") === "1"; } catch { return false; } };
const emotesMuted = () => { try { return localStorage.getItem("bt-mute-emotes") === "1"; } catch { return false; } };
function tone(freq: number, ms: number, type: OscillatorType = "sine", gain = 0.06, slide = 0) {
  if (muted()) return;
  try {
    audio = audio ?? new AudioContext();
    const t = audio.currentTime, o = audio.createOscillator(), g = audio.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(40, freq + slide), t + ms / 1000);
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
    o.connect(g).connect(audio.destination);
    o.start(t);
    o.stop(t + ms / 1000 + 0.02);
  } catch { /* no audio */ }
}
const sfx = {
  pick: () => tone(660, 70, "triangle", 0.05),
  place: () => { tone(320, 90, "square", 0.04, -120); navigator.vibrate?.(12); },
  flip: () => tone(900, 60, "triangle", 0.04, 400),
  lock: () => { tone(440, 90, "triangle"); setTimeout(() => tone(660, 120, "triangle"), 90); navigator.vibrate?.(25); },
  tick: (k: number) => tone(500 + k * 40, 45, "square", 0.025),
  boom: () => { tone(120, 260, "sawtooth", 0.07, -60); navigator.vibrate?.(60); },
  win: () => [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => tone(f, 160, "triangle", 0.06), i * 110)),
  lose: () => [392, 330, 262].forEach((f, i) => setTimeout(() => tone(f, 200, "sine", 0.05), i * 140)),
  dice: () => tone(200 + Math.random() * 300, 30, "square", 0.02),
  hit: () => { tone(1046, 140, "triangle", 0.06); navigator.vibrate?.(20); },
  miss: () => tone(180, 120, "sine", 0.04),
  emote: () => tone(880, 80, "sine", 0.04, 200),
};

// ---------- loading and polling ----------

async function renderGame(id: string) {
  if (!HOME) await loadHome();
  G = null;
  selected = null;
  pickedRobot = null;
  shownResult = -1;
  seenEmote = 0;
  seenDown.clear();
  let alive = true;
  let timer = 0;
  leave = () => { alive = false; clearInterval(timer); document.body.classList.remove("bt-in-arena"); };
  const poll = async () => {
    try {
      const q = G ? `?rev=${G.rev}&e=${G.emote_seq}` : "";
      const r = await call<GameView & { same?: boolean }>("GET", `/api/battler/games/${id}${q}`);
      if (!alive || r.same) return;
      setGame(r);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 404 || e.status === 403)) {
        alive = false;
        main.innerHTML = `<div class="bt-empty">${e.status === 404 ? "That game doesn't exist." : "That's not your game."} <button class="textbtn" data-go="#play">Back to Play</button></div>`;
      }
    }
  };
  await poll();
  // About once a second while the game is live, so the other player's moves show up as they make them.
  (async () => { while (alive) { await wait(gameOver() ? 15000 : 1000); if (alive && document.visibilityState === "visible") await poll(); } })();
  timer = window.setInterval(tickClock, 250);
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
  if (g.now) clockSkew = g.now - Date.now();
  document.title = myMove(g) ? "● Your move · Battler" : "Battler · FRC Packs";
  if (shownResult === -1) {
    // Don't replay old rounds on load; do play the current round's reveal.
    shownResult = g.status === "RESULTS" ? g.round - 1 : g.rounds.length;
    seenEmote = g.emote_seq;
  }
  showEmotes(g);
  if (prev && prev.status !== g.status) { selected = null; pickedRobot = null; }
  // During the reveal, the only thing that can change is the other player tapping Next: keep the reveal going.
  if (prev && prev.status === "RESULTS" && g.status === "RESULTS" && prev.round === g.round && g.me && prev.seats[g.me.side]?.acked === g.seats[g.me.side]?.acked) {
    const r = $("#oppReady");
    if (r) r.hidden = !g.seats[1 - g.me.side]?.acked;
    return;
  }
  if (prev && prev.status === g.status && prev.rev === g.rev) return; // only emotes changed
  if (dragging) { pendingDraw = true; return; } // don't yank a card out from under a finger
  drawGame();
  if (prev && prev.status === "PIT" && g.status === "PIT" && g.me) {
    const was = prev.seats[1 - g.me.side], now = g.seats[1 - g.me.side];
    if (was && now && !was.locked && now.locked) sfx.lock();
    else if (was && now && was.face_down.length + Number(was.lore_down) < now.face_down.length + Number(now.lore_down)) sfx.place();
  }
  if (g.status === "FINAL" && prev && prev.status !== "FINAL") loadHome().catch(() => {});
}

async function act(action: Record<string, unknown>) {
  if (!G) return;
  const status = G.status, round = G.round;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const g = await call<GameView>("POST", `/api/battler/games/${G!.id}/act`, { rev: G!.rev, action });
      $("#toast")!.hidden = true;
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
  if (!G || !G.deadline) return;
  const left = Math.max(0, G.deadline - (Date.now() + clockSkew));
  const s = Math.round(left / 1000);
  const el = $("#clock");
  if (el) {
    el.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    el.classList.toggle("low", s <= 30);
  }
  // The ring around your picture runs down with the pit timer.
  const ring = $<SVGCircleElement & HTMLElement>("#ring");
  if (ring) {
    const total = (G.status === "PIT" ? CAT.rules.pit_seconds : CAT.rules.results_seconds) * 1000;
    ring.style.strokeDashoffset = String(113 * (1 - Math.min(1, left / total)));
    ring.classList.toggle("low", s <= 30);
  }
}

const robotOf = (inst: number) => G!.robots.find((r) => r.inst === inst);
const cardOf = (inst: number) => G!.support.find((c) => c.inst === inst);

// ---------- emotes ----------

const EMOTE_TEXT: Record<string, string> = { gg: "GG!", nice: "Nice play!", oops: "Oops…", wow: "Wow!", thinking: "Hmm…", hello: "Hello!" };

function showEmotes(g: GameView) {
  if (!g.me) return;
  for (const e of g.emotes) {
    if (e.n <= seenEmote) continue;
    seenEmote = e.n;
    if (e.side === g.me.side) continue;
    if (emotesMuted()) continue;
    sfx.emote();
    popEmote("op", EMOTE_TEXT[e.id] ?? e.id);
  }
}

/** Speech bubbles still showing. Kept here so a repaint of the arena (the other player doing something) doesn't wipe
    them halfway through. */
const bubbles: { who: "op" | "me"; text: string; until: number }[] = [];

function popEmote(who: "op" | "me", text: string) {
  bubbles.push({ who, text, until: Date.now() + 2600 });
  placeBubble(who, text, true);
}

function placeBubble(who: "op" | "me", text: string, fresh: boolean) {
  const host = $(who === "op" ? ".ar-opp" : ".ar-me");
  if (!host) return;
  const b = document.createElement("div");
  b.className = `ar-bubble ${who} ${fresh ? "" : "still"}`;
  b.textContent = text;
  host.appendChild(b);
  const left = (bubbles.find((x) => x.who === who && x.text === text)?.until ?? Date.now()) - Date.now();
  setTimeout(() => b.remove(), Math.max(0, left));
}

/** Puts back the bubbles that were showing before a repaint. */
function restoreBubbles() {
  const now = Date.now();
  for (let i = bubbles.length - 1; i >= 0; i--) if (bubbles[i].until <= now) bubbles.splice(i, 1);
  for (const b of bubbles) placeBubble(b.who, b.text, false);
}

async function sendEmote(id: string) {
  if (!G) return;
  popEmote("me", EMOTE_TEXT[id]);
  try { await call("POST", `/api/battler/games/${G.id}/emote`, { emote: id }); } catch (e) { if (!(e instanceof ApiError && e.code === "too_fast")) toast(explain(e), true); }
}

// ---------- screens around the arena ----------

function drawGame() {
  const g = G!;
  document.body.classList.toggle("bt-in-arena", !!g.me && ["PIT", "RESULTS"].includes(g.status));
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
  const replay = shownResult < g.rounds.length && g.rounds.length > 0;
  switch (g.status) {
    case "OPEN": main.innerHTML = drawWaiting(g); break;
    case "DECKS": main.innerHTML = drawVersus(g) + drawDeckPick(g); break;
    case "PIT": main.innerHTML = replay ? drawArena(g, "reveal") : drawArena(g, "pit"); break;
    case "RESULTS": main.innerHTML = drawArena(g, "reveal"); break;
    case "FINAL":
      if (replay && g.outcome?.reason === "complete") { document.body.classList.add("bt-in-arena"); main.innerHTML = drawArena(g, "reveal"); break; }
      main.innerHTML = drawVersus(g) + drawFinal(g);
      if (g.outcome) (g.outcome.winner === g.me.side ? sfx.win : g.outcome.winner === null ? sfx.tick.bind(null, 3) : sfx.lose)();
      break;
    case "CANCELLED": main.innerHTML = `<div class="bt-panel center"><h2>Game called off</h2><p class="bt-dim">It ended before anyone played a round (or both players left), so nobody's rating changed.</p><button class="cta" data-go="#play">Back to Play</button></div>`; break;
  }
  bindGame();
  tickClock();
  restoreBubbles();
  if ($(".ar[data-mode='reveal']")) runReveal();
}

function drawVersus(g: GameView) {
  const me = g.seats[g.me!.side]!, op = g.seats[1 - g.me!.side]!;
  return `<div class="ar-vs"><div class="me"><span class="ar-ava">${esc(me.name.slice(0, 1).toUpperCase())}</span><b>${esc(me.name)}</b><small>${me.elo} Elo</small></div>
    <i>VS</i><div class="op"><span class="ar-ava op">${esc(op.name.slice(0, 1).toUpperCase())}</span><b>${esc(op.name)}</b><small>${op.elo} Elo</small></div></div>`;
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
  if (me.picked) return `<div class="bt-panel center"><div class="bt-spinner"></div><h2>Deck locked in</h2><p class="bt-dim">${op.picked ? "Shuffling…" : `Waiting for ${esc(op.name)} to pick a deck.`}</p><button class="textbtn" data-act="forfeit">Leave game</button></div>`;
  return `<div class="bt-panel"><h2>Pick your deck</h2><p class="bt-dim">Decks stay private. Ownership is checked again now.${op.picked ? ` ${esc(op.name)} is ready.` : ""}</p>
    <div class="bt-decklist">${HOME.decks.map((d) => `<button class="bt-deckrow ${d.problems.length ? "off" : ""}" data-deck="${d.deck.id}" ${d.problems.length ? "disabled" : ""}>
      <div class="bt-deckrow-cap t-${esc(ROBOT.get(d.deck.captain ?? 0)?.tier ?? "none")}">${d.deck.captain && ROBOT.get(d.deck.captain)?.photo ? `<img alt="" src="/photos/${d.deck.captain}.webp">` : `<span>${d.deck.captain ?? "?"}</span>`}</div>
      <div><b>${esc(d.deck.name)}</b><span class="${d.problems.length ? "warn" : "ok"}">${d.problems.length ? esc(d.problems[0]) : "Ready"}</span></div></button>`).join("") || '<div class="bt-empty">No decks.</div>'}</div>
    <button class="textbtn" data-act="forfeit">Leave game</button></div>`;
}

// ---------- the arena ----------

function stationOf(plan: Plan, inst: number) {
  return plan.stations.indexOf(inst as never) + 1;
}

/** A robot as it stands in a lane. */
function laneBot(r: RobotInst, o: { station?: number; captain?: boolean; mine?: boolean; live?: boolean; down?: number; parts?: SupportInst[]; hidden?: boolean; target?: boolean; picked?: boolean; score?: RobotScore }) {
  const st = o.station ?? 0;
  const s = r.stats;
  const backs = o.down ? Array.from({ length: o.down }, (_, i) => `<i class="ar-back ${i >= (o.down! - newDown(r.inst, o.down!)) ? "new" : ""}"></i>`).join("") : "";
  const parts = (o.parts ?? []).map((p) => `<span class="ar-part ${o.live ? "mine" : ""}" ${o.live ? `data-detach="${p.inst}"` : ""} title="${esc(p.text)}">${esc(p.name)}</span>`).join("");
  return `<div class="ar-bot t-${esc(r.tier)} ${o.target ? "target" : ""} ${o.picked ? "picked" : ""} ${o.hidden ? "hidden" : ""}" data-bot="${r.inst}" ${o.live ? `data-drop-robot="${r.inst}"` : ""}>
    <div class="ar-bot-face">
      <div class="ar-bot-pic">${r.photo ? `<img alt="" draggable="false" src="/photos/${r.team}.webp">` : `<span>#${r.team}</span>`}${o.captain ? '<i class="ar-cap" title="Alliance Captain">C</i>' : ""}</div>
      <div class="ar-bot-id"><b>${r.team}</b><span>${esc(r.name)}</span></div>
      <div class="ar-bot-stats"><span><small>A</small><b data-ph="0">${s.auto}</b></span><span><small>T</small><b data-ph="1">${s.tele}</b></span><span><small>E</small><b data-ph="2">${s.end}</b></span></div>
      ${st ? `<div class="ar-bot-rp" data-rp>RP${st} <b>${o.score ? o.score.rp_chance : s.rp[st - 1]}%</b></div>` : `<div class="ar-bot-rp bt-dim">RP ${s.rp.join("/")}</div>`}
      ${r.effect_text ? `<div class="ar-bot-fx" title="${esc(r.effect_text)}">★ ${esc(r.effect_text)}</div>` : ""}
    </div>
    <div class="ar-bot-back"></div>
    ${backs ? `<div class="ar-backs">${backs}</div>` : ""}
    ${parts ? `<div class="ar-parts">${parts}</div>` : ""}
    ${o.score ? `<div class="ar-die" data-die="${o.score.rp_roll}" data-hit="${o.score.rp_hit}" data-chance="${o.score.rp_chance}"></div>` : ""}
  </div>`;
}

/** How many of a robot's face-down cards are new since the last paint (they animate in). */
function newDown(inst: number, n: number) {
  const before = seenDown.get(inst) ?? 0;
  seenDown.set(inst, n);
  return Math.max(0, n - before);
}

function handCard(c: SupportInst, used: boolean, i: number, n: number) {
  const mid = (n - 1) / 2;
  const tilt = n > 1 ? (i - mid) * Math.min(7, 26 / n) : 0;
  // Cards overlap more the more there are, so the hand always fits the screen.
  const room = Math.min(520, innerWidth) - 32 - 56;
  const ov = n > 1 ? Math.max(14, (n * 92 - room) / (n - 1)) : 0;
  const lift = Math.abs(i - mid) * Math.abs(i - mid) * 2;
  const tags = c.kind === "PART" ? c.tags.map((t) => t.replace("_", " ")).join(" · ") : "Field · 1 round";
  return `<button type="button" class="ar-card k-${c.kind.toLowerCase()} ${selected === c.inst ? "sel" : ""} ${used ? "used" : ""}" style="--r:${tilt}deg;--y:${lift}px;--i:${i};margin-left:${i ? -ov : 0}px" data-hand="${c.inst}" aria-label="${esc(c.name)}: ${esc(c.text)}">
    <span class="ar-card-k">${c.kind}</span><b>${esc(c.name)}</b><small>${esc(tags)}</small><span class="ar-card-t">${esc(c.text)}</span>
    ${used ? `<span class="ar-card-used">${G?.me?.plan.lore === c.inst ? "Lore" : "Played"}</span>` : ""}
  </button>`;
}

function avatar(name: string, side: "me" | "op", ring = false) {
  return `<span class="ar-ava ${side}">${esc(name.slice(0, 1).toUpperCase())}${ring ? '<svg class="ar-ring" viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="18"/><circle id="ring" cx="20" cy="20" r="18"/></svg>' : ""}</span>`;
}

function drawArena(g: GameView, mode: "pit" | "reveal") {
  const side = g.me!.side, op = 1 - side;
  const me = g.seats[side]!, them = g.seats[op]!;
  const plan = g.me!.plan;
  const log = mode === "reveal" ? g.rounds[g.rounds.length - 1] : null;
  const r = log?.result;
  const score = (inst: number) => r?.robots.find((x) => x.inst === inst);
  const locked = me.locked;
  const selCard = selected !== null ? cardOf(selected) : null;
  const names = CAT.rp_names;

  // Lanes: station 1..3. Yours by your plan (or the round log); theirs only once revealed.
  const myBots = log ? log.stations[side] : plan.stations;
  const theirBots = log ? log.stations[op] : g.alliances[op];
  const partsOn = (s: number, inst: number) => (log ? log.attach[s] : s === side ? plan.attach : []).filter(([, rb]) => rb === inst).map(([p]) => cardOf(p)!).filter(Boolean);
  const downOn = (inst: number) => (mode === "pit" ? them.face_down.filter((x) => x === inst).length : 0);
  const lanes = [0, 1, 2].map((k) => {
    const mine = robotOf(myBots[k])!, theirs = robotOf(theirBots[k])!;
    return `<div class="ar-lane" data-lane="${k + 1}" ${mode === "pit" && !locked ? `data-drop-lane="${k + 1}"` : ""}>
      ${laneBot(theirs, { station: log ? k + 1 : 0, captain: theirs.inst === g.alliances[op][0], down: downOn(theirs.inst), parts: log ? partsOn(op, theirs.inst) : [], hidden: !!log, score: score(theirs.inst) })}
      <div class="ar-lane-mid"><b>S${k + 1}</b><small>${names[k]}</small><span class="ar-lane-score" data-lane-score="${k}"></span></div>
      ${laneBot(mine, { station: k + 1, captain: mine.inst === g.alliances[side][0], mine: true, live: mode === "pit" && !locked, parts: partsOn(side, mine.inst), target: mode === "pit" && !locked && selCard?.kind === "PART", picked: pickedRobot === mine.inst, score: score(mine.inst) })}
    </div>`;
  }).join("");

  const myLore = log ? (log.lore[side] !== null ? cardOf(log.lore[side]!) : null) : plan.lore !== null ? cardOf(plan.lore) : null;
  const theirLore = log && log.lore[op] !== null ? cardOf(log.lore[op]!) : null;
  const theirLoreDown = mode === "pit" && them.lore_down;
  const loreSlot = (who: "op" | "me", c: SupportInst | null | undefined, down: boolean) => `<div class="ar-lore-slot ${who} ${c ? "full" : ""} ${down ? "down" : ""} ${who === "me" && mode === "pit" && !locked && selCard?.kind === "LORE" ? "target" : ""}" ${who === "me" && mode === "pit" && !locked ? "data-drop-lore" : ""} ${log && c ? "data-flip" : ""}>
      ${c ? `<b>${esc(c.name)}</b><span>${esc(c.text)}</span>${who === "me" && mode === "pit" && !locked ? '<button class="ar-x" data-lore-clear aria-label="Take back">×</button>' : ""}` : down ? '<i class="ar-back new"></i><span>Lore played</span>' : `<span>${who === "me" ? (selCard?.kind === "LORE" ? "Drop lore here" : "Your lore") : "Their lore"}</span>`}
    </div>`;

  const planned = new Set([...plan.attach.map(([p]) => p), ...(plan.lore !== null ? [plan.lore] : [])]);
  const hand = mode === "pit" ? g.me!.hand.map((i) => cardOf(i)!).filter(Boolean) : [];
  const handVisible = hand.filter((c) => !planned.has(c.inst));
  const backs = Array.from({ length: Math.min(them.hand_count, 9) }, (_, i) => `<i class="ar-back sm" style="--i:${i}"></i>`).join("");
  const last = g.rounds[g.rounds.length - 1];
  const hiding = !!last && mode === "reveal" && lastAnimated < last.round && !skipAnim;
  const gain = (s: number) => (hiding ? last.result.match_rp[s] + last.result.bonus_rp[s] : 0);
  const dots = Array.from({ length: g.rounds_total }, (_, i) => `<i class="${i + 1 < g.round || (i + 1 === g.round && mode === "reveal") ? "done" : i + 1 === g.round ? "now" : ""}"></i>`).join("");

  return `<div class="ar" data-mode="${mode}" data-round="${log?.round ?? g.round}">
    <div class="ar-opp ${them.locked && mode === "pit" ? "ready" : ""}">
      ${avatar(them.name, "op")}
      <div class="ar-who"><b>${esc(them.name)}</b><small>${them.elo} Elo${mode === "pit" ? ` · ${them.locked ? '<em class="ok">Locked in</em>' : "in the pit…"}` : ""}</small></div>
      <div class="ar-hand-backs" aria-label="${plural(them.hand_count, "card")} in hand">${backs}</div>
      <div class="ar-rp op"><b data-rp-to="${them.rp}">${them.rp - gain(op)}</b><small>RP</small></div>
    </div>
    <div class="ar-round"><div class="bt-dots">${dots}</div><span>Round ${g.round} of ${g.rounds_total}</span>${g.deadline ? '<span class="bt-clock" id="clock"></span>' : ""}</div>
    <div class="ar-board">
      <div class="ar-lanes">${lanes}</div>
      <div class="ar-lore">${loreSlot("op", theirLore, theirLoreDown)}<div class="ar-tug" aria-hidden="true"><i class="op"></i><i class="me"></i><b class="ar-phase" id="phase"></b></div>${loreSlot("me", myLore, false)}</div>
    </div>
    ${mode === "pit" ? `
    <div class="ar-handwrap ${locked ? "locked" : ""}">
      <div class="ar-hand" id="hand">${handVisible.map((c, i) => handCard(c, false, i, handVisible.length)).join("") || `<p class="bt-dim ar-nohand">${hand.length ? "Every card is on the field." : "No cards in hand."}</p>`}</div>
      <div class="ar-pile">${me.pile_count}<small>deck</small></div>
    </div>` : `<div class="ar-verdict" id="verdict" hidden></div>`}
    <div class="ar-me ${locked && mode === "pit" ? "ready" : ""}">
      ${avatar(me.name, "me", true)}
      <div class="ar-rp me"><b data-rp-to="${me.rp}">${me.rp - gain(side)}</b><small>RP</small></div>
      <button type="button" class="ar-emote-btn" id="emoteBtn" aria-label="Quick chat">💬</button>
      ${mode === "pit"
        ? locked
          ? `<div class="ar-wait"><div class="bt-spinner small"></div>${them.locked ? "Revealing…" : `Waiting for ${esc(them.name)}`}</div>`
          : `<button type="button" class="ar-lock" data-act="lock">Lock in</button>`
        : `<div class="ar-next"><button type="button" class="ar-lock" data-act="ack" ${me.acked ? "disabled" : ""}>${me.acked ? "Waiting…" : log && log.round >= g.rounds_total ? "Final result" : "Next round"}</button><button type="button" class="textbtn" id="skipAnim">Skip</button></div>`}
      <button type="button" class="ar-menu-btn" id="arMenu" aria-label="Menu">⋯</button>
    </div>
    ${mode === "reveal" ? `<span class="bt-oppready" id="oppReady" ${them.acked ? "" : "hidden"}>${esc(them.name)} is ready for the next round</span>` : ""}
    ${mode === "pit" ? `<p class="ar-hint">${locked ? "" : selCard ? (selCard.kind === "PART" ? "Drop it on one of your robots." : "Drop it on your lore slot.") : pickedRobot ? "Tap the lane to move it to." : "Drag a card onto a robot or the lore slot. Drag a robot to another lane to change its station."}</p>` : ""}
    ${log && r?.events.length ? `<details class="bt-log ar-log"><summary>What triggered (${r.events.length})</summary><ul>${r.events.map((ev) => `<li><b>${esc(ev.source)}</b> ${esc(ev.text)}</li>`).join("")}</ul></details>` : ""}
  </div>`;
}

// ---------- pit input: drag, or tap then tap ----------

function bindGame() {
  const share = $("#shareGame");
  if (share) share.onclick = async () => {
    const url = `${location.origin}/battle.html#game/${G!.id}`;
    try {
      if (navigator.share) await navigator.share({ title: "Battler", text: "Play me in the Battler", url });
      else { await navigator.clipboard.writeText(url); toast("Invite link copied."); }
    } catch { /* closed the share sheet */ }
  };
  const emoteBtn = $("#emoteBtn");
  if (emoteBtn) emoteBtn.onclick = () => {
    const m = emotesMuted();
    openSheet(`<h3>Quick chat</h3><div class="ar-emotes">${Object.entries(EMOTE_TEXT).map(([id, t]) => `<button class="cta small ghost" data-emote="${id}">${t}</button>`).join("")}</div>
      <label class="ar-mute"><input type="checkbox" id="muteEmotes" ${m ? "checked" : ""}> Hide the other player's chat</label>`, (t) => {
      const b = t.closest<HTMLElement>("[data-emote]");
      if (b) { closeSheet(); sendEmote(b.dataset.emote!); }
    });
    $("#muteEmotes")!.addEventListener("change", (e) => { try { localStorage.setItem("bt-mute-emotes", (e.target as HTMLInputElement).checked ? "1" : "0"); } catch { /* private mode */ } });
  };
  const menu = $("#arMenu");
  if (menu) menu.onclick = () => {
    openSheet(`<h3>Game</h3><label class="ar-mute"><input type="checkbox" id="muteSfx" ${muted() ? "checked" : ""}> Mute sounds</label>
      <p class="bt-fair">Fairness code <code>${G!.seed_hash.slice(0, 16)}…</code> (the seed behind every shuffle and roll is shown when the game ends)</p>
      <button class="cta small ghost" data-forfeit>Forfeit game</button>`, (t) => {
      if (t.closest("[data-forfeit]") && confirm("Forfeit this game? It counts as a loss.")) { closeSheet(); act({ kind: "forfeit" }); }
    });
    $("#muteSfx")!.addEventListener("change", (e) => { try { localStorage.setItem("bt-mute", (e.target as HTMLInputElement).checked ? "1" : "0"); } catch { /* private mode */ } });
  };
  main.onclick = (e) => {
    const t = e.target as HTMLElement;
    const a = t.closest<HTMLElement>("[data-act]");
    if (a) {
      const k = a.dataset.act!;
      if (k === "forfeit" && !confirm(G!.status === "DECKS" ? "Leave this game? Nobody's rating changes." : "Forfeit this game? It counts as a loss.")) return;
      if (k === "lock") sfx.lock();
      if (k === "ack") { shownResult = G!.rounds.length; if (G!.status !== "RESULTS") return drawGame(); }
      return void act({ kind: k });
    }
    const deck = t.closest<HTMLElement>("[data-deck]");
    if (deck) return void act({ kind: "pick_deck", deck: deck.dataset.deck });
    if (G!.status !== "PIT" || G!.seats[G!.me!.side]?.locked) {
      const b = t.closest<HTMLElement>("[data-bot]");
      if (b && !b.classList.contains("hidden")) showRobot(robotOf(+b.dataset.bot!)!);
      return;
    }
    const det = t.closest<HTMLElement>("[data-detach]");
    if (det) { sfx.pick(); return void act({ kind: "detach", part: +det.dataset.detach! }); }
    if (t.closest("[data-lore-clear]")) { sfx.pick(); return void act({ kind: "lore", card: null }); }
    const h = t.closest<HTMLElement>("[data-hand]");
    if (h) {
      const inst = +h.dataset.hand!;
      selected = selected === inst ? null : inst;
      pickedRobot = null;
      if (selected !== null) sfx.pick();
      return drawGame();
    }
    if (t.closest("[data-drop-lore]") && selected !== null && cardOf(selected)?.kind === "LORE") return void playCard(selected, { lore: true });
    const rb = t.closest<HTMLElement>("[data-drop-robot]");
    if (rb && selected !== null && cardOf(selected)?.kind === "PART") return void playCard(selected, { robot: +rb.dataset.dropRobot! });
    const lane = t.closest<HTMLElement>("[data-drop-lane]");
    if (rb && selected === null) {
      const inst = +rb.dataset.dropRobot!;
      if (pickedRobot === null) { pickedRobot = inst; sfx.pick(); return drawGame(); }
      if (pickedRobot === inst) { pickedRobot = null; return drawGame(); }
    }
    if (lane && pickedRobot !== null) return void moveRobot(pickedRobot, +lane.dataset.dropLane!);
    const b = t.closest<HTMLElement>("[data-bot]");
    if (b) showRobot(robotOf(+b.dataset.bot!)!);
  };
  bindDrag();
}

function playCard(card: number, to: { robot?: number; lore?: boolean }) {
  selected = null;
  sfx.place();
  if (to.lore) return act({ kind: "lore", card });
  return act({ kind: "attach", part: card, robot: to.robot });
}

function moveRobot(inst: number, lane: number) {
  pickedRobot = null;
  const st = [...G!.me!.plan.stations] as [number, number, number];
  const cur = st.indexOf(inst);
  if (cur < 0 || cur === lane - 1) return drawGame();
  [st[cur], st[lane - 1]] = [st[lane - 1], st[cur]];
  sfx.place();
  return act({ kind: "stations", robots: st });
}

/** Drag a hand card onto a robot or the lore slot, or one of your robots onto another lane. Pointer events, so it works
    with a finger, a pen or a mouse; a tap without moving falls through to the tap handlers. */
function bindDrag() {
  const arena = $(".ar[data-mode='pit']");
  if (!arena || G!.seats[G!.me!.side]?.locked) return;
  arena.onpointerdown = (e: PointerEvent) => {
    const src = (e.target as HTMLElement).closest<HTMLElement>("[data-hand], .ar-lane [data-drop-robot]");
    if (!src || (e.target as HTMLElement).closest("[data-detach]")) return;
    const card = src.dataset.hand ? +src.dataset.hand : null;
    const robot = src.dataset.dropRobot ? +src.dataset.dropRobot : null;
    const kind = card !== null ? cardOf(card)?.kind : null;
    const x0 = e.clientX, y0 = e.clientY;
    let ghost: HTMLElement | null = null;
    let over: HTMLElement | null = null;
    const move = (ev: PointerEvent) => {
      if (!ghost) {
        if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 8) return;
        dragging = true;
        ghost = src.cloneNode(true) as HTMLElement;
        ghost.classList.add("ar-ghost");
        const r = src.getBoundingClientRect();
        ghost.style.width = `${r.width}px`;
        document.body.appendChild(ghost);
        src.classList.add("lifted");
        arena.classList.add(card !== null ? (kind === "PART" ? "drag-part" : "drag-lore") : "drag-bot");
        sfx.pick();
      }
      ev.preventDefault();
      ghost.style.transform = `translate(${ev.clientX - ghost.offsetWidth / 2}px, ${ev.clientY - ghost.offsetHeight * 0.6}px) rotate(-4deg)`;
      ghost.style.display = "none";
      const hit = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
      ghost.style.display = "";
      const target = card !== null
        ? kind === "PART" ? hit?.closest<HTMLElement>("[data-drop-robot]") : hit?.closest<HTMLElement>("[data-drop-lore]")
        : hit?.closest<HTMLElement>("[data-drop-lane]");
      if (target !== over) { over?.classList.remove("over"); target?.classList.add("over"); over = target ?? null; }
    };
    const up = () => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
      removeEventListener("pointercancel", up);
      if (!ghost) return; // a tap: the click handler takes it
      ghost.remove();
      src.classList.remove("lifted");
      arena.classList.remove("drag-part", "drag-lore", "drag-bot");
      dragging = false;
      // Swallow the click that follows a drag.
      const swallow = (c: Event) => { c.stopPropagation(); c.preventDefault(); };
      addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => removeEventListener("click", swallow, { capture: true }), 80);
      const target = over;
      over?.classList.remove("over");
      if (target && card !== null) playCard(card, kind === "PART" ? { robot: +target.dataset.dropRobot! } : { lore: true });
      else if (target && robot !== null) moveRobot(robot, +target.dataset.dropLane!);
      else if (pendingDraw) { pendingDraw = false; drawGame(); }
    };
    addEventListener("pointermove", move, { passive: false });
    addEventListener("pointerup", up);
    addEventListener("pointercancel", up);
  };
}

// ---------- the reveal ----------

let animToken = 0;
async function runReveal() {
  const ar = $(".ar[data-mode='reveal']");
  if (!ar) return;
  const g = G!;
  const round = +ar.dataset.round!;
  const log = g.rounds.find((r) => r.round === round);
  if (!log) return;
  const token = ++animToken;
  const alive = () => token === animToken && document.body.contains(ar);
  $("#skipAnim")?.addEventListener("click", () => { skipAnim = true; finishReveal(ar, log); });
  if (skipAnim || lastAnimated >= round) return finishReveal(ar, log);
  lastAnimated = round;
  const side = g.me!.side, op = 1 - side;
  const r = log.result;
  const phase = $("#phase")!;
  const banner = async (text: string, ms = 650) => {
    phase.textContent = text;
    phase.classList.remove("show");
    void phase.offsetWidth;
    phase.classList.add("show");
    await wait(ms);
  };
  ar.classList.add("revealing");
  // 1. Flip: lane by lane, the opponent's robot turns over, then both sides' parts.
  await banner("REVEAL", 500);
  for (let k = 0; k < 3; k++) {
    if (!alive()) return;
    ar.querySelectorAll<HTMLElement>(`.ar-lane[data-lane="${k + 1}"] .ar-bot.hidden`).forEach((b) => b.classList.remove("hidden"));
    ar.querySelectorAll<HTMLElement>(`.ar-lane[data-lane="${k + 1}"] .ar-part`).forEach((p) => p.classList.add("flip"));
    sfx.flip();
    await wait(380);
  }
  // 2. Lore.
  const lores = ar.querySelectorAll<HTMLElement>("[data-flip]");
  if (lores.length) {
    await banner("LORE", 400);
    for (const l of lores) { if (!alive()) return; l.classList.add("flip"); sfx.flip(); await wait(450); }
  }
  // 3. Auto, Tele, End: each robot's points pop and pour into the tug-of-war bar.
  const totals = [0, 0];
  const tug = (mine: number, theirs: number) => {
    const sum = Math.max(1, mine + theirs);
    ar.style.setProperty("--tug", `${(mine / sum) * 100}%`);
  };
  tug(1, 1);
  const PH = ["AUTO", "TELE", "END"];
  for (let k = 0; k < 3; k++) {
    if (!alive()) return;
    await banner(PH[k], 450);
    for (let lane = 0; lane < 3; lane++) {
      for (const s of [op, side]) {
        const inst = log.stations[s][lane];
        const sc = r.robots.find((x) => x.inst === inst)!;
        const bot = ar.querySelector<HTMLElement>(`.ar-bot[data-bot="${inst}"]`);
        const num = bot?.querySelector<HTMLElement>(`[data-ph="${k}"]`);
        if (num) {
          num.textContent = String(sc.points[k]);
          num.parentElement!.classList.add("lit");
          if (sc.points[k] !== sc.base[k]) num.parentElement!.classList.add(sc.points[k] > sc.base[k] ? "up" : "down");
        }
        if (bot) floatText(bot, `+${sc.points[k]}`, s === side ? "me" : "op");
        if (sc.points[k] >= sc.base[k] * 1.5 && sc.points[k] - sc.base[k] >= 10) { ar.classList.add("shake"); sfx.boom(); setTimeout(() => ar.classList.remove("shake"), 400); } else sfx.tick(lane + k);
        totals[s === side ? 0 : 1] += sc.points[k];
        tug(totals[0], totals[1]);
        const ls = ar.querySelector<HTMLElement>(`[data-lane-score="${lane}"]`);
        if (ls) ls.innerHTML = `<i class="op">${laneSum(log, op, lane, k)}</i><i class="me">${laneSum(log, side, lane, k)}</i>`;
        await wait(170);
      }
    }
    await wait(250);
  }
  // 4. The round.
  if (!alive()) return;
  const won = r.winner === null ? "tie" : r.winner === side ? "win" : "loss";
  const v = $("#verdict")!;
  v.hidden = false;
  v.className = `ar-verdict ${won} show`;
  v.innerHTML = `<b>${won === "win" ? "Round won" : won === "loss" ? "Round lost" : "Tied round"}</b><span>${r.totals[side]} – ${r.totals[op]} · +${r.match_rp[side]} RP</span>`;
  (won === "win" ? sfx.win : won === "loss" ? sfx.lose : () => sfx.tick(4))();
  bumpRp(ar, r.match_rp[side], r.match_rp[op]);
  await wait(1100);
  // 5. One RP die per robot, at its station's chance.
  await banner("RP ROLLS", 450);
  for (const s of [side, op]) {
    for (const inst of log.stations[s]) {
      if (!alive()) return;
      const die = ar.querySelector<HTMLElement>(`.ar-bot[data-bot="${inst}"] .ar-die`);
      if (!die) continue;
      die.classList.add("rolling");
      for (let i = 0; i < 6; i++) { die.textContent = String(Math.floor(Math.random() * 100)); sfx.dice(); await wait(55); }
      die.classList.remove("rolling");
      const hit = die.dataset.hit === "true";
      die.textContent = hit ? "+1" : die.dataset.die!;
      die.classList.add(hit ? "hit" : "miss");
      (hit ? sfx.hit : sfx.miss)();
      if (hit) floatText(die.parentElement!, "+1 RP", s === side ? "me" : "op");
      await wait(260);
    }
  }
  bumpRp(ar, r.bonus_rp[side], r.bonus_rp[op]);
  v.querySelector("span")!.textContent = `${r.totals[side]} – ${r.totals[op]} · +${r.match_rp[side] + r.bonus_rp[side]} RP for you, +${r.match_rp[op] + r.bonus_rp[op]} for them`;
  finishReveal(ar, log);
}

function laneSum(log: RoundLog, s: number, lane: number, upto: number) {
  const sc = log.result.robots.find((x) => x.inst === log.stations[s][lane])!;
  return sc.points.slice(0, upto + 1).reduce((a, b) => a + b, 0);
}

function bumpRp(ar: HTMLElement, mine: number, theirs: number) {
  const a = ar.querySelector<HTMLElement>(".ar-rp.me b"), b = ar.querySelector<HTMLElement>(".ar-rp.op b");
  if (!a || !b) return;
  if (mine) { countUp(a, +a.textContent! + mine); a.parentElement!.classList.add("bump"); }
  if (theirs) { countUp(b, +b.textContent! + theirs); b.parentElement!.classList.add("bump"); }
}

function floatText(host: HTMLElement, text: string, who: "me" | "op") {
  const f = document.createElement("span");
  f.className = `ar-float ${who}`;
  f.textContent = text;
  host.appendChild(f);
  setTimeout(() => f.remove(), 900);
}

function finishReveal(ar: HTMLElement, log: RoundLog) {
  animToken++;
  const g = G!;
  const side = g.me!.side, op = 1 - side;
  const r = log.result;
  ar.classList.remove("revealing");
  ar.classList.add("revealed");
  ar.querySelectorAll(".ar-bot.hidden").forEach((b) => b.classList.remove("hidden"));
  ar.querySelectorAll(".ar-part").forEach((p) => p.classList.add("flip"));
  ar.querySelectorAll("[data-flip]").forEach((l) => l.classList.add("flip"));
  for (const sc of r.robots) {
    const bot = ar.querySelector<HTMLElement>(`.ar-bot[data-bot="${sc.inst}"]`);
    if (!bot) continue;
    sc.points.forEach((p, k) => {
      const num = bot.querySelector<HTMLElement>(`[data-ph="${k}"]`);
      if (!num) return;
      num.textContent = String(p);
      num.parentElement!.classList.add("lit");
      if (p !== sc.base[k]) num.parentElement!.classList.add(p > sc.base[k] ? "up" : "down");
    });
    const die = bot.querySelector<HTMLElement>(".ar-die");
    if (die) { die.textContent = sc.rp_hit ? "+1" : String(sc.rp_roll); die.classList.add(sc.rp_hit ? "hit" : "miss"); }
  }
  for (let lane = 0; lane < 3; lane++) {
    const ls = ar.querySelector<HTMLElement>(`[data-lane-score="${lane}"]`);
    if (ls) ls.innerHTML = `<i class="op">${laneSum(log, op, lane, 2)}</i><i class="me">${laneSum(log, side, lane, 2)}</i>`;
  }
  const sum = Math.max(1, r.totals[side] + r.totals[op]);
  ar.style.setProperty("--tug", `${(r.totals[side] / sum) * 100}%`);
  const v = $("#verdict");
  if (v) {
    const won = r.winner === null ? "tie" : r.winner === side ? "win" : "loss";
    v.hidden = false;
    v.className = `ar-verdict ${won} show`;
    v.innerHTML = `<b>${won === "win" ? "Round won" : won === "loss" ? "Round lost" : "Tied round"}</b><span>${r.totals[side]} – ${r.totals[op]} · +${r.match_rp[side] + r.bonus_rp[side]} RP for you, +${r.match_rp[op] + r.bonus_rp[op]} for them</span>`;
  }
  document.querySelectorAll<HTMLElement>("[data-rp-to]").forEach((b) => (b.textContent = b.dataset.rpTo!));
  $("#phase")?.classList.remove("show");
}

function countUp(el: HTMLElement, to: number) {
  const from = +(el.textContent || 0);
  const start = performance.now();
  const step = (t: number) => {
    const k = Math.min(1, (t - start) / 600);
    el.textContent = String(Math.round(from + (to - from) * (1 - Math.pow(1 - k, 3))));
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
  let station = 1, captain = false, previewPart = "";
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
      const out = await call<{ valid: boolean; error: string | null; text: string; with: { totals: [number, number]; robots: RobotScore[] }; without: { totals: [number, number]; robots: RobotScore[] } }>("POST", "/api/battler/admin/preview", { team: r.team, effects: fx, station, captain, seed: 7, parts: previewPart ? [previewPart, previewPart] : [] });
      if (my !== pv) return;
      const w = out.with.robots.find((x) => x.inst === 1)!, wo = out.without.robots.find((x) => x.inst === 1)!;
      $("#fxText")!.innerHTML = out.valid ? `<b>${esc(out.text)}</b>` : `<span class="warn">${esc(out.error)}</span>`;
      $("#fxSim")!.innerHTML = out.valid ? `Sample round (station ${station}${captain ? ", captain" : ""}${previewPart ? `, two ${esc(SUPPORT.get(previewPart)?.name)} attached` : ""}, vs average robots): this robot scores <b>${w.points.join(" / ")}</b> (without the effect ${wo.points.join(" / ")}); RP chance ${w.rp_chance}% (was ${wo.rp_chance}%). Alliance ${out.with.totals[0]} vs ${out.with.totals[1]} (was ${out.without.totals[0]}).` : "";
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
        <div class="bt-fxsimopts"><label>Preview in station <select id="fxSt"><option>1</option><option>2</option><option>3</option></select></label><label><input type="checkbox" id="fxCap"> as captain</label>
          <label>with parts <select id="fxPart"><option value="">none</option>${CAT.support.filter((c) => c.kind === "PART").map((c) => `<option value="${c.id}">${esc(c.name)} (${c.tags.join(" ")})</option>`).join("")}</select></label></div></div>
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
  $("#fxPart")!.addEventListener("change", (e) => { previewPart = (e.target as HTMLSelectElement).value; preview(); });
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
