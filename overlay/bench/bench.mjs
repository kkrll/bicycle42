// Benchmark of the overlay: what it costs the page under review, state by state.
// Run: npm run bench -- [path/to/overlay.js] [--compare other.js] [--json out.json]
// Prints one table (cell × metric, per second) and the invariants; exits 1 when one fails.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "../scripts/build.mjs";
import { start, displayRate, open, measure, sleep } from "./rig.mjs";
import { CELLS, METRICS, WINDOW_MS, invariants } from "./cells.mjs";

const REPS = 3;
const SETTLE_MS = 800; // after any input the overlay keeps drawing for 500 ms

const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  return i < 0 ? null : args.splice(i, 2)[1];
};
const compare = option("--compare");
const jsonFile = option("--json");
const only = option("--cells")?.split(","); // for working on the benchmark itself: --cells off,strokes
// With no file given, the overlay as src/ has it now.
const here = () => {
  const out = join(mkdtempSync(join(tmpdir(), "b42-bench-")), "overlay.js");
  writeFileSync(out, build());
  return out;
};
const files = [args[0] ?? here(), ...(compare ? [compare] : [])].map((f) => resolve(f));

const median = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const inShadow = (page, fn) => page.evaluate(`(${fn})(document.querySelector("b42-review").shadowRoot)`);

/** One cell with one overlay file: a fresh page, the set-up, then REPS windows one after another. */
async function runCell(rig, file, cell) {
  const t = await open(rig, file, cell);
  try {
    if (cell.setup) await cell.setup(t);
    await sleep(SETTLE_MS);
    if (cell.ready && !(await inShadow(t.page, cell.ready))) throw new Error(`the set-up did not take: ${cell.ready}`);
    const runs = [];
    for (let rep = 0; rep < REPS; rep++) runs.push(await measure(t, () => (cell.run ? cell.run(t) : sleep(WINDOW_MS))));
    if (cell.after && !(await inShadow(t.page, cell.after))) throw new Error(`nothing happened in the windows: ${cell.after}`);
    if (t.errors.length) throw new Error(`the page threw: ${t.errors[0]}`);
    return { ...Object.fromEntries(METRICS.map(([k]) => [k, median(runs.map((m) => m[k]))])), runs };
  } catch (err) {
    err.message = `${cell.id} (${file}): ${err.message}`;
    throw err;
  } finally {
    await t.page.close();
  }
}

const started = Date.now();
const rig = await start();
const cells = CELLS.filter((c) => !only || only.includes(c.id));
const results = files.map(() => ({})); // per file: { cell id: { metric: median, runs: [...] } }
let fps;
try {
  fps = await displayRate(rig);
  // Cell by cell, the files taking turns: whatever else the machine is doing falls on both alike.
  for (const cell of cells) {
    for (const [i, file] of files.entries()) results[i][cell.id] = await runCell(rig, file, cell);
    process.stderr.write(`${cell.id} `);
  }
  process.stderr.write("\n");
} finally {
  await rig.close();
}

// ── the table ───────────────────────────────────────────────────────────────────────────────────
// An exact zero prints as "0": "0.0" is something that happened, less than once in twenty seconds.
const fmt = (key, v) => (v === 0 ? "0" : v.toFixed(key.endsWith("Ms") ? 2 : 1));
const tags = files.length > 1 ? ["a", "b"] : [""];
const rows = [["cell", ...(compare ? [""] : []), ...METRICS.map(([, heading]) => heading)]];
for (const cell of cells)
  for (const [i, tag] of tags.entries())
    rows.push([i ? "" : cell.id, ...(compare ? [tag] : []), ...METRICS.map(([k]) => fmt(k, results[i][cell.id][k]))]);
const widths = rows[0].map((_, c) => Math.max(...rows.map((r) => r[c].length)));
const line = (r) => r.map((s, c) => (c === 0 ? s.padEnd(widths[c]) : s.padStart(widths[c]))).join("  ").trimEnd();

console.log(`chromium ${rig.browser.version()} · the display shows ${fps.toFixed(1)} frames/s · ${((Date.now() - started) / 1000).toFixed(0)} s`);
for (const [i, file] of files.entries()) console.log(`${tags[i] ? `${tags[i]}: ` : ""}${file}`);
console.log(`\nper second, the median of ${REPS} windows of ${WINDOW_MS / 1000} s; frames, timers, writes (of a stroke's path) and searches (of the document) are the overlay's\n`);
console.log(rows.map(line).join("\n"));

// ── the invariants ──────────────────────────────────────────────────────────────────────────────
const checks = files.map((_, i) =>
  invariants(fps)
    .filter(([cell, , , over]) => results[i][cell] && (!over || results[i][over]))
    .map(([cell, metric, most, over]) => {
      const got = results[i][cell][metric] - (over ? results[i][over][metric] : 0);
      return { cell, metric, most, over, got, pass: got <= most };
    }),
);
for (const [i, list] of checks.entries()) {
  console.log(`\ninvariants${tags[i] ? ` of ${tags[i]}` : ""}`);
  for (const c of list) console.log(`  ${c.pass ? "pass" : "FAIL"}  ${c.cell}: ${fmt(c.metric, c.got)} ${c.metric}/s${c.over ? ` more than ${c.over}` : ""} (at most ${fmt(c.metric, c.most)})`);
}
if (jsonFile) writeFileSync(jsonFile, `${JSON.stringify({ chromium: rig.browser.version(), displayFps: fps, files: files.map((file, i) => ({ file, cells: results[i], invariants: checks[i] })) }, null, 2)}\n`);
// With --compare the second file is what the first is judged against: only the first can fail the run.
process.exitCode = checks[0].every((c) => c.pass) ? 0 : 1;
