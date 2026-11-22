// Splits a long test file into parts that node --test runs side by side, each in its own process
// (with its own browser). A file's tests run one after another, so the longest file was the whole
// run's length: canvas's 58 tests took as long as all the other files together.
//
// The suite file (not matched by test/*.test.mjs) takes its `test` from here; each part file
// imports the suite with ?part=k/n and gets every n-th test, starting at the k-th. Without a part
// (the suite imported or run on its own) every test is declared.
//
//   test/canvas.1.test.mjs:  await import("./canvas.suite.mjs?part=1/2");
//   test/canvas.suite.mjs:   const test = partOf(import.meta.url);
import { test } from "node:test";

export function partOf(url) {
  const m = /^(\d+)\/(\d+)$/.exec(new URL(url).searchParams.get("part") ?? "1/1");
  if (!m) throw new Error(`part: want ?part=k/n, got ${url}`);
  const k = Number(m[1]) - 1, n = Number(m[2]);
  let i = 0;
  return (...args) => (i++ % n === k ? test(...args) : undefined);
}
