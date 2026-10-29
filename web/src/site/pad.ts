// Playing with a controller (any standard gamepad: Xbox, PlayStation, Switch Pro in a browser that maps it). A screen
// can take buttons for itself with usePad (the pack in your hand: A opens, X turns it over, B puts it back). Otherwise
// the d-pad or left stick moves a focus ring between controls and A presses; something that handles arrow keys itself
// (the wheel, the card stack: data-pad-keys) gets arrows and Enter instead; data-pad-first is where the ring starts. B closes the top screen, LB / RB switch
// tabs and Start claims free packs. Phone buzzes rumble the controller too.
import { useEffect, useRef } from "preact/hooks";
import { setRumble } from "./sfx";
import { toast } from "./state";
import { back, layers } from "./ui";

export type PadButton = "a" | "b" | "x" | "y" | "left" | "right" | "up" | "down";
type Handler = (b: PadButton) => boolean | void;
const handlers: { current: Handler }[] = [];

/** While the calling screen is up, `h` sees each button first; returning true means it handled it. */
export function usePad(h: Handler) {
  const r = useRef(h);
  r.current = h;
  useEffect(() => {
    handlers.push(r);
    return () => { handlers.splice(handlers.indexOf(r), 1); };
  }, []);
}

const B = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, START: 9, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 };
const KEY: Partial<Record<PadButton, string>> = { a: "Enter", left: "ArrowLeft", right: "ArrowRight", up: "ArrowUp", down: "ArrowDown" };
const pads = () => { try { return [...(navigator.getGamepads?.() ?? [])].filter((p): p is Gamepad => !!p && p.mapping === "standard"); } catch { return []; } };

/** The part of the page the controller works in: the top screen, or the page itself. */
function root(): HTMLElement {
  const ls = document.querySelectorAll<HTMLElement>(".s-layer");
  return ls.length ? ls[ls.length - 1] : document.body;
}
/** The focused control inside the controller's area (not the page itself). */
function focused(r: HTMLElement) {
  const f = document.activeElement;
  return f instanceof HTMLElement && f !== document.body && r.contains(f) ? f : null;
}
function controls(r: HTMLElement) {
  return [...r.querySelectorAll<HTMLElement>("button:not([disabled]), a[href], input, select, textarea, [tabindex='0']")]
    .filter((el) => el.getClientRects().length && !el.closest("[hidden]"));
}
function focus(el: HTMLElement) {
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: "nearest", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
}
/** Moves focus to the nearest control in a direction. */
function move(dir: PadButton) {
  const r = root(), all = controls(r), cur = focused(r);
  if (!cur) { const first = all.find((el) => el.matches("[data-pad-first]")) ?? all[0]; if (first) focus(first); return; }
  const c = cur.getBoundingClientRect(), cx = c.left + c.width / 2, cy = c.top + c.height / 2;
  let best: HTMLElement | null = null, bestD = Infinity;
  for (const el of all) {
    if (el === cur) continue;
    const b = el.getBoundingClientRect(), dx = b.left + b.width / 2 - cx, dy = b.top + b.height / 2 - cy;
    const along = dir === "left" ? -dx : dir === "right" ? dx : dir === "up" ? -dy : dy, across = dir === "left" || dir === "right" ? Math.abs(dy) : Math.abs(dx);
    if (along <= 4) continue;
    const d = along + across * 2.5;
    if (d < bestD) { bestD = d; best = el; }
  }
  if (best) focus(best);
}

function press(b: PadButton) {
  document.body.classList.add("pad");
  for (let i = handlers.length - 1; i >= 0; i--) if (handlers[i].current(b)) return;
  const f = focused(root());
  if (f?.matches("[data-pad-keys]") && KEY[b]) { f.dispatchEvent(new KeyboardEvent("keydown", { key: KEY[b], bubbles: true, cancelable: true })); return; }
  if (b === "a") { if (f) f.click(); else move("down"); }
  else if (b === "b") { if (layers.get().length) back(); }
  else if (b !== "x" && b !== "y") move(b);
}
function tab(step: number) {
  if (layers.get().length) return;
  const tabs = [...document.querySelectorAll<HTMLButtonElement>(".s-tabbar button")], at = tabs.findIndex((t) => t.classList.contains("on"));
  tabs[(at + step + tabs.length) % tabs.length]?.click();
}

let prev: boolean[][] = [], raf = 0, rep = { dir: "" as PadButton | "", at: 0 }, seen = false;
function loop() {
  raf = 0;
  const list = pads();
  if (!list.length) { prev = []; return; }
  const now = performance.now();
  let dir: PadButton | "" = "";
  for (const p of list) {
    const was = prev[p.index] ?? [], cur = p.buttons.map((x) => x.pressed || x.value > 0.5), hit = (i: number) => cur[i] && !was[i];
    prev[p.index] = cur;
    if (hit(B.A)) press("a");
    if (hit(B.B)) press("b");
    if (hit(B.X)) press("x");
    if (hit(B.Y)) press("y");
    if (hit(B.LB)) tab(-1);
    if (hit(B.RB)) tab(1);
    if (hit(B.START)) document.querySelector<HTMLButtonElement>(".st-timer .s-btn")?.click();
    const ax = p.axes;
    if (cur[B.LEFT] || ax[0] < -0.55) dir = "left"; else if (cur[B.RIGHT] || ax[0] > 0.55) dir = "right";
    else if (cur[B.UP] || ax[1] < -0.55) dir = "up"; else if (cur[B.DOWN] || ax[1] > 0.55) dir = "down";
  }
  // A held direction repeats: once, then again after a pause, then steadily.
  if (!dir) rep.dir = "";
  else if (dir !== rep.dir) { rep = { dir, at: now + 380 }; press(dir); }
  else if (now >= rep.at) { rep.at = now + 150; press(dir); }
  raf = requestAnimationFrame(loop);
}
function start() {
  document.body.classList.add("pad");
  if (!seen) toast("Controller connected · A select · B back", false, 2600);
  seen = true;
  if (!raf) raf = requestAnimationFrame(loop);
}

export function setupPad() {
  addEventListener("gamepadconnected", start);
  addEventListener("gamepaddisconnected", () => { if (!pads().length) document.body.classList.remove("pad"); });
  // Touching the screen or the mouse puts the focus rings back the way they were.
  addEventListener("pointerdown", () => document.body.classList.remove("pad"), true);
  setRumble((ms) => {
    if (!seen) return;
    const total = Array.isArray(ms) ? ms.reduce((a, b) => a + b, 0) : ms;
    for (const p of pads()) {
      try { (p as Gamepad & { vibrationActuator?: { playEffect(t: string, o: object): Promise<unknown> } }).vibrationActuator?.playEffect("dual-rumble", { duration: Math.min(total, 600), strongMagnitude: 0.7, weakMagnitude: 0.5 }); } catch { /* not supported */ }
    }
  });
  if (pads().length) start();
}
