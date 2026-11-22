import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig(() => ({
  // Cloudflare Pages serves this app from the site root.
  // Keep BrowserRouter and generated asset URLs aligned with that root.
  base: "/",
  plugins: [react(), tailwindcss()],
  server: {
    host: "0.0.0.0",
    port: 5173
  },
  build: {
    sourcemap: false
  }
}));
