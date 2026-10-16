// The rarity editor in the admin panel (computers only): see every team's rarity, change them one by one or paste a
// Mythic list, check what a change would do, and apply it for everyone without a deploy. Players' cards follow the next
// time they open the game.

import { api, explain, type TierName, type TierOverview, type TierPreview } from "./api";

const TIERS: TierName[] = ["mythic", "legendary", "rare", "uncommon", "common"];
const LABEL: Record<TierName, string> = { mythic: "Mythic", legendary: "Legendary", rare: "Rare", uncommon: "Uncommon", common: "Common" };
const SHOWN = 120;

type Kid = Node | string | null | undefined | false;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string | boolean> = {}, ...kids: Kid[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === true) e.setAttribute(k, "");
    else if (v !== false) e.setAttribute(k, v);
  }
  for (const kid of kids) if (kid) e.append(kid);
  return e;
}
const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector<T>(s)!;
const nodes = (...k: Kid[]): Node[] => k.filter((x): x is Node | string => !!x).map((x) => (typeof x === "string" ? document.createTextNode(x) : x));
const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

export function setupRarities(say: (text: string, bad?: boolean) => void) {
  let ov: TierOverview | null = null;
  /** The rarity each team should have (starts as the current one). */
  let want = new Map<number, TierName>();
  let timer = 0;
  let seq = 0;
  let blocked = false;

  const search = $<HTMLInputElement>("#tierQ");
  const filter = $<HTMLSelectElement>("#tierF");
  const list = $("#tierList");
  const counts = $("#tierCounts");
  const preview = $("#tierPreview");
  const apply = $<HTMLButtonElement>("#tierApply");
  const parts = $<HTMLInputElement>("#tierParts");
  const note = $<HTMLInputElement>("#tierNote");
  const bulk = $<HTMLTextAreaElement>("#tierBulk");

  filter.replaceChildren(h("option", { value: "" }, "All rarities"), ...TIERS.map((t) => h("option", { value: t }, LABEL[t])));

  function changed() {
    return ov ? ov.teams.filter((t) => want.get(t.num) !== t.tier) : [];
  }

  async function load() {
    try {
      ov = await api.admin.tiers();
      want = new Map(ov.teams.map((t) => [t.num, t.tier]));
      parts.value = String(ov.parts);
      note.value = ov.note;
      paint();
      checkPreview();
    } catch (e) {
      list.replaceChildren(h("p", { class: "empty" }, explain(e)));
    }
  }

  function paintCounts() {
    if (!ov) return;
    const n = Object.fromEntries(TIERS.map((t) => [t, 0])) as Record<TierName, number>;
    for (const t of ov.teams) n[want.get(t.num) ?? t.tier]++;
    counts.replaceChildren(...TIERS.map((t) => h("span", { class: "tcount t-" + t }, `${LABEL[t]} ${n[t]}`)));
  }

  function row(t: TierOverview["teams"][number]) {
    const now = want.get(t.num) ?? t.tier;
    const sel = h("select", { class: "input tsel t-" + now, "aria-label": `Rarity of team ${t.num}` }, ...TIERS.map((x) => h("option", { value: x, selected: x === now }, LABEL[x])));
    sel.onchange = () => {
      want.set(t.num, sel.value as TierName);
      paint();
      queuePreview();
    };
    const notes = [
      now !== t.tier && h("span", { class: "tchg" }, `was ${LABEL[t.tier]}`),
      t.base !== t.tier && h("span", { class: "tbase" }, `file says ${LABEL[t.base]}`),
    ];
    return h("div", { class: "trow" + (now !== t.tier ? " changed" : "") }, h("b", {}, String(t.num)), h("span", { class: "tname" }, t.name), h("small", {}, t.div), ...notes, sel);
  }

  function paint() {
    if (!ov) return;
    paintCounts();
    const q = search.value.trim().toLowerCase();
    const f = filter.value;
    const all = ov.teams.filter((t) => {
      if (f && (want.get(t.num) ?? t.tier) !== f) return false;
      return !q || String(t.num).startsWith(q) || t.name.toLowerCase().includes(q);
    });
    const shown = all.slice(0, SHOWN);
    list.replaceChildren(
      ...nodes(
        ...shown.map(row),
        all.length > SHOWN && h("p", { class: "empty" }, `Showing ${SHOWN} of ${all.length}. Search to narrow it down.`),
        !all.length && h("p", { class: "empty" }, "No teams match."),
      ),
    );
  }

  function queuePreview() {
    clearTimeout(timer);
    apply.disabled = true;
    timer = window.setTimeout(checkPreview, 250);
  }

  async function checkPreview() {
    if (!ov) return;
    const mine = ++seq;
    const diff = changed();
    if (!diff.length) {
      preview.replaceChildren(h("p", { class: "empty" }, "No changes yet. Change a team above, or paste a Mythic list."));
      apply.disabled = true;
      blocked = false;
      return;
    }
    let p: TierPreview;
    try {
      p = await api.admin.previewTiers(wanted());
    } catch (e) {
      preview.replaceChildren(h("p", { class: "msg" }, explain(e)));
      return;
    }
    if (mine !== seq) return;
    blocked = !!p.problem;
    const pay = Number(parts.value) || 0;
    preview.replaceChildren(
      ...nodes(
      ...p.changes.map((c) => h("div", { class: "tpv" }, h("b", {}, String(c.num)), ` ${c.name}: ${LABEL[c.from]} `, h("span", { class: "tchg" }, `→ ${LABEL[c.to]}`), h("small", {}, `  ${plural(c.copies, "copy", "copies")} in the game`))),
      p.problem && h("p", { class: "msg" }, "Can't apply: " + p.problem),
      !p.problem && h("p", { class: "hint-txt" }, p.mythicCopiesLost
        ? `${plural(p.mythicCopiesLost, "Mythic copy", "Mythic copies")} will stop being Mythic. Each player who owns one gets ${pay.toLocaleString()} parts and the note below (set parts to 0 to pay nobody).`
        : "Nobody loses a Mythic, so nobody is paid."),
      ),
    );
    apply.disabled = !!p.problem;
  }

  /** What to send: every team whose rarity differs from the recipe file. */
  function wanted() {
    const tiers: Record<string, TierName> = {};
    if (ov) for (const t of ov.teams) if ((want.get(t.num) ?? t.tier) !== t.base) tiers[String(t.num)] = want.get(t.num)!;
    return { tiers };
  }

  search.oninput = paint;
  filter.onchange = paint;
  parts.oninput = queuePreview;

  $("#tierBulkBtn").onclick = () => {
    if (!ov) return;
    const mythics = new Set(bulk.value.split(/[^0-9]+/).filter(Boolean).map(Number));
    const unknown = [...mythics].filter((n) => !ov!.teams.some((t) => t.num === n));
    if (unknown.length) return say(`Not in this pack: ${unknown.join(", ")}`, true);
    for (const t of ov.teams) {
      const cur = want.get(t.num) ?? t.tier;
      if (mythics.has(t.num)) want.set(t.num, "mythic");
      else if (cur === "mythic") want.set(t.num, "legendary");
    }
    paint();
    queuePreview();
  };
  $("#tierFill").onclick = () => {
    if (!ov) return;
    bulk.value = ov.teams.filter((t) => (want.get(t.num) ?? t.tier) === "mythic").map((t) => t.num).join(", ");
  };
  $("#tierReset").onclick = () => {
    if (!ov) return;
    want = new Map(ov.teams.map((t) => [t.num, t.tier]));
    paint();
    checkPreview();
  };

  apply.onclick = async () => {
    if (blocked || !ov) return;
    if (!apply.classList.contains("armed")) {
      apply.classList.add("armed");
      apply.textContent = "Press again to apply to everyone";
      setTimeout(() => {
        apply.classList.remove("armed");
        apply.textContent = "Apply to everyone";
      }, 4000);
      return;
    }
    apply.disabled = true;
    try {
      await api.admin.applyTiers({ ...wanted(), parts: Math.max(0, Math.floor(Number(parts.value) || 0)), note: note.value.trim() });
      say("Applied. Players are updated as they open the game.");
      await load();
    } catch (e) {
      say(explain(e), true);
      apply.disabled = false;
    } finally {
      apply.classList.remove("armed");
      apply.textContent = "Apply to everyone";
    }
  };

  load();
}
