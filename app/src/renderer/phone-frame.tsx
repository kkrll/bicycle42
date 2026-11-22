// The phone the window draws around a phone's page: the status strip above it (the time, the
// camera's cut-out, signal, wifi and battery) and the home strip below (the home indicator).
// The page itself is a native view between the two (app.tsx lays the three out in the phone's
// body, with the ring around it; phone.ts has the sizes). Nothing here can be over the page: the
// view paints above this document, so the strips sit beside it, never on it.
//
// Each strip is drawn at life size and zoomed to the size the phone is drawn, so a phone drawn at
// 80% has its time at 80% too. Its colour is the page's own at that edge (page.tint, which main
// asks the page for), its ink black or white by contrast, as a phone's browser colours its bars;
// black with white ink until main knows.
import { Show } from "solid-js"
import type { Phone } from "../shared/types"
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

/** The strip below the page, with the home indicator (or an Android's gesture handle). None on a
 *  phone with a home button: its page goes down to the screen's edge. */
export function HomeStrip(props: { phone: Phone; height: number; scale: number; tint?: string }) {
  const tint = () => props.tint ?? UNKNOWN
  return (
    <Show when={props.height > 0}>
      <div class="pf-home" data-cutout={props.phone.cutout} style={{ height: `${props.height}px`, background: tint(), color: inkOn(tint()) }} aria-hidden="true">
        <div class="pf-in" style={{ width: `${props.phone.width}px`, height: `${props.phone.bottom}px`, zoom: props.scale }}>
          <Show when={props.phone.home}>
            <span class="pf-indicator" />
          </Show>
        </div>
      </div>
    </Show>
  )
}
