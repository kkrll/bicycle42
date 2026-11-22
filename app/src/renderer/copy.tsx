// Copy to the clipboard, with a moment of "Copied" so the reviewer knows it worked.
import { createSignal, onCleanup } from "solid-js"
import { Icon, iconElement } from "./icons"
import { message, setNotice } from "./store"

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch (err) {
    setNotice(`Couldn't copy: ${message(err)}`)
    return false
  }
}

/** How long "Copied" stays. */
const SHOWN = 1500

/** Both words are always there, in one grid cell, the one not said hidden: the button is as wide
 *  as "Copied" from the start, so saying it moves nothing under the pointer. Its size is the
 *  CSS's (.copy-btn), never the component's, so a screen can give it another. */
export function CopyButton(props: { text: () => string; label: string; class?: string }) {
  const [copied, setCopied] = createSignal(false)
  let timer = 0
  onCleanup(() => clearTimeout(timer))
  return (
    <button
      class={`copy-btn ${props.class ?? ""}`}
      classList={{ copied: copied() }}
      aria-label={copied() ? "Copied" : props.label}
      title={props.label}
      onClick={async () => {
        if (!(await copyText(props.text()))) return
        setCopied(true)
        clearTimeout(timer)
        timer = window.setTimeout(() => setCopied(false), SHOWN)
      }}
    >
      <Icon name={copied() ? "check" : "copy"} />
      <span class="copy-words">
        <span>Copy</span>
        <span>Copied</span>
      </span>
    </button>
  )
}

/** The same button as CopyButton, for markup built outside Solid (a code block's header). Its
 *  click is the builder's to handle, with copiedElement after the copy. */
export function copyButtonElement(label: string, cls = ""): HTMLButtonElement {
  const b = document.createElement("button")
  b.type = "button"
  b.className = `copy-btn ${cls}`.trim()
  b.title = label
  b.setAttribute("aria-label", label)
  const words = document.createElement("span")
  words.className = "copy-words"
  for (const w of ["Copy", "Copied"]) {
    const span = document.createElement("span")
    span.textContent = w
    words.append(span)
  }
  b.append(iconElement("copy"), words)
  return b
}

/** Says "Copied" on a button from copyButtonElement for a moment. */
export function copiedElement(b: HTMLButtonElement): void {
  const show = (on: boolean) => {
    b.classList.toggle("copied", on)
    b.setAttribute("aria-label", on ? "Copied" : b.title)
    b.querySelector("svg")?.replaceWith(iconElement(on ? "check" : "copy"))
  }
  show(true)
  clearTimeout(Number(b.dataset.timer))
  b.dataset.timer = String(window.setTimeout(() => show(false), SHOWN))
}
