// The app's typeface, Inter, shipped with the app (no font service). Headings use var(--display) at weight 400, a
// leftover of the old display face that only had one weight, so "Inter Display" is Inter Bold under weight 400.
// Cards keep their own faces (style.css, .card).
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import bold from "@fontsource/inter/files/inter-latin-700-normal.woff2?url";

const face = document.createElement("style");
face.textContent = `@font-face{font-family:"Inter Display";font-style:normal;font-weight:400;font-display:swap;src:url(${bold}) format("woff2")}`;
document.head.append(face);
