import { resolve } from "node:path";
import { defineConfig } from "vite";

// In development the Rust server runs on :3000 and Vite proxies the API, photos and pack recipes to it.
// In production the server serves the built site (web/dist) itself, so everything is one origin.
const server = process.env.API_URL ?? "http://127.0.0.1:3000";

export default defineConfig({
  build: {
    // Two pages: the game and the admin panel (the server serves it at /admin).
    rollupOptions: { input: { main: resolve(import.meta.dirname, "index.html"), admin: resolve(import.meta.dirname, "admin.html") } },
  },
  server: {
    proxy: { "/api": server, "/photos": server, "/packs": server },
  },
  plugins: [
    {
      name: "admin-path",
      // Match the server in development: /admin is the admin page.
      configureServer(dev) {
        dev.middlewares.use((req, _res, next) => {
          if (req.url === "/admin" || req.url?.startsWith("/admin?")) req.url = req.url.replace("/admin", "/admin.html");
          next();
        });
      },
    },
  ],
});
