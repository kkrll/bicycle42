// The page view (src/main/page.ts), for controller tests: no browser, just a URL, a record of
// what the controller sent to the overlay, and a way for the test to speak as the overlay.
import type { Frame } from "../../src/main/images"
import type { Page, PageMessage, PageState } from "../../src/main/page"

type Options = { onMessage(msg: PageMessage): void; onChange(): void }

export const pageStub = {
  /** Speak as the overlay. */
  message: (_msg: PageMessage) => {},
  /** What the controller sent to the overlay, plus { type: "RELOAD" } for reloadWhenIdle(). */
  sent: [] as { type: string; [k: string]: unknown }[],
  /** Set by a test that wants screenshots: returns the next picture (see `fakeShot`). */
  capture: undefined as (() => Frame) | undefined,
  /** Set by a test whose page has an overlay that answers "frame": the window it says it has. */
  viewport: undefined as { w: number; h: number; dpr: number; scrollX: number; scrollY: number } | undefined,
  page: undefined as Page | undefined,
}
;(globalThis as Record<string, unknown>).__pageStub = pageStub

/** Stands in for a captured frame: every crop and resize of it is still "it", and its JPEG is its name. */
export function fakeShot(name: string, width = 800, height = 600): Frame {
  const shot: Frame = { getSize: () => ({ width, height }), crop: () => shot, resize: () => shot, toJPEG: () => Buffer.from(name) }
  return shot
}

export async function createPage(_window: unknown, opts: Options): Promise<Page> {
  let url = ""
  const state = (): PageState => ({ url, loading: false, canGoBack: false, canGoForward: false, hmr: false })
  const page = {
    view: { webContents: {} },
    state,
    load(next: string) {
      url = next
      opts.onChange()
    },
    reload() {},
    back() {},
    forward() {},
    setBounds() {},
    send(msg: { type: string; id?: string }) {
      pageStub.sent.push(msg)
      // The overlay answers a "frame" a moment later, as it does two frames on.
      const viewport = pageStub.viewport
      if (msg.type === "frame" && viewport) setImmediate(() => opts.onMessage({ type: "frame-shown", id: msg.id!, viewport }))
    },
    // No pixels here: the controller sends the note without a screenshot, unless the test gives one.
    capture: () => (pageStub.capture ? Promise.resolve(pageStub.capture()) : Promise.reject(new Error("no screenshots in this test"))),
    reloadWhenIdle: () => void pageStub.sent.push({ type: "RELOAD" }),
    evaluate: async () => undefined,
    // The overlay is never mid-note here.
    overlay: async () => false,
    holdFrames: () => () => {},
    focus() {},
    dispose() {},
  } as unknown as Page
  pageStub.message = opts.onMessage
  pageStub.sent.length = 0
  pageStub.capture = undefined
  pageStub.viewport = undefined
  pageStub.page = page
  return page
}
