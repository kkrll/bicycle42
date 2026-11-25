// Colour, for the design system's picker (ds-space.tsx): sRGB to OKLCH and back, and a colour
// written in the notation its author chose. No DOM here, so the tests can read it.
//
// The picker works in OKLCH (lightness, chroma, hue): equal steps look equal, and a ramp is one
// hue at falling lightness. Björn Ottosson's OKLab matrices.

/** sRGB, each 0…1 (not clamped: out of 0…1 is out of sRGB's gamut), and alpha 0…1. */
export type Rgb = { r: number; g: number; b: number; a: number }
/** l 0…1, c 0…~0.4, h in degrees. */
export type Oklch = { l: number; c: number; h: number }

export type Notation = "hex" | "rgb" | "hsl" | "hwb" | "oklch" | "oklab"
export const NOTATIONS: readonly Notation[] = ["hex", "rgb", "hsl", "hwb", "oklch", "oklab"]

const lin = (c: number) => (Math.abs(c) <= 0.04045 ? c / 12.92 : Math.sign(c) * ((Math.abs(c) + 0.055) / 1.055) ** 2.4)
const gam = (c: number) => (Math.abs(c) <= 0.0031308 ? c * 12.92 : Math.sign(c) * (1.055 * Math.abs(c) ** (1 / 2.4) - 0.055))

export function toOklab(rgb: Rgb): { l: number; a: number; b: number } {
  const r = lin(rgb.r), g = lin(rgb.g), b = lin(rgb.b)
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return {
    l: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  }
}

export function toOklch(rgb: Rgb): Oklch {
  const { l, a, b } = toOklab(rgb)
  const c = Math.hypot(a, b)
  // (A grey has no hue: 0, and the picker keeps the one it had.)
  return { l, c: c < 1e-5 ? 0 : c, h: c < 1e-5 ? 0 : ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360 }
}

/** Not clamped: a colour outside sRGB has a part under 0 or over 1. */
export function fromOklch(o: Oklch, alpha = 1): Rgb {
  const a = o.c * Math.cos((o.h * Math.PI) / 180), b = o.c * Math.sin((o.h * Math.PI) / 180)
  const l = (o.l + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (o.l - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (o.l - 0.0894841775 * a - 1.291485548 * b) ** 3
  return {
    r: gam(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: gam(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: gam(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
    a: alpha,
  }
}

const EPS = 0.0005
export const inSrgb = (c: Rgb) => c.r >= -EPS && c.r <= 1 + EPS && c.g >= -EPS && c.g <= 1 + EPS && c.b >= -EPS && c.b <= 1 + EPS

/** The most chroma sRGB can show at this lightness and hue (to 0.001). */
export function maxChroma(l: number, h: number): number {
  let lo = 0, hi = 0.4
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2
    if (inSrgb(fromOklch({ l, c: mid, h }))) lo = mid
    else hi = mid
  }
  return lo
}

/** The colour in sRGB: as it is, or with as much of its chroma as sRGB can show. */
export function intoSrgb(o: Oklch, alpha = 1): Rgb {
  let c = fromOklch(o, alpha)
  if (!inSrgb(c)) c = fromOklch({ ...o, c: Math.min(o.c, maxChroma(o.l, o.h)) }, alpha)
  const clip = (x: number) => Math.min(1, Math.max(0, x))
  return { r: clip(c.r), g: clip(c.g), b: clip(c.b), a: alpha }
}

function toHsl(c: Rgb): { h: number; s: number; l: number } {
  const max = Math.max(c.r, c.g, c.b), min = Math.min(c.r, c.g, c.b), d = max - min
  const l = (max + min) / 2
  let h = 0
  if (d > 1e-6) {
    if (max === c.r) h = ((c.g - c.b) / d) % 6
    else if (max === c.g) h = (c.b - c.r) / d + 2
    else h = (c.r - c.g) / d + 4
    h = (h * 60 + 360) % 360
  }
  return { h, s: d < 1e-6 ? 0 : d / (1 - Math.abs(2 * l - 1)), l }
}

/** A number as short as it can be said to `places`. */
const n = (x: number, places: number) => String(Number(x.toFixed(places)))
const pct = (x: number, places = 0) => `${n(x * 100, places)}%`
const byte = (x: number) => Math.round(Math.min(1, Math.max(0, x)) * 255)
const hex2 = (x: number) => byte(x).toString(16).padStart(2, "0")

/** The colour in a notation, as CSS: `#b1a79f`, `rgb(177 167 159)`, `oklch(0.73 0.02 60)`. The
 *  alpha only when it is not 1. `o` is the colour as the picker has it, so OKLCH and OKLAB say
 *  what was chosen (it may be outside sRGB); the others say it as sRGB shows it. */
export function write(notation: Notation, o: Oklch, alpha = 1): string {
  const c = intoSrgb(o, alpha)
  const al = alpha < 0.9995 ? ` / ${n(alpha, 2)}` : ""
  switch (notation) {
    case "hex":
      return `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}${alpha < 0.9995 ? hex2(alpha) : ""}`
    case "rgb":
      return `rgb(${byte(c.r)} ${byte(c.g)} ${byte(c.b)}${al})`
    case "hsl": {
      const { h, s, l } = toHsl(c)
      return `hsl(${n(h, 1)} ${pct(s, 1)} ${pct(l, 1)}${al})`
    }
    case "hwb": {
      const { h } = toHsl(c)
      return `hwb(${n(h, 1)} ${pct(Math.min(c.r, c.g, c.b), 1)} ${pct(1 - Math.max(c.r, c.g, c.b), 1)}${al})`
    }
    case "oklch":
      return `oklch(${n(o.l, 3)} ${n(o.c, 3)} ${n(o.h, 1)}${al})`
    case "oklab": {
      const a = o.c * Math.cos((o.h * Math.PI) / 180), b = o.c * Math.sin((o.h * Math.PI) / 180)
      return `oklab(${n(o.l, 3)} ${n(a, 3)} ${n(b, 3)}${al})`
    }
  }
}

/** The notation a value is written in; a named colour, `color-mix()` and the like count as hex
 *  (what they would be rewritten as). */
export function notationOf(value: string): Notation {
  const v = value.trim().toLowerCase()
  if (v.startsWith("oklch(")) return "oklch"
  if (v.startsWith("oklab(")) return "oklab"
  if (v.startsWith("hsl")) return "hsl"
  if (v.startsWith("hwb(")) return "hwb"
  if (v.startsWith("rgb")) return "rgb"
  return "hex"
}

/** WCAG 2's relative luminance, and the contrast of two colours (1…21). */
export const luminance = (c: Rgb) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b)
export function contrast(a: Rgb, b: Rgb): number {
  const x = luminance(a), y = luminance(b)
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}
