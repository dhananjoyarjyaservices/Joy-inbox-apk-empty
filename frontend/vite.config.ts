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
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("/node_modules/")) return;
          if (id.includes("/node_modules/@firebase/") || id.includes("/node_modules/firebase/")) {
            return "firebase-vendor";
          }
          if (
            id.includes("/node_modules/react/") ||
            id.includes("/node_modules/react-dom/") ||
            id.includes("/node_modules/react-router/")
          ) {
            return "react-vendor";
          }
          if (id.includes("/node_modules/framer-motion/")) return "motion-vendor";
        }
      }
    }
  }
}));
