import * as esbuild from "esbuild"

const watch = process.argv.includes("--watch")
const production = process.argv.includes("--production")

/** @type {import("esbuild").BuildOptions} */
const shared = {
  bundle: true,
  sourcemap: !production,
  minify: production,
  logLevel: "info",
  define: { "process.env.NODE_ENV": JSON.stringify(production ? "production" : "development") },
}

/** @type {import("esbuild").BuildOptions[]} */
const targets = [
  {
    ...shared,
    entryPoints: ["src/extension.ts"],
    outfile: "dist/extension.js",
    platform: "node",
    format: "cjs",
    target: "node20",
    external: ["vscode"],
  },
  {
    ...shared,
    entryPoints: ["src/webview/main.ts"],
    outfile: "dist/webview.js",
    platform: "browser",
    format: "iife",
    target: "es2022",
  },
  {
    ...shared,
    entryPoints: ["scripts/smoke.ts"],
    outfile: "dist/smoke.mjs",
    platform: "node",
    format: "esm",
    target: "node20",
  },
  {
    ...shared,
    entryPoints: ["scripts/inspect.ts"],
    outfile: "dist/inspect.mjs",
    platform: "node",
    format: "esm",
    target: "node20",
  },
  {
    ...shared,
    entryPoints: ["scripts/handoff.ts"],
    outfile: "dist/handoff.mjs",
    platform: "node",
    format: "esm",
    target: "node20",
  },
]

if (watch) {
  const contexts = await Promise.all(targets.map((target) => esbuild.context(target)))
  await Promise.all(contexts.map((context) => context.watch()))
  console.log("esbuild: watching for changes")
} else {
  await Promise.all(targets.map((target) => esbuild.build(target)))
}
