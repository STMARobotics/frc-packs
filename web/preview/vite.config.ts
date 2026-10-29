// The opening preview's build (tools/open_preview.cjs runs it): one script with everything in it (Three.js and fonts too), paths
// relative to the page, and the app's photo paths made relative so they load from beside the page.
import { defineConfig } from "vite";

export default defineConfig({
  root: import.meta.dirname,
  base: "./",
  publicDir: false,
  build: {
    outDir: process.env.PREVIEW_OUT ?? "dist",
    emptyOutDir: true,
    assetsInlineLimit: 1_000_000, // the card pictures' fonts go inside the page too
    cssCodeSplit: false,
    chunkSizeWarningLimit: 2000,
    rolldownOptions: { output: { codeSplitting: false } },
  },
  plugins: [
    {
      name: "relative-photos",
      transform(code, id) {
        if (/[\\/]src[\\/].*\.tsx?$/.test(id) && code.includes("`/photos/")) return code.replaceAll("`/photos/", "`photos/");
      },
    },
  ],
});
