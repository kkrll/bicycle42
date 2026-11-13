// Builds the app into dist/:
//   main.cjs      the Electron main process          (esbuild, src/main/index.ts)
//   preload.cjs   the bridge into the app window      (esbuild, src/preload.ts)
//   renderer/     the app window's UI                 (vite + solid, src/renderer)
//   overlay.js    the shared in-page review layer     (esbuild, ../overlay/src: the overlay's own
//                                                     build does it, see ../../overlay/scripts/build.mjs)
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

const entries = [
  { entryPoints: ["src/main/index.ts"], outfile: "dist/main.cjs" },
  { entryPoints: ["src/preload.ts"], outfile: "dist/preload.cjs" },
]
if (flags.has("--tests")) {
  const tests = fs.readdirSync(path.join(root, "test")).filter((f) => f.endsWith(".ts"))
  if (tests.length)
    entries.push({ entryPoints: tests.map((f) => `test/${f}`), outdir: "dist/test", outExtension: { ".js": ".cjs" } })
}

// The controller with Electron and the page view swapped for stubs, so its recovery paths can be
// tested in plain Node (test/controller.test.ts loads a fresh copy per test).
const controller = flags.has("--tests")
  ? {
      ...node,
      entryPoints: ["src/main/index.ts"],
      outfile: "dist/test/controller.cjs",
      external: [],
      plugins: [
        {
          name: "stubs",
          setup(b) {
            b.onResolve({ filter: /^electron$/ }, () => ({ path: path.join(root, "test/stubs/electron.ts") }))
            b.onResolve({ filter: /^\.\/page$/ }, (args) =>
              args.importer.endsWith("src/main/index.ts") ? { path: path.join(root, "test/stubs/page.ts") } : undefined,
            )
          },
        },
      ],
    }
  : undefined

fs.mkdirSync(dist, { recursive: true })
const overlay = buildOverlay()
fs.writeFileSync(path.join(dist, "overlay.js"), overlay)
// The overlay has a script world of its own; this small one goes among the page's scripts.
const lookup = buildLookup()
fs.writeFileSync(path.join(dist, "overlay-lookup.js"), lookup)
// The app icon, for the window and the macOS dock. The app runs without it.
const icon = path.join(root, "../assets/icon.png")
if (fs.existsSync(icon)) fs.copyFileSync(icon, path.join(dist, "icon.png"))
if (controller) {
  // The stubbed controller reads the overlay from beside itself, like the real one.
  fs.mkdirSync(path.join(dist, "test"), { recursive: true })
  fs.writeFileSync(path.join(dist, "test/overlay.js"), overlay)
  fs.writeFileSync(path.join(dist, "test/overlay-lookup.js"), lookup)
}

const renderer = {
  root: path.join(root, "src/renderer"),
  base: "./",
  plugins: [solid()],
  logLevel: "warn",
  build: { outDir: path.join(dist, "renderer"), emptyOutDir: true, target: "chrome140", ...(watch ? { watch: {} } : {}) },
}

if (watch) {
  for (const e of entries) await (await context({ ...node, ...e })).watch()
  await viteBuild(renderer)
  // An edit in ../overlay/src builds dist/overlay.js again, once the edits pause. A failed build
  // keeps the last one and the watching.
  let timer
  fs.watch(path.join(root, "../overlay/src"), { recursive: true }, () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      try {
        fs.writeFileSync(path.join(dist, "overlay.js"), buildOverlay())
        fs.writeFileSync(path.join(dist, "overlay-lookup.js"), buildLookup())
        console.log("overlay.js rebuilt")
      } catch (e) {
        console.error(`overlay.js not rebuilt: ${e.message}`)
      }
    }, 100)
  })
  console.log("watching…")
} else {
  await Promise.all([...entries.map((e) => build({ ...node, ...e })), ...(controller ? [build(controller)] : []), viteBuild(renderer)])
}
