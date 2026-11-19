// A note's pictures (src/main/images.ts), with a stand-in for a captured frame that
// remembers which part of the original frame each picture shows and what each step cost.
//
// The pictures must be what they were when each was cropped and scaled from the full frame on
// its own: the same names, the same sizes to the pixel, the same part of the page (to within the
// rounding of one scaled pixel). Only the way there changed.
import assert from "node:assert/strict"
import { test } from "node:test"
import { noteImages, notePicture, type Frame, type Where } from "../src/main/images"

type Region = { x: number; y: number; w: number; h: number }
type Shown = { width: number; height: number; region: Region }

/** A picture of `region` of the original frame, `width`×`height` pixels. */
class Fake {
  constructor(
    readonly width: number,
    readonly height: number,
    readonly region: Region,
    readonly log: string[],
    readonly frame: string,
  ) {}
  getSize() {
    return { width: this.width, height: this.height }
  }
  crop(r: { x: number; y: number; width: number; height: number }) {
    const sx = this.region.w / this.width
    const sy = this.region.h / this.height
    const region = { x: this.region.x + r.x * sx, y: this.region.y + r.y * sy, w: r.width * sx, h: r.height * sy }
    return new Fake(r.width, r.height, region, this.log, this.frame)
  }
  resize(to: { width: number; height: number }) {
    this.log.push(`${this.frame} resize ${this.width}x${this.height}`)
    return new Fake(to.width, to.height, this.region, this.log, this.frame)
  }
  toJPEG() {
    this.log.push(`${this.frame} jpeg ${this.width}x${this.height}`)
    return Buffer.from(JSON.stringify({ width: this.width, height: this.height, region: this.region }))
  }
}

const frame = (width: number, height: number, log: string[], name = "shot") =>
  new Fake(width, height, { x: 0, y: 0, w: width, h: height }, log, name) as Frame
const shown = (uri: string): Shown =>
  JSON.parse(Buffer.from(uri.slice("data:image/jpeg;base64,".length), "base64").toString())

/** The pictures as the app made them before: every one cropped, then scaled, from the frame. */
function reference(
  size: { width: number; height: number },
  note: Where,
  n: number,
  before: boolean,
): Array<{ name: string } & Shown> {
  const fit = (w: number, h: number, max: number) => {
    const k = Math.min(1, max / Math.max(w, h))
    return k < 1 ? { width: Math.round(w * k), height: Math.round(h * k) } : { width: w, height: h }
  }
  const vw = note.viewport.w
  const vh = note.viewport.h
  const s = size.width / vw
  const b = note.bounds
  const x0 = b ? Math.max(0, b.x - 48) : 0
  const y0 = b ? Math.max(0, b.y - 48) : 0
  const x1 = b ? Math.min(vw, b.x + b.w + 48) : vw
  const y1 = b ? Math.min(vh, b.y + b.h + 48) : vh
  const whole = { ...fit(size.width, size.height, 1200), region: { x: 0, y: 0, w: size.width, h: size.height } }
  if (!b || x1 <= x0 || y1 <= y0 || (x1 - x0) * (y1 - y0) > 0.6 * vw * vh)
    return before
      ? [
          { name: `note-${n}-before.jpg`, ...whole },
          { name: `note-${n}-after.jpg`, ...whole },
        ]
      : [{ name: `note-${n}.jpg`, ...whole }]
  const area = {
    x: Math.round(x0 * s),
    y: Math.round(y0 * s),
    w: Math.min(size.width, Math.round((x1 - x0) * s)),
    h: Math.min(size.height, Math.round((y1 - y0) * s)),
  }
  const crop = { ...fit(area.w, area.h, 1200), region: area }
  return [
    ...(before ? [{ name: `note-${n}-before-area.jpg`, ...crop }] : []),
    { name: before ? `note-${n}-after-area.jpg` : `note-${n}-area.jpg`, ...crop },
    {
      name: `note-${n}-viewport.jpg`,
      ...fit(size.width, size.height, 600),
      region: { x: 0, y: 0, w: size.width, h: size.height },
    },
  ]
}

