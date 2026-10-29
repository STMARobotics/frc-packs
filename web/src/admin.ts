// The admin panel: make and share invite codes, and manage accounts. The server checks that the visitor is the admin
// account for every request; this page only shows what it returns.

import "./style.css";
import "./admin.css";
import { setupRarities } from "./rarities";
import { api, ApiError, explain, type AdminUser, type Feedback, type FeedbackStatus, type Invite, type Report, type Rules } from "./api";

type Kid = Node | string | null | undefined | false;

/** Builds an element. Text always goes in as text, never HTML, so notes and names can't inject markup. */
function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean> = {},
  ...kids: Kid[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === true) e.setAttribute(k, "");
    else if (v !== false) e.setAttribute(k, v);
  }
  for (const kid of kids) if (kid) e.append(kid);
  return e;
}

function button(label: string, onClick: (b: HTMLButtonElement) => void, cls = "chip"): HTMLButtonElement {
  const b = h("button", { type: "button", class: cls }, label);
  b.onclick = () => onClick(b);
  return b;
}

const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector<T>(s)!;
const day = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
const when = (ms: number) =>
  new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

async function copy(text: string, b: HTMLButtonElement) {
  const was = b.textContent;
  try {
    await navigator.clipboard.writeText(text);
    b.textContent = "Copied";
  } catch {
    window.prompt("Copy this:", text);
  }
  setTimeout(() => (b.textContent = was), 1400);
}

/** A button that asks for a second tap before doing something that can't be undone. */
function confirmButton(label: string, armed: string, run: () => Promise<void>, cls = "chip"): HTMLButtonElement {
  let timer = 0;
  return button(
    label,
    async (b) => {
      if (!b.classList.contains("armed")) {
        b.classList.add("armed");
        b.textContent = armed;
        timer = window.setTimeout(() => {
          b.classList.remove("armed");
          b.textContent = label;
        }, 3500);
        return;
      }
      clearTimeout(timer);
      b.disabled = true;
      try {
        await run();
      } finally {
        b.disabled = false;
        b.classList.remove("armed");
        b.textContent = label;
      }
    },
    cls,
  );
}

const toast = h("div", { class: "toast", role: "status", "aria-live": "polite" });
document.body.append(toast);
let toastTimer = 0;
function say(text: string, bad = false) {
  toast.textContent = text;
  toast.classList.toggle("bad", bad);
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("show"), 3200);
}
const fail = (e: unknown) => say(explain(e), true);

// ---------- free packs ----------

const rulesForm = $<HTMLFormElement>("#rulesForm");
const field = (n: string) => rulesForm.elements.namedItem(n) as HTMLInputElement;

/** Reads the form. Hours are shown to people; the server keeps whole minutes. */
function readRules(): Rules | null {
  const hours = Number(field("hours").value);
  const r = {
    claimMinutes: Math.round(hours * 60),
    claimPacks: Number(field("claimPacks").value),
    bank: Number(field("bank").value),
    startPacks: Number(field("startPacks").value),
    boostCost: Number(field("boostCost").value),
    donateUrl: field("donateUrl").value.trim() || null,
  };
  const int = (n: number, lo: number, hi: number) => Number.isInteger(n) && n >= lo && n <= hi;
  const ok = int(r.claimMinutes, 5, 10080) && int(r.claimPacks, 1, 20) && int(r.bank, 1, 10) && int(r.startPacks, 0, 50) && int(r.boostCost, 1, 100000) &&
    (!r.donateUrl || (/^https:\/\/\S+$/.test(r.donateUrl) && r.donateUrl.length <= 300));
  return ok ? r : null;
}

function paintRulesSum() {
  const r = readRules();
  const sum = $("#rulesSum");
  if (!r) return (sum.textContent = "");
  const perDay = (24 * 60 / r.claimMinutes) * r.claimPacks;
  const fmtN = (n: number) => (n >= 10 ? Math.round(n).toString() : (Math.round(n * 10) / 10).toString());
  sum.textContent =
    `That's up to ${fmtN(perDay)} packs a day for someone who claims every time, ` +
    `and up to ${plural(r.claimPacks * r.bank, "pack")} waiting for someone who's been away.`;
}

function showRules(r: Rules) {
  field("hours").value = String(Math.round((r.claimMinutes / 60) * 100) / 100);
  field("claimPacks").value = String(r.claimPacks);
  field("bank").value = String(r.bank);
  field("startPacks").value = String(r.startPacks);
  field("boostCost").value = String(r.boostCost);
  field("donateUrl").value = r.donateUrl ?? "";
  paintRulesSum();
}

