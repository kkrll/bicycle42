// The page's docks, drawn by the window: edit mode's inspector and motion mode's dock, for the
// ones the overlay was told the window draws (state.review.docks; see Dock in overlay/protocol.ts).
//
// A dock here is a drawing of what the overlay says it shows (dockViews in store.ts) and a source
// of what the reviewer does in it (dockAct): it keeps nothing of the page's itself, so a reload of
// the page or of the window loses nothing. What it is given is the page's own text (a class, a
// keyframe's name): drawn as text, never as markup.
//
// Where it sits is the window's business (app.tsx): under the page, or beside it when the page
// is shown as a phone's. A dock fills the box it is given and scrolls inside it.
//
// Beside a phone's page in a mode with no dock (Preview, Annotate) the column is "This page on
// this phone" (PhoneAside, facts-pane.tsx): a pane of the window's that is no mode's dock. Beside
// a phone's page in Edit and Motion the dock has the same pane's top line on top (PhoneLine): how
// many of each, kept up to date as the page is edited, at the same place and the same height as
// in the pane, so a mode change moves nothing there. A desktop's page has no column and neither.
import { Show, type Component } from "solid-js"
import { Dynamic } from "solid-js/web"
import type { Dock } from "../shared/types"
import { CanvasDock } from "./canvas-dock"
import { FactsPane, PhoneLine } from "./facts-pane"
import { MotionDock } from "./motion-dock"
import { state } from "./store"

/** The component of each dock the window can draw. One that is not here yet is the overlay's. */
const DOCKS: Partial<Record<Dock, Component>> = {
  canvas: CanvasDock,
  motion: MotionDock,
}

const NAME: Record<Dock, string> = { canvas: "Inspector", motion: "Animations" }

/** The dock of the mode that is on, when the window draws it: else null, and the overlay's own
 *  dock (if any) is on the page. */
export function dockShown(): Dock | null {
  const dock: Dock | null = !state.review.enabled ? null : state.review.mode === "edit" ? "canvas" : state.review.mode === "motion" ? "motion" : null
  return dock && state.page.url !== "" && state.review.docks.includes(dock) ? dock : null
}

export function DockRegion(props: { dock: Dock }) {
  const phone = () => state.page.device === "phone" && state.page.url !== "" && state.review.docks.includes("facts")
  return (
    <section class="dock" data-dock={props.dock} aria-label={NAME[props.dock]}>
      <Show when={phone()}>
        <PhoneLine />
      </Show>
      <Show when={DOCKS[props.dock]} fallback={<p class="dock-empty">{NAME[props.dock]}</p>}>
        {(dock) => <Dynamic component={dock()} />}
      </Show>
    </section>
  )
}

/** The column beside a phone's page when no dock is shown in it: the facts pane, when the window
 *  draws it (else an empty pane: the column keeps its place). */
export function PhoneAside() {
  return (
    <Show when={state.review.docks.includes("facts")} fallback={<section class="dock" aria-label="This page on this phone" />}>
      <FactsPane />
    </Show>
  )
}
