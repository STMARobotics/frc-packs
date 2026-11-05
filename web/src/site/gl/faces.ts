// Pictures of the real DOM cards, for the WebGL opening to draw: each card's own face (the same component and CSS as
// the binder, so foil, serials and frames match exactly), its back and its ribbon, photographed with html-to-image
// (the element and its styles drawn through an SVG image onto a canvas). The two fonts (Lilita One for headings, Mona
// Sans for everything else, one variable file for every weight) come with the app so the
// pictures never wait on, or miss, the font service. A browser that won't let a page read such a canvas back throws
// here, and the opening keeps its DOM cards.
import { toCanvas } from "html-to-image";
import lilita from "@fontsource/lilita-one/files/lilita-one-latin-400-normal.woff2?url";
import mona from "@fontsource-variable/mona-sans/files/mona-sans-latin-wght-normal.woff2?url";

const asData = (url: string) => fetch(url).then((r) => { if (!r.ok) throw new Error(`${url}: ${r.status}`); return r.blob(); }).then((b) => new Promise<string>((res, rej) => {
  const f = new FileReader();
  f.onload = () => res(f.result as string);
  f.onerror = rej;
  f.readAsDataURL(b);
}));
let fontCss: Promise<string> | null = null;
const fonts = () => (fontCss ??= Promise.all([lilita, mona].map(asData)).then(([l, m]) =>
  `@font-face{font-family:"Lilita One";font-weight:400;src:url(${l}) format("woff2")}` +
  `@font-face{font-family:"Mona Sans";font-weight:200 900;src:url(${m}) format("woff2")}`));

/** A box-shadow without its outer shadows: those fall outside the element, and in a picture of just the element they'd
    only darken the corners outside its rounded edge. WebGL draws the shadow itself. */
export const insetOnly = (shadow: string) => (shadow.split(/,(?![^(]*\))/).filter((x) => x.includes("inset")).join(",") || "none");

/** Every iPhone and iPad browser is WebKit, and so is Safari on a Mac. */
const webkit = /iP(hone|ad|od)/.test(navigator.userAgent) || (/AppleWebKit/.test(navigator.userAgent) && !/Chrome|Chromium|Android/.test(navigator.userAgent)) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

/** A picture of `el` as it lies flat (its own transform left off: WebGL puts that back), at the screen's sharpness. */
export async function snap(el: HTMLElement): Promise<HTMLCanvasElement> {
  const w = el.offsetWidth, h = el.offsetHeight;
  // The robot photo has to be loaded and decoded first: the cards being pictured are out of sight, and a lazy image
  // there may not have loaded at all.
  await Promise.all([...el.querySelectorAll("img")].map((i) => { i.loading = "eager"; return i.decode().catch(() => {}); }));
  const draw = async () => toCanvas(el, {
    width: w, height: h, pixelRatio: Math.min(devicePixelRatio || 1, 2) * 1.25, fontEmbedCSS: await fonts(),
    style: {
      transform: "none", left: "0", top: "0", right: "auto", bottom: "auto", margin: "0", visibility: "visible", animation: "none", transition: "none",
      boxShadow: insetOnly(getComputedStyle(el).boxShadow),
    },
  });
  // WebKit draws the images inside the picture blank the first time (it decodes them only once asked to draw them),
  // which left iPhones with photo-less cards in the opening. The second drawing has them.
  if (webkit) await draw();
  const cv = await draw();
  cv.getContext("2d")!.getImageData(0, 0, 1, 1); // throws if the browser won't let us use the picture
  return cv;
}