rulesForm.addEventListener("input", paintRulesSum);
rulesForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = $("#rulesMsg");
  const r = readRules();
  if (!r) {
    msg.textContent = "Hours between can be 0.1 to 168, packs each time 1 to 20, missed timers 1 to 10, starting packs 0 to 50, a boosted pack 1 to 100000 parts, and the donation link must start with https://.";
    msg.hidden = false;
    return;
  }
  msg.hidden = true;
  const btn = rulesForm.querySelector("button")!;
  btn.disabled = true;
  try {
    showRules(await api.admin.saveSettings(r));
    say("Saved. Everyone's timer uses the new rules.");
  } catch (err) {
    fail(err);
  } finally {
    btn.disabled = false;
  }
});

// ---------- invite codes ----------

let invites: Invite[] = [];
let fresh = new Set<string>();

function inviteLink(code: string) {
  return `${location.origin}/?invite=${code}`;
}

function inviteRow(inv: Invite): HTMLElement {
  const full = inv.uses >= inv.maxUses;
  return h(
    "div",
    { class: `item${fresh.has(inv.code) ? " fresh" : ""}${full ? " done" : ""}` },
    h(
      "div",
      { class: "item-main" },
      h("code", { class: "code" }, inv.code),
      h(
        "div",
        { class: "meta" },
        inv.note ? h("b", {}, inv.note) : null,
        h("span", {}, `${inv.uses} of ${inv.maxUses} used`),
        h("span", {}, `made ${day(inv.createdAt)}`),
      ),
      inv.usedBy.length ? h("div", { class: "meta" }, `Joined: ${inv.usedBy.join(", ")}`) : null,
    ),
    h(
      "div",
      { class: "actions" },
      full ? null : button("Copy code", (b) => copy(inv.code, b)),
      full ? null : button("Copy link", (b) => copy(inviteLink(inv.code), b)),
      confirmButton("Delete", "Tap to delete", async () => {
        try {
          await api.admin.deleteInvite(inv.code);
          invites = invites.filter((i) => i.code !== inv.code);
          paintInvites();
          say(`Deleted ${inv.code}.`);
        } catch (e) {
          fail(e);
        }
      }),
    ),
  );
}

let showUsed = false;

function paintInvites() {
  const open = invites.filter((i) => i.uses < i.maxUses);
  const used = invites.filter((i) => i.uses >= i.maxUses);
  $("#invCount").textContent = invites.length ? `${open.length} open` : "";
  const list = $("#invites");
  list.replaceChildren();
  if (!open.length) list.append(h("p", { class: "empty" }, used.length ? "Every code has been used. Make a new one above." : "No invite codes yet. Make one above."));
  for (const inv of open) list.append(inviteRow(inv));
  if (used.length) {
    const more = h("details", { class: "used" }, h("summary", {}, `Used codes (${used.length})`), ...used.map(inviteRow));
    more.open = showUsed;
    more.addEventListener("toggle", () => (showUsed = more.open));
    list.append(more);
  }
}

$<HTMLFormElement>("#inviteForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.currentTarget as HTMLFormElement;
  const get = (n: string) => (form.elements.namedItem(n) as HTMLInputElement).value;
  const uses = Number(get("uses")), count = Number(get("count"));
  const msg = $("#inviteMsg");
  if (!(Number.isInteger(uses) && uses >= 1 && uses <= 500) || !(Number.isInteger(count) && count >= 1 && count <= 50)) {
    msg.textContent = "People per code can be 1 to 500, and you can make 1 to 50 codes at a time.";
    msg.hidden = false;
    return;
  }
  msg.hidden = true;
  const btn = form.querySelector("button")!;
  btn.disabled = true;
  try {
    const before = new Set(invites.map((i) => i.code));
    invites = await api.admin.makeInvites(get("note").trim(), uses, count);
    fresh = new Set(invites.filter((i) => !before.has(i.code)).map((i) => i.code));
    (form.elements.namedItem("note") as HTMLInputElement).value = "";
    paintInvites();
    say(count === 1 ? "Made a code. Copy it below." : `Made ${count} codes. Copy them below.`);
  } catch (err) {
    fail(err);
  } finally {
    btn.disabled = false;
  }
});

// ---------- accounts ----------

let users: AdminUser[] = [];
let me = "";
let openId = "";

function badge(text: string, cls: string) {
  return h("span", { class: `badge ${cls}` }, text);
}

