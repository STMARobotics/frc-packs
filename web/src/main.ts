import "./style.css";
import { api, ApiError, type State } from "./api";
import { accountSettings } from "./account";
import { signIn } from "./auth";
import { start } from "./app.js";
import { setupPwa } from "./pwa";
import { startNotice } from "./notice";

const PACK = "cmp26";

async function main() {
  startNotice();
  try {
    const recipe = api.recipe(PACK);
    let state: State;
    try {
      state = await api.session();
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 401) throw e;
      state = await signIn(e.code === "guest");
    }
    document.body.classList.remove("signed-out");
    accountSettings(state.account);
    setupPwa();
    // Rarities the admin changed since the recipe file was built.
    const r = await recipe;
    for (const t of r.teams) if (state.tiers?.[t.num]) t.tier = state.tiers[t.num];
    start(r);
  } catch (e) {
    const offline = e instanceof ApiError && e.status === 0;
    document.body.insertAdjacentHTML(
      "afterbegin",
      `<div class="fatal">${offline ? "Can't reach FRC Packs right now. Check your connection and reload." : "Something went wrong loading FRC Packs. Reload to try again."}</div>`,
    );
    throw e;
  }
}

main();
