// Builds the app into dist/:
//   main.cjs      the Electron main process          (esbuild, src/main/index.ts)
//   preload.cjs   the bridge into the app window      (esbuild, src/preload.ts)
//   page-preload.cjs  the page under review's preload (esbuild, src/page-preload.ts), with the
//                 shared in-page review layer built into it (../overlay/src: the overlay's own
//                 build does that part, see ../../overlay/scripts/build.mjs)
//   renderer/     the app window's UI                 (vite + solid, src/renderer)
//   ext-worker-preload.cjs, ext-page-preload.cjs  what Figma's and Paper's extensions are
//                 given of a browser (src/ext-*.ts, see src/main/extensions.ts)
//   helper.cjs    the app's helper on another computer reached over ssh (esbuild, src/helper/helper.ts):
//                 one file, for node 18 or newer there, put at ~/.bicycle42/helper-<version>.js
//   icon.png      the app icon, when there is one     (copied from ../assets)
//   test/         with --tests: every test/*.ts bundled to .cjs
//
//   node scripts/build.mjs [--tests] [--watch]
import { build, context } from "esbuild"
import { build as viteBuild } from "vite"
import solid from "vite-plugin-solid"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { build as buildOverlay, buildLookup } from "../../overlay/scripts/build.mjs"

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")
const dist = path.join(root, "dist")
const flags = new Set(process.argv.slice(2))
const watch = flags.has("--watch")

const node = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron"],
  sourcemap: "inline",
  logLevel: "warning",
  absWorkingDir: root,
}

// The page's preload carries the overlay, since a sandboxed preload can't read it from disk. Its
// "b42:page-overlay" is overlay.js and overlay-lookup.js, each the body of a function, built anew
// with every build of the preload.
const pageOverlay = {
  name: "page-overlay",
  setup(b) {
    b.onResolve({ filter: /^b42:page-overlay$/ }, () => ({ path: "page-overlay", namespace: "b42" }))
    b.onLoad({ filter: /.*/, namespace: "b42" }, () => ({
      contents: `export function overlay() {\n${buildOverlay()}\n}\nexport function lookup() {\n${buildLookup()}\n}\n`,
      loader: "js",
      resolveDir: root,
    }))
  },
}

const entries = [
  { entryPoints: ["src/main/index.ts"], outfile: "dist/main.cjs" },
  { entryPoints: ["src/preload.ts"], outfile: "dist/preload.cjs" },
  // Runs on another computer with its own node: no source map (it would be most of the file).
  { entryPoints: ["src/helper/helper.ts"], outfile: "dist/helper.cjs", target: "node18", sourcemap: false },
  // Runs in the page's renderer, which is Chromium, not Node. Main reads it again for every
  // document the page loads, so it goes without the inline source map.
  { entryPoints: ["src/page-preload.ts"], outfile: "dist/page-preload.cjs", plugins: [pageOverlay], target: "chrome140", sourcemap: false },
  // Figma's and Paper's extensions (main/extensions.ts): in their background workers, and in the
  // windows they open. Both run in Chromium.
  { entryPoints: ["src/ext-worker-preload.ts"], outfile: "dist/ext-worker-preload.cjs", target: "chrome140", sourcemap: false },
  { entryPoints: ["src/ext-page-preload.ts"], outfile: "dist/ext-page-preload.cjs", target: "chrome140", sourcemap: false },
]
if (flags.has("--tests")) {
  // Built afresh: a test whose source is gone must not stay behind and pass on its own old copy
  // (`npm test` runs every dist/test/*.test.cjs).
  fs.rmSync(path.join(root, "dist/test"), { recursive: true, force: true })
  const tests = fs.readdirSync(path.join(root, "test")).filter((f) => f.endsWith(".ts"))
  if (tests.length)
    entries.push({ entryPoints: tests.map((f) => `test/${f}`), outdir: "dist/test", outExtension: { ".js": ".cjs" } })
}

fs.mkdirSync(dist, { recursive: true })
// The app icon, for the window and the macOS dock. The app runs without it.
const icon = path.join(root, "../assets/icon.png")
if (fs.existsSync(icon)) fs.copyFileSync(icon, path.join(dist, "icon.png"))

const renderer = {
  root: path.join(root, "src/renderer"),
  base: "./",
  plugins: [solid()],
  logLevel: "warn",
  build: { outDir: path.join(dist, "renderer"), emptyOutDir: true, target: "chrome140", ...(watch ? { watch: {} } : {}) },
}

if (watch) {
  const contexts = []
  for (const e of entries) {
    const ctx = await context({ ...node, ...e })
    await ctx.watch()
    contexts.push(ctx)
  }
  await viteBuild(renderer)
  // An edit in ../overlay/src builds dist/page-preload.cjs again, once the edits pause: esbuild
  // does not watch what its plugin reads. A failed build keeps the last one and the watching.
  const pagePreload = contexts[entries.findIndex((e) => e.outfile === "dist/page-preload.cjs")]
  let timer
  fs.watch(path.join(root, "../overlay/src"), { recursive: true }, () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      pagePreload.rebuild().then(
        () => console.log("page-preload.cjs rebuilt with the overlay"),
        (e) => console.error(`page-preload.cjs not rebuilt: ${e.message}`),
      )
    }, 100)
  })
  console.log("watching…")
} else {
  await Promise.all([...entries.map((e) => build({ ...node, ...e })), viteBuild(renderer)])
}