function manage(u: AdminUser): HTMLElement {
  const self = u.username === me;
  const panel = h("div", { class: "manage" });
  const result = h("div", { class: "result", hidden: true });

  const packs = h("input", { class: "input num", type: "number", inputmode: "numeric", min: "1", max: "100", value: "1", "aria-label": "Packs to give" });
  panel.append(
    h(
      "div",
      { class: "mrow" },
      h("span", {}, "Give packs"),
      packs,
      button(
        "Give",
        async (b) => {
          const n = Number(packs.value);
          if (!(Number.isInteger(n) && n >= 1 && n <= 100)) return say("Give 1 to 100 packs at a time.", true);
          b.disabled = true;
          try {
            await api.admin.givePacks(u.id, n);
            say(`Gave ${plural(n, "pack")} to ${u.username ?? "the guest"}.`);
            await loadUsers();
          } catch (e) {
            fail(e);
          } finally {
            b.disabled = false;
          }
        },
        "cta small",
      ),
    ),
  );
  panel.append(history(u));
  if (self) {
    panel.append(h("p", { class: "meta" }, "This is your account. Change your password in Settings on the main page."));
    return panel;
  }

  if (u.username) {
    const tagIn = h("input", { class: "input", value: u.badge ?? "", "aria-label": `Tag for ${u.username}`, maxlength: "20", placeholder: "No tag" });
    panel.append(
      h("div", { class: "mrow" }, h("span", {}, "Tag"), tagIn,
        button("Save", async (b) => {
          b.disabled = true;
          try {
            await api.admin.badge(u.id, tagIn.value.trim());
            say(tagIn.value.trim() ? `${u.username} now shows "${tagIn.value.trim()}".` : `Removed ${u.username}'s tag.`);
            await loadUsers();
          } catch (e) {
            fail(e);
          } finally {
            b.disabled = false;
          }
        }, "cta small"),
      ),
    );
    if (u.bio) {
      panel.append(
        h("div", { class: "mrow" }, h("span", {}, "Bio"), h("span", { class: "meta" }, u.bio),
          button("Clear", async (b) => {
            if (!window.confirm(`Clear ${u.username}'s bio?`)) return;
            b.disabled = true;
            try {
              await api.admin.clearBio(u.id);
              say(`Cleared ${u.username}'s bio.`);
              await loadUsers();
            } catch (e) {
              fail(e);
            } finally {
              b.disabled = false;
            }
          }, "small"),
        ),
      );
    }
    const nameIn = h("input", { class: "input", value: u.username, "aria-label": `New username for ${u.username}`, maxlength: "20", autocapitalize: "none", spellcheck: "false" });
    panel.append(
      h("div", { class: "mrow" }, h("span", {}, "Rename"), nameIn,
        button("Save", async (b) => {
          const name = nameIn.value.trim();
          if (name === u.username) return;
          b.disabled = true;
          try {
            await api.admin.rename(u.id, name);
            say(`Renamed ${u.username} to ${name}. Their cards and password stay.`);
            await loadUsers();
          } catch (e) {
            fail(e);
          } finally {
            b.disabled = false;
          }
        }, "cta small"),
      ),
    );
  }

  const row = h("div", { class: "mrow wrap" });
  if (u.username) {
    row.append(
      confirmButton("Reset password", "Tap to reset", async () => {
        try {
          const { password } = await api.admin.resetPassword(u.id);
          result.replaceChildren(
            h("span", {}, `New password for ${u.username}: `),
            h("code", { class: "code" }, password),
            button("Copy", (b) => copy(password, b)),
            h("small", {}, "Shown once. They're signed out and can change it in Settings."),
          );
          result.hidden = false;
        } catch (e) {
          fail(e);
        }
      }),
    );
  }
  row.append(
    confirmButton(u.admin ? "Remove admin" : "Make admin", "Tap to confirm", async () => {
      try {
        await api.admin.setAdmin(u.id, !u.admin);
        say(u.admin ? `${u.username} is no longer an admin.` : `${u.username} is now an admin.`);
        await loadUsers();
      } catch (e) {
        fail(e);
      }
    }),
  );
  row.append(
    confirmButton(u.disabled ? "Turn on" : "Turn off", u.disabled ? "Tap to turn on" : "Tap to turn off", async () => {
      try {
        await api.admin.setDisabled(u.id, !u.disabled);
        say(u.disabled ? `${u.username ?? "Guest"} can sign in again.` : `${u.username ?? "Guest"} is signed out and can't sign in.`);
        await loadUsers();
      } catch (e) {
        fail(e);
      }
    }),
  );
  panel.append(row, result);

  const name = u.username ?? "guest";
  const confirm = h("input", { class: "input", placeholder: `Type ${name} to delete`, "aria-label": `Type ${name} to delete`, autocapitalize: "none", spellcheck: "false" });
  panel.append(
    h(
      "div",
      { class: "mrow danger" },
      confirm,
      button(
        "Delete account",
        async (b) => {
          if (confirm.value.trim().toLowerCase() !== name.toLowerCase()) return say(`Type ${name} to delete this account.`, true);
          b.disabled = true;
          try {
            await api.admin.deleteUser(u.id, confirm.value.trim());
            say(`Deleted ${name} and their cards.`);
            openId = "";
            await loadUsers();
          } catch (e) {
            fail(e);
          } finally {
            b.disabled = false;
          }
        },
        "chip bad",
      ),
    ),
    h("p", { class: "meta" }, "Turning an account off keeps its cards. Deleting removes the account for good, and its cards go back into circulation: their serial numbers can be pulled again by others."),
  );
  return panel;
}

