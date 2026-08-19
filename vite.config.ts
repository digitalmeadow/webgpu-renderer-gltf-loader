import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import pkg from "./package.json" with { type: "json" };

const __dirname = dirname(fileURLToPath(import.meta.url));

// vite lib mode inlines dependencies unless they are explicitly externalised
const deps = [
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.peerDependencies ?? {}),
];

export default defineConfig({
  build: {
    lib: {
      entry: resolve(__dirname, "src/index.ts"),
      formats: ["es"],
      fileName: "index",
    },
    rollupOptions: {
      external: (id) => deps.some((d) => id === d || id.startsWith(`${d}/`)),
    },
  },
});
