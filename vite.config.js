import { readFileSync } from "node:fs";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Written by `oneframework dev` / `oneframework build` before Vite starts. Theme and seed
// colour are needed to construct Framework7, which happens before Python boots,
// so they are inlined here rather than travelling in the app metadata. This is
// what makes dev and build render identically.
function appConfig() {
  try {
    return JSON.parse(readFileSync(new URL(".oneframework-build.json", import.meta.url)));
  } catch {
    return { theme: "auto", color: "#6750A4", build: "dev" };
  }
}

// `base: "./"` keeps every asset URL relative, which is what makes the same
// build work from a dev server, from a static host and from Capacitor's
// WebView origin without rewriting anything.
const APP = appConfig();

export default defineConfig({
  root: "web",
  base: "./",
  // JSX разбирается только в `.jsx`: истолкователь переезжает на React по
  // частям, и пока он переезжает, оба рендерера живут рядом. Ограничение по
  // расширению -- граница между ними, видимая в имени файла.
  plugins: [react({ include: "**/*.jsx" })],
  define: {
    __PYAPP_THEME__: JSON.stringify(APP.theme || "auto"),
    __PYAPP_COLOR__: JSON.stringify(APP.color || "#6750A4"),
    __PYAPP_DYNAMIC_COLOR__: JSON.stringify(!!APP.dynamic_color),
    __PYAPP_BUILD__: JSON.stringify(APP.build || "dev"),
  },
  publicDir: "public",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    target: "es2022",
    chunkSizeWarningLimit: 3000,
    // PYAPP_SOURCEMAP=1 keeps a readable stack when debugging a build.
    sourcemap: process.env.PYAPP_SOURCEMAP === "1",
  },
  server: {
    port: 5173,
    host: true,
    fs: { allow: [".."] },
  },
  preview: { port: 4173, host: true },
  // Pyodide's loader is fetched at runtime from the copied dist directory,
});
