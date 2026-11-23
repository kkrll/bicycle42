// The sheet of keys: what the window and the page answer to, in one place ("?" outside a field,
// or Help ▸ Keyboard Shortcuts). It lists the keys the app has (README, Keys); it binds none of
// them. Edit's and Motion's own keys are in their docks' "?" lists, beside what they act on.
import { For, onCleanup, onMount } from "solid-js"
import { Icon, Kbd } from "./icons"
import { keys } from "./store"

/** A key (as `keys()` names it), or a word beside keys ("hold", "click"). */
type Part = string | { word: string }
/** Keys that do the same, or one each for the things `what` lists in order: each is one or more parts. */
type Row = { keys: Part[][]; what: string }

const or = (...k: (Part | Part[])[]): Part[][] => k.map((p) => (Array.isArray(p) ? p : [p]))
const w = (word: string) => ({ word })

function groups(): { name: string; rows: Row[] }[] {
  return [
    {
      name: "Modes, anywhere",
      rows: [
        { keys: or(keys("mod", "U")), what: "Preview; again, back to the mode you were in" },
        { keys: or([w("hold"), keys("alt", "A")]), what: "Peek: the page without the layer while held" },
        { keys: or(keys("mod", "P"), keys("mod", "O"), keys("mod", "I")), what: "Annotate, Edit, Motion" },
        { keys: or(keys("mod", "shift", "P"), [keys("alt"), w("drag")]), what: "Draw on the page" },
      ],
    },
    {
      name: "Window",
      rows: [
        { keys: or(keys("mod", "J"), keys("mod", "\\")), what: "Show or hide the notes and the conversation" },
        { keys: or(keys("mod", "L")), what: "The address" },
        { keys: or(keys("mod", "K")), what: "The message box" },
        { keys: or(keys("mod", "shift", "C")), what: "Copy the page's address" },
        { keys: or(keys("mod", "R"), "F5"), what: "Reload the page" },
        { keys: or(keys("mod", "="), keys("mod", "-"), keys("mod", "0")), what: "Zoom the app in, out, back to 100%" },
        { keys: or("?"), what: "This list (outside a text field)" },
      ],
    },
    {
      name: "Annotate",
      rows: [
        { keys: or(w("click"), [keys("shift"), w("click")], w("drag")), what: "Select an element, add one, select an area" },
        { keys: or([keys("shift"), w("while drawing")]), what: "A straight line; let go to draw on freehand" },
        { keys: or(keys("up"), keys("down")), what: "Parent, child element (while the note is empty)" },
        { keys: or(keys("enter"), keys("alt", "enter")), what: "Send the note; to the background conversation" },
        { keys: or("Esc"), what: "Cancel the note; again for Preview" },
      ],
    },
    {
      name: "Message box",
      rows: [
        { keys: or(keys("enter")), what: "Send (while the agent works: when it is free)" },
        { keys: or(keys("mod", "enter")), what: "Send into the run under way, where the agent can take it" },
        { keys: or(keys("up")), what: "The message sent before (in an empty box)" },
        { keys: or("/", "@"), what: "Commands; a file of the site's code" },
      ],
    },
    {
      name: "A request from the agent",
      rows: [
        { keys: or(keys("enter")), what: "Allow once (a change folded away is shown first)" },
        { keys: or(keys("mod", "enter")), what: "Always allow" },
      ],
    },
  ]
}

export function KeysSheet(props: { onClose: () => void }) {
  let dialog!: HTMLDialogElement
  onMount(() => dialog.showModal())
  onCleanup(() => dialog.close())
  return (
    <dialog
      class="dialog keys-sheet"
      ref={dialog}
      aria-labelledby="keys-title"
      onClose={props.onClose}
      onClick={(e) => e.target === dialog && dialog.close()}
    >
      <header class="dialog-head">
        <h2 id="keys-title">Keyboard shortcuts</h2>
        <button class="icon-btn" aria-label="Close" title="Close" onClick={() => dialog.close()}>
          <Icon name="close" />
        </button>
      </header>
      <For each={groups()}>
        {(g) => (
          <section class="keys-group" aria-label={g.name}>
            <h3>{g.name}</h3>
            <dl>
              <For each={g.rows}>
                {(r) => (
                  <div class="keys-row">
                    <dt>
                      <For each={r.keys}>
                        {(one, i) => (
                          <>
                            {i() ? <span class="keys-or">/</span> : null}
                            <For each={one}>{(p) => (typeof p === "string" ? <Kbd keys={p} /> : <span class="keys-word">{p.word}</span>)}</For>
                          </>
                        )}
                      </For>
                    </dt>
                    <dd>{r.what}</dd>
                  </div>
                )}
              </For>
            </dl>
          </section>
        )}
      </For>
      <p class="keys-foot">Edit and Motion list their own keys under the ? in their docks.</p>
    </dialog>
  )
}
