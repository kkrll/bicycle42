// A note's screenshot, cut down to what the agent needs: a crop of the marked area for detail and
// a small picture of the whole viewport to show where it sits. Forty full screenshots in one
// conversation would fill the model's context halfway through a review.
import type { NativeImage } from "electron"
import type { PromptFile } from "../shared/types"
import type { PageNote } from "./review"

/** Page around the selection, CSS px. */
const CROP_MARGIN = 48
/** Longest side of the crop and of the thumbnail, image px. */
const CROP_MAX = 1200
const THUMB_MAX = 600

const jpeg = (i: NativeImage) => `data:image/jpeg;base64,${i.toJPEG(80).toString("base64")}`

function fit(i: NativeImage, max: number): NativeImage {
  const { width, height } = i.getSize()
  const k = Math.min(1, max / Math.max(width, height))
  return k < 1 ? i.resize({ width: Math.round(width * k), height: Math.round(height * k), quality: "good" }) : i
}

/** `shot` is the page as captured right after the note was submitted; `n` is the note's number.
 *  `before`, for a canvas note, is the same viewport with the reviewer's edits switched off: it
 *  goes first, cut the same way as the picture after it, and both say which they are by name. */
export function noteImages(shot: NativeImage, note: PageNote, n: number, before?: NativeImage): PromptFile[] {
  const size = shot.getSize()
  const vw = note.viewport.w
  const vh = note.viewport.h
  // The capture is in device pixels, the note in CSS pixels.
  const s = size.width / vw
  const b = note.bounds
  const x0 = b ? Math.max(0, b.x - CROP_MARGIN) : 0
  const y0 = b ? Math.max(0, b.y - CROP_MARGIN) : 0
  const x1 = b ? Math.min(vw, b.x + b.w + CROP_MARGIN) : vw
  const y1 = b ? Math.min(vh, b.y + b.h + CROP_MARGIN) : vh
  // No selection, or a crop covering most of the viewport: one viewport image at crop resolution.
  if (!b || x1 <= x0 || y1 <= y0 || (x1 - x0) * (y1 - y0) > 0.6 * vw * vh)
    return before
      ? [
          { uri: jpeg(fit(before, CROP_MAX)), name: `note-${n}-before.jpg` },
          { uri: jpeg(fit(shot, CROP_MAX)), name: `note-${n}-after.jpg` },
        ]
      : [{ uri: jpeg(fit(shot, CROP_MAX)), name: `note-${n}.jpg` }]
  const area = {
    x: Math.round(x0 * s),
    y: Math.round(y0 * s),
    width: Math.min(size.width, Math.round((x1 - x0) * s)),
    height: Math.min(size.height, Math.round((y1 - y0) * s)),
  }
  const crop = (i: NativeImage) => jpeg(fit(i.crop(area), CROP_MAX))
  return [
    ...(before ? [{ uri: crop(before), name: `note-${n}-before-area.jpg` }] : []),
    { uri: crop(shot), name: before ? `note-${n}-after-area.jpg` : `note-${n}-area.jpg` },
    { uri: jpeg(fit(shot, THUMB_MAX)), name: `note-${n}-viewport.jpg` },
  ]
}
