// Copy to the clipboard, with a moment of "Copied" so the reviewer knows it worked.
import { Show, createSignal, onCleanup } from "solid-js"
import { Icon } from "./icons"
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
        timer = window.setTimeout(() => setCopied(false), 1500)
      }}
    >
      <Icon name={copied() ? "check" : "copy"} />
      <Show when={copied()} fallback={<span>Copy</span>}>
        <span>Copied</span>
      </Show>
    </button>
  )
}
