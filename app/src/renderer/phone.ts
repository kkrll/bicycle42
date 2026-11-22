// A phone's frame as the window draws it around a phone's page (phone-frame.tsx): its sizes at
// the size it is drawn, and the ink on its strips. No Solid here, so the tests can read it.
import { viewportOf, type Phone } from "../shared/types"

/** The phone drawn at `fit` (1 is life size), in whole px: the body (the whole screen), the status
 *  strip above, the page's box between and the home strip below. The page's box is the
 *  viewport at the page's scale (its width over the phone's, as main draws it), and the strips
 *  take what is left, so the three add up to the body exactly and the native view sits on whole
 *  pixels. */
export function frameOf(p: Phone, fit: number) {
  const width = Math.round(p.width * fit)
  const scale = width / p.width
  const height = Math.round(p.height * scale)
  const screen = Math.round(viewportOf(p).height * scale)
  const top = Math.min(height - screen, Math.round(p.top * scale))
  return { width, height, top, screen, bottom: height - screen - top, scale, radius: Math.round(p.radius * scale) }
}

/** The relative luminance of "#rrggbb" (WCAG 2), or undefined for anything else. */
function luminance(hex: string) {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)
  if (!m) return undefined
  const [r, g, b] = m.slice(1).map((h) => {
    const c = parseInt(h, 16) / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}

/** Black or white, whichever reads better on `hex` (the larger contrast ratio), as a phone draws
 *  its status bar's time and icons over the colour its browser gives it. White on what is not a
 *  colour. */
export function inkOn(hex: string): "#000000" | "#ffffff" {
  const l = luminance(hex)
  if (l === undefined) return "#ffffff"
  return (l + 0.05) / 0.05 > 1.05 / (l + 0.05) ? "#000000" : "#ffffff"
}
