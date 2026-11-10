// A message's pictures, large. One native <dialog> for the whole window: Esc closes it (the
// browser does that), the arrow keys walk the message's pictures, a click outside closes it.
//
// It covers the panel, not the window: the page is a native view that paints over everything on
// its side of the window, so anything drawn there would sit under it.
import { setPageCovered } from "./store"
import { Show, createSignal } from "solid-js"
import { render } from "solid-js/web"
import type { ChatImage } from "../shared/types"
import { Icon } from "./icons"

const [images, setImages] = createSignal<ChatImage[]>([])
const [index, setIndex] = createSignal(0)
let dialog: HTMLDialogElement | undefined
let opener: HTMLElement | null = null

function step(by: number) {
  const n = images().length
  if (n > 1) setIndex((index() + by + n) % n)
}

function mount(): HTMLDialogElement {
  if (dialog) return dialog
  const host = document.createElement("div")
  document.body.append(host)
  render(
    () => (
      <dialog
        class="lightbox"
        ref={dialog}
        aria-label="Picture"
        onClose={() => {
          setPageCovered(false)
          setImages([])
          opener?.focus()
        }}
        onClick={(e) => e.target === e.currentTarget && dialog!.close()}
        onKeyDown={(e) => {
          if (e.key === "ArrowRight") step(1)
          else if (e.key === "ArrowLeft") step(-1)
          else return
          e.preventDefault()
        }}
      >
        <Show when={images()[index()]}>
          {(img) => (
            <>
              <div class="lightbox-head">
                <span class="lightbox-name" title={img().name}>
                  {img().name}
                </span>
                <Show when={images().length > 1}>
                  <span class="lightbox-count">
                    {index() + 1} of {images().length}
                  </span>
                  <button class="icon-btn" aria-label="Previous picture" title="Previous (←)" onClick={() => step(-1)}>
                    <Icon name="back" />
                  </button>
                  <button class="icon-btn" aria-label="Next picture" title="Next (→)" onClick={() => step(1)}>
                    <Icon name="forward" />
                  </button>
                </Show>
                <button class="icon-btn" aria-label="Close" title="Close (Esc)" onClick={() => dialog!.close()}>
                  <Icon name="close" />
                </button>
              </div>
              <img class="lightbox-img" src={img().src} alt={img().name} />
            </>
          )}
        </Show>
      </dialog>
    ),
    host,
  )
  return dialog!
}

export function openLightbox(list: ChatImage[], at: number): void {
  const d = mount()
  opener = document.activeElement as HTMLElement | null
  setImages([...list])
  setIndex(at)
  // The whole window: the page view is taken away while the picture is open.
  setPageCovered(true)
  if (!d.open) d.showModal()
}