/* An account's history: every change to their packs, parts and cards, newest first, from the ledger. */
const ITEM: Record<string, [string, string]> = { packs: ["pack", "packs"], boosted: ["boosted pack", "boosted packs"], parts: ["part", "parts"], card: ["card", "cards"] };
function history(u: AdminUser): HTMLElement {
  const box = h("details", { class: "ledger" });
  const list = h("div", { class: "ledger-list" }, "Loading…");
  box.append(h("summary", {}, "History of packs, parts and cards"), list);
  box.addEventListener("toggle", async () => {
    if (!box.open || box.dataset.done) return;
    try {
      const rows = await api.admin.ledger(u.id);
      box.dataset.done = "1";
      if (!rows.length) return list.replaceChildren(h("p", { class: "meta" }, "Nothing yet."));
      list.replaceChildren(
        ...rows.slice(0, 200).map((r) => {
          const n = Math.abs(r.delta), word = ITEM[r.item][n === 1 ? 0 : 1];
          return h("div", { class: "lrow" + (r.delta < 0 ? " out" : " in") },
            h("time", {}, new Date(r.at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })),
            h("b", {}, `${r.delta < 0 ? "−" : "+"}${n} ${word}`),
            h("span", {}, [r.detail, r.reason].filter(Boolean).join(" · ")));
        }),
      );
    } catch (e) {
      list.replaceChildren(h("p", { class: "meta" }, explain(e)));
    }
  });
  return box;
}

$("#retierBtn").addEventListener("click", async () => {
  const out = $("#retierOut"), b = $<HTMLButtonElement>("#retierBtn");
  b.disabled = true;
  try {
    const r = await api.admin.retier();
    out.replaceChildren(h("p", { class: "good" }, `Checked ${plural(r.players, "player")}. ${plural(r.compensated, "player")} got 1,000 parts and the note this time.`));
    out.hidden = false;
  } catch (e) {
    fail(e);
  } finally {
    b.disabled = false;
  }
});

$("#auditBtn").addEventListener("click", async () => {
  const out = $("#auditOut"), b = $<HTMLButtonElement>("#auditBtn");
  b.disabled = true;
  try {
    const a = await api.admin.audit();
    const ok = !a.mismatches.length && !a.badSerials;
    out.replaceChildren(
      h("p", { class: ok ? "good" : "bad" }, ok ? `All ${plural(a.players, "player")} add up. No serial number is used twice.` : "Something doesn't add up:"),
      ...a.mismatches.map((m) => h("p", { class: "meta" }, `${m.username ?? "a guest"}: has ${m.have} ${m.item}, the ledger says ${m.ledger}.`)),
      ...(a.badSerials ? [h("p", { class: "meta" }, `${plural(a.badSerials, "card")} with a serial number that's repeated or was never printed.`)] : []),
      ...(a.staleOffers ? [h("p", { class: "meta" }, `${plural(a.staleOffers, "open offer")} for cards the sender no longer has (they'll fail if accepted).`)] : []),
    );
    out.hidden = false;
  } catch (e) {
    fail(e);
  } finally {
    b.disabled = false;
  }
});

