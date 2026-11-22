// The phone the window draws around a phone's page: the status strip above it (the time, the
// camera's cut-out, signal, wifi and battery). The page itself is a native view below the strip,
// down to the screen's bottom edge (app.tsx lays the two out in the phone's body, with the ring
// around it; phone.ts has the sizes). Nothing here can be over the page: the view paints above
// this document. So what of the phone is over the page (the home indicator, the screen's rounded
// bottom corners) is drawn by the page's overlay, in the colours the window has around the
// screen, which surroundOf reads and main passes on.
//
// The strip is drawn at life size and zoomed to the size the phone is drawn, so a phone drawn at
// 80% has its time at 80% too. Its colour is what a phone's browser gives its status bar for the
// page (page.tint, which main asks the page for), its ink black or white by contrast; black with
// white ink until main knows.
import { Show } from "solid-js"
import type { Phone, PhoneSurround } from "../shared/types"
import { inkOn } from "./phone"
import "./phone-frame.css"

const UNKNOWN = "#000000" // kkrll-ignore: a phone's status bar before the page's colour is known, black in either theme

const Signal = () => (
  <svg /* kkrll-ignore: a phone's status bar glyph, drawn at the phone's own sizes, not one of the app's icons */
    class="pf-signal" width="17" height="11" viewBox="0 0 17 11" aria-hidden="true">
    <rect x="0" y="7" width="3" height="4" rx="1" />
    <rect x="4.5" y="5" width="3" height="6" rx="1" />
    <rect x="9" y="2.5" width="3" height="8.5" rx="1" />
    <rect x="13.5" y="0" width="3" height="11" rx="1" />
  </svg>
)

const Wifi = () => (
  <svg /* kkrll-ignore: a phone's status bar glyph, drawn at the phone's own sizes, not one of the app's icons */
    class="pf-wifi" width="15" height="11" viewBox="0 0 15 11" aria-hidden="true">
    <path d="M7.5 10.6 4.67 7.77a4 4 0 0 1 5.66 0Z" />
    <path d="M2.55 5.65a7 7 0 0 1 9.9 0" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" />
    <path d="M.8 3.9a9.5 9.5 0 0 1 13.4 0" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" />
  </svg>
)

const Battery = () => (
  <svg /* kkrll-ignore: a phone's status bar glyph, drawn at the phone's own sizes, not one of the app's icons */
    class="pf-battery" width="25" height="12" viewBox="0 0 27 13" aria-hidden="true">
    <rect x="0.5" y="0.5" width="23" height="12" rx="3.5" fill="none" stroke="currentColor" opacity="0.4" />
    <rect x="2" y="2" width="20" height="9" rx="2" />
    <rect x="24.5" y="4.5" width="1.6" height="4" rx="0.8" opacity="0.4" />
  </svg>
)

/** The strip above the page: `height` is its drawn height, `scale` the phone's (1 at life size). */
export function StatusStrip(props: { phone: Phone; height: number; scale: number; tint?: string }) {
  const tint = () => props.tint ?? UNKNOWN
  return (
    <div class="pf-status" data-cutout={props.phone.cutout} style={{ height: `${props.height}px`, "--strip": `${props.phone.top}px`, background: tint(), color: inkOn(tint()) }} aria-hidden="true">
      <div class="pf-in" style={{ width: `${props.phone.width}px`, height: `${props.phone.top}px`, zoom: props.scale }}>
        <span class="pf-side pf-left">
          <Show when={props.phone.cutout === "none"} fallback={<span class="pf-time">9:41</span>}>
            <Signal />
            <Wifi />
          </Show>
        </span>
        <span class="pf-middle">
          <Show when={props.phone.cutout === "none"} fallback={<span class="pf-cutout" />}>
            <span class="pf-time">9:41</span>
          </Show>
        </span>
        <span class="pf-side pf-right">
          <Show when={props.phone.cutout !== "none"}>
            <Signal />
            <Wifi />
          </Show>
          <Battery />
        </span>
      </div>
    </div>
  )
}

/** What the window draws around the phone's screen: its corners' shape (the design system's
 *  squircle), the body's ring (its outline, over what is behind the body) and what is behind it,
 *  opaque, as "#rrggbb", in the theme on now. The page's overlay paints them outside the screen's
 *  bottom corners, where the page view covers the window (setPhoneSurround). Undefined when the
 *  body has no ring (not a phone's). */
export function surroundOf(body: HTMLElement): PhoneSurround | undefined {
  const ring = parseFloat(getComputedStyle(body).outlineWidth)
  if (getComputedStyle(body).outlineStyle === "none" || !(ring > 0)) return undefined
  const g = document.createElement("canvas").getContext("2d", { willReadFrequently: true })
  if (!g) return undefined
  g.canvas.width = g.canvas.height = 1
  // What is behind the body, as the window composites it: each ancestor's background, from the
  // first opaque one (or the window's own) in.
  const layers: string[] = []
  for (let el = body.parentElement; el; el = el.parentElement) {
    const c = getComputedStyle(el).backgroundColor
    layers.unshift(c)
    if (alpha(g, c) >= 1) break
  }
  const hex = () => {
    const d = g.getImageData(0, 0, 1, 1).data
    return "#" + [d[0]!, d[1]!, d[2]!].map((n) => n.toString(16).padStart(2, "0")).join("")
  }
  g.fillStyle = "#ffffff" // kkrll-ignore: a window with no background of its own anywhere is white, as Chromium draws it
  g.fillRect(0, 0, 1, 1)
  for (const c of layers) (g.fillStyle = c), g.fillRect(0, 0, 1, 1)
  const around = hex()
  g.fillStyle = getComputedStyle(body).outlineColor
  g.fillRect(0, 0, 1, 1)
  return { shape: getComputedStyle(body).getPropertyValue("corner-shape") || "round", ring, ringColour: hex(), around }
}

/** How opaque a CSS colour is, 0 to 1, as the canvas reads it. */
function alpha(g: CanvasRenderingContext2D, colour: string) {
  g.clearRect(0, 0, 1, 1)
  g.fillStyle = colour
  g.fillRect(0, 0, 1, 1)
  return g.getImageData(0, 0, 1, 1).data[3]! / 255
}