const viewport = { w: 1440, h: 900, dpr: 2, scrollX: 0, scrollY: 0 }
const CASES: Array<[string, { width: number; height: number }, Where]> = [
  [
    "a small area on a retina frame",
    { width: 2880, height: 1800 },
    { viewport, bounds: { x: 300, y: 200, w: 400, h: 220 } },
  ],
  [
    "a wide area that has to be scaled down",
    { width: 2880, height: 1800 },
    { viewport, bounds: { x: 100, y: 100, w: 900, h: 400 } },
  ],
  ["a tall narrow area", { width: 2880, height: 1800 }, { viewport, bounds: { x: 600, y: 0, w: 100, h: 800 } }],
  [
    "an area at the frame's far corner",
    { width: 2880, height: 1800 },
    { viewport, bounds: { x: 700, y: 400, w: 740, h: 500 } },
  ],
  ["an odd scale", { width: 2160, height: 1350 }, { viewport, bounds: { x: 333, y: 111, w: 777, h: 345 } }],
  ["a small area at 1x", { width: 1440, height: 900 }, { viewport, bounds: { x: 300, y: 200, w: 400, h: 220 } }],
  ["no selection", { width: 2880, height: 1800 }, { viewport, bounds: null }],
  [
    "an area covering most of the viewport",
    { width: 2880, height: 1800 },
    { viewport, bounds: { x: 0, y: 0, w: 1400, h: 880 } },
  ],
  [
    "a frame smaller than the picture",
    { width: 1000, height: 625 },
    { viewport: { ...viewport, w: 1000, h: 625 }, bounds: null },
  ],
]

for (const [name, size, note] of CASES)
  for (const before of [false, true])
    test(`note pictures, ${name}${before ? ", with a before picture" : ""}: the same names, sizes and crops as cropping and scaling each from the frame`, async () => {
      const log: string[] = []
      const got = await noteImages(
        frame(size.width, size.height, log),
        note,
        7,
        before ? frame(size.width, size.height, log, "before") : undefined,
      )
      const want = reference(size, note, 7, before)
      assert.deepEqual(
        got.map((f) => f.name),
        want.map((f) => f.name),
      )
      got.forEach((f, i) => {
        const g = shown(f.uri)
        const w = want[i]!
        assert.deepEqual([g.width, g.height], [w.width, w.height], `${f.name}: size`)
        // Cut from a scaled frame, an edge may move by one scaled pixel.
        const slack = Math.max(size.width / g.width, size.height / g.height) + 0.5
        for (const k of ["x", "y", "w", "h"] as const)
          assert.ok(
            Math.abs(g.region[k] - w.region[k]) <= slack,
            `${f.name}: ${k} ${g.region[k]} vs ${w.region[k]} (±${slack.toFixed(2)})`,
          )
      })
      // Each frame is scaled at full size once at most, and never encoded at full size unless
      // that is the picture's own size.
      for (const which of ["shot", "before"]) {
        const full = log.filter((l) => l === `${which} resize ${size.width}x${size.height}`).length
        assert.ok(full <= 1, `${which} scaled at full size ${full} times: ${log.join(", ")}`)
      }
      const encoded = log.filter((l) => l.includes(" jpeg ")).map((l) => l.split(" jpeg ")[1])
      assert.deepEqual(
        encoded,
        got.map((f) => `${shown(f.uri).width}x${shown(f.uri).height}`),
      )
    })

test("the picture after the agent is done is the first picture alone: no thumbnail is made for it", async () => {
  for (const [, size, note] of CASES) {
    const log: string[] = []
    const got = await notePicture(frame(size.width, size.height, log), note, 3)
    const want = reference(size, note, 3, false)[0]!
    assert.equal(got.name, want.name)
    assert.deepEqual([shown(got.uri).width, shown(got.uri).height], [want.width, want.height])
    assert.equal(log.filter((l) => l.includes(" jpeg ")).length, 1, log.join(", "))
    assert.ok(log.filter((l) => l.includes(" resize ")).length <= 1, log.join(", "))
  }
})

test("making the pictures lets the event loop run between its steps", async () => {
  const log: string[] = []
  let ticks = 0
  let going = true
  const count = () => {
    if (!going) return
    ticks++
    setImmediate(count)
  }
  setImmediate(count)
  await noteImages(frame(2880, 1800, log), CASES[0]![2], 1, frame(2880, 1800, log, "before"))
  going = false
  const steps = log.length
  assert.ok(ticks >= steps, `${ticks} turns of the loop for ${steps} steps`)
})
