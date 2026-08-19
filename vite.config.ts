import { resolve } from "node:path";
import { defineConfig } from "vite";
import pkg from "./package.json" with { type: "json" };

// vite lib mode inlines dependencies unless they are explicitly externalised
const deps = [
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.peerDependencies ?? {}),
];

export default defineConfig({
  build: {
    lib: {
      entry: resolve(import.meta.dirname, "src/index.ts"),
      formats: ["es"],
      fileName: "index",
    },
    rolldownOptions: {
      // predicate rather than a plain array so subpaths match too, e.g. "@gltf-transform/core/foo"
      external: (id) => deps.some((d) => id === d || id.startsWith(`${d}/`)),
    },
  },
});
