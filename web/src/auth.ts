// The sign-in screen: sign in with a username and password, or join with an invite code. Shown until one works.

import { api, ApiError, explain, type State } from "./api";

const USERNAME = /^[A-Za-z0-9_]{3,20}$/;

function el<T extends HTMLElement = HTMLElement>(sel: string): T {
  const e = document.querySelector<T>(sel);
  if (!e) throw new Error(`missing ${sel}`);
  return e;
}

function field(form: HTMLFormElement, name: string): HTMLInputElement {
  return form.elements.namedItem(name) as HTMLInputElement;
}

/** Shows the sign-in screen and resolves with the account's state once someone signs in or joins. */
export function signIn(guest: boolean): Promise<State> {
  const auth = el("#auth");
  const inTab = el("#authInTab"), joinTab = el("#authJoinTab");
  const inForm = el<HTMLFormElement>("#signInForm"), joinForm = el<HTMLFormElement>("#joinForm");
  const terms = el("#betaTerms");
  const msg = el("#authMsg");
  // New players read and agree to the beta-tester terms once before the join form (remembered for this tab).
  let agreed = false;
  try { agreed = sessionStorage.getItem("frcpacks.betaTerms") === "1"; } catch { /* storage can be off */ }

  function tab(join: boolean) {
    inTab.setAttribute("aria-selected", String(!join));
    joinTab.setAttribute("aria-selected", String(join));
    const readTerms = join && !agreed;
    inForm.hidden = join;
    terms.hidden = !readTerms;
    joinForm.hidden = !join || readTerms;
    msg.hidden = true;
    if (readTerms) return el("#betaAgree").focus({ preventScroll: true });
    const first = join ? field(joinForm, field(joinForm, "code").value ? "username" : "code") : field(inForm, "username");
    first.focus({ preventScroll: true });
  }
  function say(text: string) {
    msg.textContent = text;
    msg.hidden = false;
  }

  // A link like /?invite=ABCD-EFGH-JKMN opens the join form with the code filled in.
  const invite = new URLSearchParams(location.search).get("invite");
  if (invite) field(joinForm, "code").value = invite;
  el("#guestNote").hidden = !guest;
  auth.hidden = false;
  tab(guest || !!invite);
  inTab.onclick = () => tab(false);
  joinTab.onclick = () => tab(true);
  el("#toJoin").onclick = () => tab(true);
  el("#betaBack").onclick = () => tab(false);
  el("#betaAgree").onclick = () => {
    agreed = true;
    try { sessionStorage.setItem("frcpacks.betaTerms", "1"); } catch { /* storage can be off */ }
    tab(true);
  };

  return new Promise((resolve) => {
    function handle(form: HTMLFormElement, check: () => string | null, run: () => Promise<State>) {
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const problem = check();
        if (problem) return say(problem);
        const btn = form.querySelector<HTMLButtonElement>("button[type=submit]")!;
        btn.disabled = true;
        msg.hidden = true;
        try {
          const state = await run();
          if (invite) history.replaceState(null, "", location.pathname + location.hash);
          auth.hidden = true;
          resolve(state);
        } catch (err) {
          say(explain(err));
          btn.disabled = false;
        }
      });
    }
    handle(
      inForm,
      () => (field(inForm, "username").value.trim() && field(inForm, "password").value ? null : "Enter your username and password."),
      () => api.login(field(inForm, "username").value.trim(), field(inForm, "password").value),
    );
    handle(
      joinForm,
      () => {
        if (!field(joinForm, "code").value.trim()) return "Enter your invite code.";
        if (!field(joinForm, "firstName").value.trim()) return explain(new ApiError(400, "bad_first_name"));
        if (!USERNAME.test(field(joinForm, "username").value.trim())) return explain(new ApiError(400, "bad_username"));
        if (field(joinForm, "password").value.length < 8) return "Passwords need at least 8 characters.";
        return null;
      },
      () => api.signup(field(joinForm, "code").value, field(joinForm, "username").value.trim(), field(joinForm, "password").value, field(joinForm, "firstName").value.trim()),
    );
  });
}
