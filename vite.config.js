import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base must match the repo name for GitHub Pages project sites
export default defineConfig({
  plugins: [react()],
  base: "/customer-growth-decisioning/",
});