function paintUsers() {
  const q = $<HTMLInputElement>("#userFilter").value.trim().toLowerCase();
  const shown = users.filter((u) => !q || (u.username ?? "guest").toLowerCase().includes(q) || (u.inviteNote ?? "").toLowerCase().includes(q));
  $("#userCount").textContent = plural(users.length, "account");
  const list = $("#users");
  list.replaceChildren();
  if (!shown.length) list.append(h("p", { class: "empty" }, q ? "No accounts match." : "No accounts yet."));
  for (const u of shown) {
    const open = openId === u.id;
    const toggle = button(open ? "Close" : "Manage", () => {
      openId = open ? "" : u.id;
      paintUsers();
    });
    toggle.setAttribute("aria-expanded", String(open));
    list.append(
      h(
        "div",
        { class: `item${u.disabled ? " done" : ""}` },
        h(
          "div",
          { class: "item-main" },
          h(
            "div",
            { class: "who" },
            h("b", {}, u.username ?? "Guest"),
            u.admin ? badge("Admin", "admin") : null,
            u.disabled ? badge("Off", "off") : null,
            u.username ? null : badge("No sign-in", "off"),
          ),
          h(
            "div",
            { class: "meta" },
            h("span", {}, `joined ${day(u.createdAt)}`),
            u.inviteNote ? h("span", {}, `invite: ${u.inviteNote}`) : null,
            h("span", {}, plural(u.sealed, "pack") + " to open"),
            h("span", {}, `${u.opened} opened`),
            h("span", {}, plural(u.cards, "card")),
            u.lastOpenedAt ? h("span", {}, `last pack ${when(u.lastOpenedAt)}`) : null,
          ),
        ),
        h("div", { class: "actions" }, toggle),
        open ? manage(u) : null,
      ),
    );
  }
}
$("#userFilter").addEventListener("input", paintUsers);

async function loadUsers() {
  users = await api.admin.users();
  paintUsers();
}

// ---------- reports ----------

const REASON: Record<Report["reason"], string> = { username: "Offensive username", cheating: "Cheating or abuse", harassment: "Harassment", other: "Something else" };
let reports: Report[] = [];

function paintReports() {
  $("#repCount").textContent = reports.length ? `${reports.length} open` : "";
  const list = $("#reports");
  list.replaceChildren();
  if (!reports.length) list.append(h("p", { class: "empty" }, "No reports. When a player reports someone, it shows up here."));
  for (const r of reports) {
    list.append(
      h(
        "div",
        { class: "item" },
        h(
          "div",
          { class: "item-main" },
          h("div", { class: "who" }, h("b", {}, r.target), h("span", { class: "badge off" }, REASON[r.reason] ?? r.reason)),
          r.details ? h("div", { class: "meta" }, `"${r.details}"`) : null,
          h("div", { class: "meta" }, h("span", {}, `from ${r.reporter}`), h("span", {}, when(r.createdAt))),
        ),
        h(
          "div",
          { class: "actions" },
          button("Manage account", () => {
            openId = r.targetId;
            ($("#userFilter") as HTMLInputElement).value = r.target;
            paintUsers();
            $("#users").scrollIntoView({ behavior: "smooth", block: "start" });
          }),
          button("Mark handled", async (b) => {
            b.disabled = true;
            try {
              await api.admin.resolveReport(r.id);
              reports = reports.filter((x) => x.id !== r.id);
              paintReports();
            } catch (e) {
              fail(e);
              b.disabled = false;
            }
          }),
        ),
      ),
    );
  }
}

// ---------- feedback ----------

const KIND: Record<Feedback["kind"], string> = { bug: "Bug", idea: "Idea", other: "Other" };
const STATUS: Record<FeedbackStatus, string> = { open: "Open", planned: "Planned", done: "Done", wontfix: "Won't do" };
let feedback: Feedback[] = [];
let fbShow: FeedbackStatus | "all" = "open";
const pays = (f: Feedback) => !f.rewarded && (f.kind === "bug" || f.kind === "idea");

