// Tripwire, the anticheat, in the admin panel (computers only): a suite with its own tabs.
// - Overview: what Tripwire is doing right now, in numbers.
// - Scan: every detection check over the whole game, suspects ranked with their evidence.
// - Watchlist: every flagged player, what their flag does (shadow: silent and watched; paused: no trading or wagers),
//   and what they've done since.
// - Canaries: calls to endpoints the app no longer makes.
// - Actions: every flag, clear, reversal and settings change.
// - Settings: shadow flags on or off.
// The server does all of it; this page only shows what it returns.

import {
  api, explain, type TripwireAction, type TripwireMode, type TripwireOverview, type TripwireReport, type TripwireSuspect, type TripwireWatched,
} from "./api";

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
const when = (ms: number) => new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;
/** A datetime-local value for a moment (local time). */
const local = (ms: number) => new Date(ms - new Date(ms).getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
const btn = (label: string, cls = "chip") => h("button", { type: "button", class: cls }, label);

const CHECK: Record<string, string> = {
  supply: "Supply", luck: "Luck", funnel: "Funnel", wager: "Thrown wager", pacing: "Pacing", canary: "Canary", integrity: "Integrity",
};
const MODE: Record<TripwireMode, string> = { shadow: "Shadow", paused: "Paused" };

type Say = (text: string, bad?: boolean) => void;
type Tab = "overview" | "scan" | "watch" | "canaries" | "log" | "settings";
const TABS: [Tab, string][] = [["overview", "Overview"], ["scan", "Scan"], ["watch", "Watchlist"], ["canaries", "Canaries"], ["log", "Actions"], ["settings", "Settings"]];

export function setupTripwire(say: Say) {
  const body = $("#twBody"), tabsEl = $("#twTabs"), count = $("#twCount");
  const fail = (e: unknown) => say(explain(e), true);
  let tab: Tab = "overview";
  let ov: TripwireOverview | null = null;
  let report: TripwireReport | null = null;
  let log: TripwireAction[] = [];

  const tabBtns = TABS.map(([t, label]) => {
    const b = h("button", { type: "button", role: "tab", "aria-selected": String(t === tab) }, label);
    b.onclick = () => { tab = t; paint(); };
    return b;
  });
  tabsEl.replaceChildren(...tabBtns);

  async function load() {
    try {
      [ov, log] = await Promise.all([api.admin.tripwireOverview(), api.admin.tripwireLog()]);
      paint();
    } catch (e) { fail(e); }
  }

  async function scan(b?: HTMLButtonElement) {
    if (b) b.disabled = true;
    try {
      report = await api.admin.tripwireScan();
      tab = "scan";
      paint();
    } catch (e) { fail(e); } finally { if (b) b.disabled = false; }
  }

  /** Runs an action, says so, and reloads what the suite shows. */
  async function act(b: HTMLButtonElement, run: () => Promise<unknown>, done: string) {
    b.disabled = true;
    try {
      await run();
      say(done);
      await load();
      if (report) report = await api.admin.tripwireScan();
      paint();
    } catch (e) { fail(e); } finally { b.disabled = false; }
  }

  function paint() {
    tabBtns.forEach((b, i) => b.setAttribute("aria-selected", String(TABS[i][0] === tab)));
    if (ov) count.textContent = `${plural(ov.players, "player")} · shadow flags ${ov.config.shadowDefault ? "on" : "off"}`;
    if (!ov) { body.replaceChildren(h("p", { class: "meta" }, "Loading…")); return; }
    body.replaceChildren(...({ overview, scan: scanTab, watch: watchTab, canaries: canaryTab, log: logTab, settings: settingsTab })[tab]());
  }

  // ---------- overview ----------
  function overview(): Node[] {
    const o = ov!;
    const shadow = o.watchlist.filter((w) => w.mode === "shadow").length, paused = o.watchlist.length - shadow;
    const day = Date.now() - 86_400_000;
    const stat = (n: string | number, label: string, warn = false) => h("div", { class: cls("tw-stat", warn && "warn") }, h("b", {}, String(n)), h("span", {}, label));
    const run = btn("Run a scan", "cta small");
    run.onclick = () => scan(run);
    return [
      h("p", { class: "meta" }, "Tripwire stops what the rules can stop, watches what they can't, and shows you the evidence. Nothing happens to a player until you act, except one thing: a dupe big enough to be one (over 60 packs in an hour) pauses their trading on its own."),
      h("div", { class: "tw-stats" },
        stat(o.players, "players"),
        stat(shadow, "watched (shadow)", shadow > 0),
        stat(paused, "trading paused", paused > 0),
        stat(o.canaries.filter((c) => c.at > day).length, "canary hits today", o.canaries.some((c) => c.at > day)),
        stat(report ? report.suspects.filter((s) => s.findings.length).length : "–", report ? `suspects (${when(report.at)})` : "suspects (no scan yet)"),
      ),
      h("div", { class: "mrow" }, run, h("span", { class: "meta" }, `Shadow flags are ${o.config.shadowDefault ? "on: flagged players notice nothing" : "off: flags pause trading"}.`)),
      ...(o.watchlist.length ? [h("h3", { class: "tw-h" }, "Latest on the watchlist"), ...o.watchlist.slice(0, 3).map(watchRow)] : []),
    ];
  }

  // ---------- scan ----------
  function scanTab(): Node[] {
    const run = btn(report ? "Scan again" : "Run Tripwire", "cta small");
    run.onclick = () => scan(run);
    const head = [
      h("p", { class: "meta" }, "Looks over the whole game for what got past the rules: packs or parts from a source that couldn't pay them, luck far beyond each pack's odds, value moving one way between linked accounts, thrown wagers, inhuman pacing, and canary calls. It only reports."),
      h("div", { class: "mrow" }, run, report ? h("span", { class: "meta" }, `${plural(report.players, "player")} checked · ${when(report.at)}`) : null),
    ];
    if (!report) return head;
    const notes = report.notes.map((n) => h("p", { class: "meta" }, n));
    if (!report.suspects.length) return [...head, ...notes, h("p", { class: "tw-clean" }, "Nothing found. Everyone's packs, parts and luck add up.")];
    return [...head, ...notes, ...report.suspects.map(suspectRow)];
  }

  function suspectRow(s: TripwireSuspect): HTMLElement {
    const name = s.username ?? "a guest";
    const level = s.score >= 80 ? "high" : s.score >= 50 ? "mid" : "low";
    const mode = s.flagged ? (s.flagMode ?? (ov!.config.shadowDefault ? "shadow" : "paused")) : null;
    const head = h("div", { class: "tw-head" },
      h("span", { class: `tw-score ${level}` }, String(s.score)),
      h("b", {}, name),
      mode ? h("span", { class: `badge ${mode === "paused" ? "off" : "warn"}` }, MODE[mode]) : null,
      s.disabled ? h("span", { class: "badge off" }, "Disabled") : null,
    );
    const findings = s.findings.map((f) => h("div", { class: "tw-find" },
      h("span", { class: "tw-check" }, `${CHECK[f.check] ?? f.check} · ${f.score}`),
      h("ul", {}, ...f.evidence.map((e) => h("li", {}, e))),
    ));
    if (s.flagged) findings.unshift(h("p", { class: "meta" }, `Flagged: ${s.flagged}`));
    const why = s.findings.map((f) => CHECK[f.check] ?? f.check).join(", ") || "flagged by an admin";
    return h("div", { class: "row tw-row" }, head, ...findings,
      h("div", { class: "mrow" }, ...flagButtons(s.id, name, mode as TripwireMode | null, why), banButton(s.id, name, s.disabled)),
      ...reverseRow(s.id, name),
    );
  }

  // ---------- watchlist ----------
  function watchTab(): Node[] {
    const o = ov!;
    return [
      h("p", { class: "meta" }, "Every flagged player. Shadow: they notice nothing, and every trade and wager they make shows up here. Paused: no trading or wagers (packs still open)."),
      ...(o.watchlist.length ? o.watchlist.map(watchRow) : [h("p", { class: "tw-clean" }, "Nobody is flagged.")]),
    ];
  }

  function watchRow(w: TripwireWatched): HTMLElement {
    const name = w.username ?? "a guest";
    return h("div", { class: "row tw-row" },
      h("div", { class: "tw-head" },
        h("b", {}, name),
        h("span", { class: `badge ${w.mode === "paused" ? "off" : "warn"}` }, MODE[w.mode]),
        w.modeSet ? null : h("span", { class: "meta" }, "(from the settings)"),
        w.disabled ? h("span", { class: "badge off" }, "Disabled") : null,
        w.flaggedAt ? h("span", { class: "meta" }, `since ${when(w.flaggedAt)}`) : null,
      ),
      h("p", { class: "meta" }, w.reason),
      w.activity.length
        ? h("ul", { class: "tw-activity" }, ...w.activity.map((a) => h("li", {}, h("span", { class: "meta" }, when(a.at)), " ", a.what)))
        : h("p", { class: "meta" }, "No trades or wagers since."),
      h("div", { class: "mrow" }, ...flagButtons(w.id, name, w.mode, w.reason), banButton(w.id, name, w.disabled)),
      ...reverseRow(w.id, name),
    );
  }

  // ---------- canaries ----------
  function canaryTab(): Node[] {
    const o = ov!;
    return [
      h("p", { class: "meta" }, "Endpoints the app doesn't call any more: /api/hand (picking up is opening now) and /api/craft/mythic (Mythic packs are gone). They still answer \"not found\", but every call is logged here. Right after an update, an app left open since before it can call them too; after that, it's a script."),
      ...(o.canaries.length
        ? [h("div", { class: "list" }, ...o.canaries.map((c) => h("div", { class: "row" },
            h("div", { class: "meta" }, h("b", {}, c.path), h("span", {}, c.username ?? "not signed in"), h("span", {}, c.visitor), h("span", {}, when(c.at))))))]
        : [h("p", { class: "tw-clean" }, "No canary calls in the last 30 days.")]),
    ];
  }

  // ---------- actions ----------
  function logTab(): Node[] {
    return [
      h("p", { class: "meta" }, "Every flag, clear, reversal and settings change, newest first."),
      ...(log.length
        ? log.map((a) => h("div", { class: "row" }, h("div", { class: "meta" }, h("b", {}, `${a.action} · ${a.user}`), h("span", {}, `by ${a.admin}`), h("span", {}, when(a.at))), a.detail ? h("p", { class: "meta" }, a.detail) : null))
        : [h("p", { class: "meta" }, "No actions yet.")]),
    ];
  }

  // ---------- settings ----------
  function settingsTab(): Node[] {
    const c = ov!.config;
    const box = h("input", { type: "checkbox", id: "twShadow" }) as HTMLInputElement;
    box.checked = c.shadowDefault;
    box.onchange = async () => {
      box.disabled = true;
      try {
        await api.admin.tripwireConfig({ ...c, shadowDefault: box.checked });
        say(box.checked ? "Shadow flags on: flagged players notice nothing." : "Shadow flags off: flags pause trading and wagers.");
        await load();
      } catch (e) { fail(e); box.checked = !box.checked; } finally { box.disabled = false; }
    };
    return [
      h("label", { class: "tw-setting", for: "twShadow" }, box,
        h("span", {}, h("b", {}, "Shadow flags"),
          h("small", {}, "On: a flag is silent. The player can keep trading and wagering, and every trade and wager they make goes on the watchlist, so they never learn what tipped Tripwire off. Off: a flag pauses trading and wagers. Either way, a flag set by hand can choose its own mode, and a big dupe (over 60 packs in an hour) always pauses."))),
      h("p", { class: "meta" }, "Fixed limits: the intake alarm flags at more than 30 packs in an hour and pauses at more than 60. Watch logs and canary calls are kept for 30 days."),
    ];
  }

  // ---------- shared controls ----------
  function flagButtons(id: string, name: string, mode: TripwireMode | null, why: string): HTMLButtonElement[] {
    const out: HTMLButtonElement[] = [];
    if (mode !== "shadow") {
      const b = btn(mode ? "Make shadow" : "Shadow flag");
      b.onclick = () => act(b, () => api.admin.tripwireFlag(id, mode ? "" : why, "shadow"), `${name} is watched: they won't notice.`);
      out.push(b);
    }
    if (mode !== "paused") {
      const b = btn(mode ? "Pause trading" : "Flag and pause");
      b.onclick = () => act(b, () => api.admin.tripwireFlag(id, mode ? "" : why, "paused"), `${name} can't trade or wager now.`);
      out.push(b);
    }
    if (mode) {
      const b = btn("Clear flag");
      b.onclick = () => act(b, () => api.admin.tripwireClear(id, "cleared from Tripwire"), `${name} isn't flagged any more.`);
      out.push(b);
    }
    return out;
  }

  function banButton(id: string, name: string, disabled: boolean): HTMLButtonElement {
    const b = btn(disabled ? "Enable account" : "Disable account", "chip bad");
    b.onclick = () => act(b, () => api.admin.setDisabled(id, !disabled), disabled ? `${name} can sign in again.` : `${name} is disabled and signed out.`);
    return b;
  }

  /** Take back what came in during a window: previewed first, applied on a second tap. */
  function reverseRow(id: string, name: string): HTMLElement[] {
    const out = h("div", { class: "result", hidden: true });
    const now = Date.now();
    const from = h("input", { class: "input", type: "datetime-local", value: local(now - 86_400_000), "aria-label": "From" });
    const to = h("input", { class: "input", type: "datetime-local", value: local(now), "aria-label": "To" });
    const range = () => [new Date(from.value).getTime(), new Date(to.value).getTime()] as const;
    const preview = btn("Preview reversal");
    const apply = h("button", { type: "button", class: "chip bad", disabled: true }, "Take it back");
    preview.onclick = async () => {
      const [a, b] = range();
      preview.disabled = true;
      try {
        const r = await api.admin.tripwireReverse(id, a, b, false);
        out.replaceChildren(
          h("span", {}, `Came in: ${r.packs} packs, ${r.boosted} boosted, ${r.parts} parts, ${plural(r.cards.length, "card")}.`),
          h("span", {}, `Would take back: ${r.tookPacks} packs, ${r.tookBoosted} boosted, ${r.tookParts} parts, ${plural(r.tookCards.length, "card")}.`),
          ...(r.gone.length ? [h("small", {}, `Already gone from their binder (traded, staked or scrapped): ${r.gone.join(", ")}`)] : []),
        );
        out.hidden = false;
        apply.disabled = false;
      } catch (e) { fail(e); } finally { preview.disabled = false; }
    };
    let armed = false;
    apply.onclick = async () => {
      if (!armed) { armed = true; apply.textContent = "Tap again to take it back"; setTimeout(() => { armed = false; apply.textContent = "Take it back"; }, 3500); return; }
      armed = false;
      const [a, b] = range();
      await act(apply, () => api.admin.tripwireReverse(id, a, b, true), `Took back what ${name} got in that window.`);
    };
    return [h("div", { class: "mrow" }, h("span", {}, "Reverse from"), from, h("span", {}, "to"), to, preview, apply), out];
  }

  paint();
  void load();
}

function cls(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(" ");
}
