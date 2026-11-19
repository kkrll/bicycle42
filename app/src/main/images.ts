// A note's screenshot, cut down to what the agent needs: a crop of the marked area for detail and
// a small picture of the whole viewport to show where it sits. Forty full screenshots in one
// conversation would fill the model's context halfway through a review.
//
// This runs on the main thread, where a retina frame (2880×1800) is slow to scale: about 17 ms
// to 1200 wide, 10 ms to 600, against 1–6 ms to encode the result. So each frame is scaled
// down once at most, a smaller picture is made from a larger one already made, and the work
// yields to the event loop between steps: no single stall is longer than one of them.
import type { PromptFile } from "../shared/types"
import type { PageNote } from "./review"

/** Page around the selection, CSS px. */
const CROP_MARGIN = 48
/** Longest side of the crop and of the thumbnail, image px. */
const CROP_MAX = 1200
const THUMB_MAX = 600

type Size = { width: number; height: number }
type Rect = Size & { x: number; y: number }
/** One picture of the page, in device pixels, and the four things done to it here. Whoever
 *  takes the picture makes one (page.ts, from the view's capture); nothing here knows how. */
export type Frame = {
  getSize(): Size
  /** The part of it inside `rect`. */
  crop(rect: Rect): Frame
  /** The whole of it at another size, scaled well rather than fast. */
  resize(to: Size): Frame
  /** `quality`: 0 to 100. */
  toJPEG(quality: number): Buffer
}
/** What a note says about where it was made. */
export type Where = Pick<PageNote, "bounds" | "viewport">

/** Lets the event loop run (IPC, the event stream, timers) before the next slow step. */
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

/** The size `fit` makes: the longest side at most `max`, the shape kept. */
function fitted(s: Size, max: number): Size {
  const k = Math.min(1, max / Math.max(s.width, s.height))
  return k < 1 ? { width: Math.round(s.width * k), height: Math.round(s.height * k) } : s
}

const same = (a: Size, b: Size) => a.width === b.width && a.height === b.height

async function scale(i: Frame, to: Size): Promise<Frame> {
  if (same(i.getSize(), to)) return i
  await tick()
  return i.resize({ width: to.width, height: to.height })
}

async function jpeg(i: Frame): Promise<string> {
  await tick()
  return `data:image/jpeg;base64,${i.toJPEG(80).toString("base64")}`
}

/** The marked area in the capture's pixels, or undefined for the whole viewport: no
 *  selection, or a crop covering most of it. */
export function areaOf(size: Size, note: Where): Rect | undefined {
  const vw = note.viewport.w
  const vh = note.viewport.h
  // The capture is in device pixels, the note in CSS pixels.
  const s = size.width / vw
  const b = note.bounds
  if (!b) return undefined
  const x0 = Math.max(0, b.x - CROP_MARGIN)
  const y0 = Math.max(0, b.y - CROP_MARGIN)
  const x1 = Math.min(vw, b.x + b.w + CROP_MARGIN)
  const y1 = Math.min(vh, b.y + b.h + CROP_MARGIN)
  if (x1 <= x0 || y1 <= y0 || (x1 - x0) * (y1 - y0) > 0.6 * vw * vh) return undefined
  return {
    x: Math.round(x0 * s),
    y: Math.round(y0 * s),
    width: Math.min(size.width, Math.round((x1 - x0) * s)),
    height: Math.min(size.height, Math.round((y1 - y0) * s)),
  }
}

/** One frame cut into what the note sends of it: the area (or the whole viewport) at most
 *  CROP_MAX on its longest side, and with `thumb` the whole viewport at most THUMB_MAX.
 *
 *  The sizes are those of cropping first and then scaling each picture from the full frame;
 *  only the way there differs. The thumbnail comes from the viewport picture when there is one,
 *  and an area that has to be scaled down anyway may be cut from the frame scaled once to the
 *  area's scale, which the thumbnail then comes from too: whichever moves fewer pixels. */
async function cut(frame: Frame, area: Rect | undefined, thumb: boolean): Promise<{ main: Frame; thumb?: Frame }> {
  const full = frame.getSize()
  const thumbSize = fitted(full, THUMB_MAX)
  if (!area) {
    const main = await scale(frame, fitted(full, CROP_MAX))
    return thumb ? { main, thumb: await scale(main, thumbSize) } : { main }
  }
  const cropSize = fitted(area, CROP_MAX)
  const k = Math.min(1, CROP_MAX / Math.max(area.width, area.height))
  const px = (s: Size) => s.width * s.height
  // Cost in source pixels scaled: the crop, then the frame for the thumbnail; or the frame
  // once, then the scaled frame for the thumbnail.
  const direct = (k < 1 ? px(area) : 0) + (thumb && !same(thumbSize, full) ? px(full) : 0)
  const once = px(full) + (thumb ? px(full) * k * k : 0)
  if (k >= 1 || direct <= once) {
    const main = await scale(frame.crop(area), cropSize)
    return thumb ? { main, thumb: await scale(frame, thumbSize) } : { main }
  }
  const scaled = await scale(frame, { width: Math.round(full.width * k), height: Math.round(full.height * k) })
  const s = scaled.getSize()
  const x = Math.max(0, Math.min(Math.round(area.x * k), s.width - cropSize.width))
  const y = Math.max(0, Math.min(Math.round(area.y * k), s.height - cropSize.height))
  const main = scaled.crop({
    x,
    y,
    width: Math.min(cropSize.width, s.width),
    height: Math.min(cropSize.height, s.height),
  })
  return thumb ? { main, thumb: await scale(scaled, thumbSize) } : { main }
}

/** `shot` is the page as captured right after the note was submitted; `n` is the note's number.
 *  `before`, for a canvas note, is the same viewport with the reviewer's edits switched off: it
 *  goes first, cut the same way as the picture after it, and both say which they are by name. */
export async function noteImages(shot: Frame, note: Where, n: number, before?: Frame): Promise<PromptFile[]> {
  const area = areaOf(shot.getSize(), note)
  // No selection, or a crop covering most of the viewport: one viewport image at crop resolution.
  if (!area) {
    if (!before) return [{ uri: await jpeg((await cut(shot, undefined, false)).main), name: `note-${n}.jpg` }]
    const first = await jpeg((await cut(before, undefined, false)).main)
    return [
      { uri: first, name: `note-${n}-before.jpg` },
      { uri: await jpeg((await cut(shot, undefined, false)).main), name: `note-${n}-after.jpg` },
    ]
  }
  const out: PromptFile[] = []
  if (before) out.push({ uri: await jpeg((await cut(before, area, false)).main), name: `note-${n}-before-area.jpg` })
  const after = await cut(shot, area, true)
  out.push({ uri: await jpeg(after.main), name: before ? `note-${n}-after-area.jpg` : `note-${n}-area.jpg` })
  out.push({ uri: await jpeg(after.thumb!), name: `note-${n}-viewport.jpg` })
  return out
}

/** The first of a note's pictures alone (the area, or the whole viewport): the picture of the
 *  same place once the agent is done. No thumbnail is made for it. */
export async function notePicture(shot: Frame, note: Where, n: number): Promise<PromptFile> {
  const area = areaOf(shot.getSize(), note)
  const { main } = await cut(shot, area, false)
  return { uri: await jpeg(main), name: area ? `note-${n}-area.jpg` : `note-${n}.jpg` }
}