function paintFeedback() {
  const open = feedback.filter((f) => f.status === "open").length;
  $("#fbCount").textContent = open ? `${open} open` : "";
  const filter = $("#fbFilter");
  filter.replaceChildren();
  for (const s of ["open", "planned", "done", "wontfix", "all"] as const) {
    const n = s === "all" ? feedback.length : feedback.filter((f) => f.status === s).length;
    const label = `${s === "all" ? "All" : STATUS[s]} (${n})`;
    filter.append(
      button(
        label,
        () => {
          fbShow = s;
          paintFeedback();
        },
        fbShow === s ? "chip armed" : "chip",
      ),
    );
  }
  const list = $("#feedback");
  list.replaceChildren();
  const shown = feedback.filter((f) => fbShow === "all" || f.status === fbShow);
  if (!shown.length) list.append(h("p", { class: "empty" }, feedback.length ? "Nothing here." : "No feedback yet. When a tester sends some, it shows up here."));
  for (const f of shown) {
    const note = h("input", { class: "input", maxlength: "200", placeholder: "Note for the sender (optional)", "aria-label": "Note for the sender" });
    note.value = f.note;
    const set = (status: FeedbackStatus) => async (b: HTMLButtonElement) => {
      b.disabled = true;
      try {
        const r = await api.admin.feedbackStatus(f.id, status, note.value.trim());
        if (r.rewarded) { f.rewarded = true; say(`${f.username ?? "They"} got a free pack for this.`); }
        f.status = status;
        f.note = note.value.trim();
        paintFeedback();
      } catch (e) {
        fail(e);
        b.disabled = false;
      }
    };
    list.append(
      h(
        "div",
        { class: f.status === "done" || f.status === "wontfix" ? "item done" : "item" },
        h(
          "div",
          { class: "item-main" },
          h("div", { class: "who" }, h("b", {}, f.title), h("span", { class: "badge" }, KIND[f.kind] ?? f.kind), h("span", { class: "badge off" }, STATUS[f.status] ?? f.status), f.rewarded ? h("span", { class: "badge" }, "+1 pack sent") : null),
          f.details ? h("div", { class: "meta fb-details" }, f.details) : null,
          h("div", { class: "meta" }, h("span", {}, `from ${f.username ?? "?"}`), h("span", {}, when(f.createdAt))),
          f.context ? h("div", { class: "meta fb-ctx" }, f.context) : null,
          note,
        ),
        h(
          "div",
          { class: "actions" },
          // Accepting a bug report or idea (planned or done) sends its sender a pack, once.
          f.status !== "planned" ? button(pays(f) ? "Planned · +1 pack" : "Planned", set("planned")) : null,
          f.status !== "done" ? button(pays(f) ? "Done · +1 pack" : "Done", set("done")) : null,
          f.status !== "wontfix" ? button("Won't do", set("wontfix")) : null,
          f.status !== "open" ? button("Reopen", set("open")) : null,
        ),
      ),
    );
  }
}

// ---------- start ----------

/** Computers get two tabs: people and feedback, and configuration (rules, rarities, health). Phones get only the first. */
function setupTabs() {
  const people = $("#groupPeople"), config = $("#groupConfig");
  const tabP = $("#tabPeople"), tabC = $("#tabConfig");
  let loaded = false;
  const show = (cfg: boolean) => {
    people.hidden = cfg;
    config.hidden = !cfg;
    tabP.setAttribute("aria-selected", String(!cfg));
    tabC.setAttribute("aria-selected", String(cfg));
    try { sessionStorage.setItem("adminTab", cfg ? "config" : "people"); } catch { /* storage can be off */ }
    if (cfg && !loaded) {
      loaded = true;
      setupRarities(say);
    }
  };
  tabP.onclick = () => show(false);
  tabC.onclick = () => show(true);
  let saved: string | null = null;
  try { saved = sessionStorage.getItem("adminTab"); } catch { /* storage can be off */ }
  show(saved === "config" && window.matchMedia("(min-width: 900px)").matches);
}

async function boot() {
  try {
    const [st, inv, us, rules, reps, fb] = await Promise.all([api.state(), api.admin.invites(), api.admin.users(), api.admin.settings(), api.admin.reports(), api.admin.feedback()]);
    reports = reps;
    feedback = fb;
    me = st.account.username;
    invites = inv;
    users = us;
    showRules(rules);
    paintReports();
    paintFeedback();
    $("#panel").hidden = false;
    setupTabs();
    paintInvites();
    paintUsers();
  } catch (e) {
    const gate = $("#gate");
    const signedOut = e instanceof ApiError && e.status === 401;
    const notAdmin = e instanceof ApiError && e.status === 403;
    gate.replaceChildren(
      h("h1", {}, signedOut ? "Sign in first" : notAdmin ? "Admins only" : "Can't load the admin panel"),
      h(
        "p",
        {},
        signedOut
          ? "Sign in with the admin account on the main page, then come back here."
          : notAdmin
            ? "This page is for the admin account."
            : explain(e),
      ),
      h("a", { class: "cta small", href: "/" }, signedOut ? "Go to sign in" : "Back to packs"),
    );
    gate.hidden = false;
  }
}

boot();
