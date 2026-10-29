// Pictures of the real DOM cards, for the WebGL opening to draw: each card's own face (the same component and CSS as
// the binder, so foil, serials and frames match exactly), its back and its ribbon, photographed with html-to-image
// (the element and its styles drawn through an SVG image onto a canvas). The two fonts come with the app so the
// pictures never wait on, or miss, the font service. A browser that won't let a page read such a canvas back throws
// here, and the opening keeps its DOM cards.
import { toCanvas } from "html-to-image";
import lilita from "@fontsource/lilita-one/files/lilita-one-latin-400-normal.woff2?url";
import chakra500 from "@fontsource/chakra-petch/files/chakra-petch-latin-500-normal.woff2?url";
import chakra600 from "@fontsource/chakra-petch/files/chakra-petch-latin-600-normal.woff2?url";
import chakra700 from "@fontsource/chakra-petch/files/chakra-petch-latin-700-normal.woff2?url";

const asData = (url: string) => fetch(url).then((r) => { if (!r.ok) throw new Error(`${url}: ${r.status}`); return r.blob(); }).then((b) => new Promise<string>((res, rej) => {
  const f = new FileReader();
  f.onload = () => res(f.result as string);
  f.onerror = rej;
  f.readAsDataURL(b);
}));
let fontCss: Promise<string> | null = null;
const fonts = () => (fontCss ??= Promise.all([lilita, chakra500, chakra600, chakra700].map(asData)).then(([l, a, b, c]) =>
  `@font-face{font-family:"Lilita One";font-weight:400;src:url(${l}) format("woff2")}` +
  [[500, a], [600, b], [700, c]].map(([w, d]) => `@font-face{font-family:"Chakra Petch";font-weight:${w};src:url(${d}) format("woff2")}`).join("")));

/** A box-shadow without its outer shadows: those fall outside the element, and in a picture of just the element they'd
    only darken the corners outside its rounded edge. WebGL draws the shadow itself. */
export const insetOnly = (shadow: string) => (shadow.split(/,(?![^(]*\))/).filter((x) => x.includes("inset")).join(",") || "none");

/** A picture of `el` as it lies flat (its own transform left off: WebGL puts that back), at the screen's sharpness. */
export async function snap(el: HTMLElement): Promise<HTMLCanvasElement> {
  const w = el.offsetWidth, h = el.offsetHeight;
  const cv = await toCanvas(el, {
    width: w, height: h, pixelRatio: Math.min(devicePixelRatio || 1, 2) * 1.25, fontEmbedCSS: await fonts(),
    style: {
      transform: "none", left: "0", top: "0", right: "auto", bottom: "auto", margin: "0", visibility: "visible", animation: "none", transition: "none",
      boxShadow: insetOnly(getComputedStyle(el).boxShadow),
    },
  });
  cv.getContext("2d")!.getImageData(0, 0, 1, 1); // throws if the browser won't let us use the picture
  return cv;
}
