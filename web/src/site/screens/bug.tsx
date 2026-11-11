// The bug button next to your profile (bugs and ideas, the Feedback page), and the popup that introduces it: once per
// device, after anything else that's open. Closing the popup shrinks it into the button, the way a phone's app shrinks
// back into its icon, so it's clear where to find it again.
import { useEffect, useRef } from "preact/hooks";
import { store, useStore } from "../../lib/store";
import { layers } from "../ui";
import { openFeedback } from "./settings";

const SEEN = "frcpacks.bugintro";
const BETA = "frcpacks.beta"; // set once a player has seen the beta welcome (gate.tsx)
const RM = matchMedia("(prefers-reduced-motion: reduce)").matches;

export const BugIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M9 7.2a3 3 0 0 1 6 0" />
    <rect x="7" y="7.5" width="10" height="12" rx="5" />
    <path d="M12 11v8.3M4 10.5l3 1.2M20 10.5l-3 1.2M3.5 15h3.5M20.5 15H17M4.5 19.5l3-1.6M19.5 19.5l-3-1.6M9.5 5 8 3.2M14.5 5 16 3.2" />
  </svg>
);

/** The button in the top bar. It pops when the popup lands in it. */
export function BugButton() {
  return (
    <button type="button" id="s-bug" class="s-bug" onClick={() => openFeedback()} aria-label="Report a bug or share an idea" title="Report a bug or share an idea">
      <BugIcon />
    </button>
  );
}

const open = store(false);

/** Shows the popup once on this device, when nothing else is open. A brand-new player has the beta welcome (which also
    asks for feedback) first, so they get this on their next visit instead. */
export function bugIntro() {
  try {
    if (localStorage.getItem(SEEN) || !localStorage.getItem(BETA)) return;
  } catch { return; }
  const tryShow = () => {
    // Anything else open (the patch notes, a card, a pack being opened) goes first; then a moment's pause.
    if (layers.get().length) {
      const stop = layers.sub((l) => { if (!l.length) { stop(); setTimeout(tryShow, 1600); } });
      return;
    }
    try { localStorage.setItem(SEEN, "1"); } catch { /* storage can be off */ }
    open.set(true);
  };
  tryShow();
}

export function BugIntro() {
  const shown = useStore(open);
  const card = useRef<HTMLDivElement>(null), back = useRef<HTMLDivElement>(null);
  const closing = useRef(false);

  // The phone's back button closes it too (it's a history entry while it's up).
  useEffect(() => {
    if (!shown) return;
    closing.current = false;
    try { history.pushState({ bugintro: 1 }, ""); } catch { /* fine */ }
    const pop = () => shrink();
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    addEventListener("popstate", pop);
    addEventListener("keydown", esc);
    return () => { removeEventListener("popstate", pop); removeEventListener("keydown", esc); };
  }, [shown]);

  /** Shrinks the card into the bug button, then pops the button. */
  function shrink(then?: () => void) {
    if (closing.current) return;
    closing.current = true;
    const c = card.current, b = back.current, btn = document.getElementById("s-bug");
    const done = () => {
      open.set(false);
      if (btn && !RM) { btn.classList.remove("pop"); void btn.offsetWidth; btn.classList.add("pop"); }
      then?.();
    };
    if (!c || !btn || RM) return done();
    const from = c.getBoundingClientRect(), to = btn.getBoundingClientRect();
    const dx = to.left + to.width / 2 - (from.left + from.width / 2), dy = to.top + to.height / 2 - (from.top + from.height / 2);
    const s = to.width / from.width;
    const ease = "cubic-bezier(.45, 0, .2, 1)";
    // The content goes first, then the card (now just a rounded shape) flies into the button.
    c.querySelector(".bi-in")?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, fill: "forwards" });
    b?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 420, easing: "ease-out", fill: "forwards" });
    c.animate([
      { transform: "none", borderRadius: "12px", opacity: 1 },
      { transform: `translate(${dx * 0.55}px, ${dy * 0.55}px) scale(${0.35 + s * 0.65})`, borderRadius: "20px", opacity: 1, offset: 0.6 },
      { transform: `translate(${dx}px, ${dy}px) scale(${s})`, borderRadius: `${Math.min(from.width, from.height) / 4}px`, opacity: 0.25 },
    ], { duration: 460, easing: ease, fill: "forwards" }).finished.then(done, done);
  }

  /** Closes from a button: through history, so the entry it added goes away too. */
  function close(then?: () => void) {
    if (history.state?.bugintro) {
      const after = () => { removeEventListener("popstate", after); shrink(then); };
      addEventListener("popstate", after);
      history.back();
    } else shrink(then);
  }

  if (!shown) return null;
  return (
    <div ref={back} class="bi-back" onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div ref={card} class="bi-card" role="dialog" aria-modal="true" aria-labelledby="bi-title">
        <div class="bi-in">
          <span class="bi-icon"><BugIcon /></span>
          <h2 id="bi-title">Found a bug? Got an idea?</h2>
          <p>Tap the bug next to your profile any time to tell us. Accepted bug reports and ideas earn you a free pack.</p>
          <div class="bi-btns">
            <button type="button" class="s-btn" onClick={() => close(() => setTimeout(openFeedback, 80))}>Report one now</button>
            <button type="button" class="s-btn ghost" onClick={() => close()}>Got it</button>
          </div>
        </div>
      </div>
    </div>
  );
}
