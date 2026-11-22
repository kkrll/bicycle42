// A test reporter for scripts/unit.mjs: it writes, for every test file the runner heard from, how
// many tests it announced and how many it finished, a line of JSON per file. The human reporter
// does the printing; this one only counts.
//
//   {"file":"/…/review.test.cjs","announced":77,"finished":77,"fileFinished":true}
//   {"ended":true}
//
// A child test process announces all of its tests at the start and reports each result as it
// ends, so a file whose process went away early (or whose last bytes never arrived) is left with
// announced > finished. A file's line is written when the file itself completes, the rest when
// the run ends, and "ended" last: a run that was killed has no "ended", and the lines it has
// say which files had finished.
export default async function* ledger(source) {
  const files = {}
  const line = (file) => JSON.stringify({ file, ...files[file] }) + "\n"
  for await (const { type, data } of source) {
    if (type !== "test:enqueue" && type !== "test:complete") continue
    if (!data.file) continue
    const f = (files[data.file] ??= { announced: 0, finished: 0, fileFinished: false })
    if (type === "test:enqueue") f.announced++
    else {
      f.finished++
      // The file itself is the test at nesting 0: it completes when its process has reported
      // everything and ended.
      if (data.nesting === 0) {
        f.fileFinished = true
        yield line(data.file)
      }
    }
  }
  for (const file of Object.keys(files)) if (!files[file].fileFinished) yield line(file)
  yield JSON.stringify({ ended: true }) + "\n"
}
