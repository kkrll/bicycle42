// The page view (src/main/page.ts), for controller tests: no browser, just a URL, a record of
// what the controller sent to the overlay, and a way for the test to speak as the overlay.
import type { Page, PageMessage, PageState } from "../../src/main/page"

type Options = { onMessage(msg: PageMessage): void; onChange(): void }

export const pageStub = {
  /** Speak as the overlay. */
  message: (_msg: PageMessage) => {},
  /** What the controller sent to the overlay, plus { type: "RELOAD" } for reloadWhenIdle(). */
  sent: [] as { type: string; [k: string]: unknown }[],
  /** Set by a test that wants screenshots: returns the next picture (see `fakeShot`). */
  capture: undefined as (() => unknown) | undefined,
  /** Set by a test that has the page answer a script (its width, where it is scrolled). */
  evaluate: undefined as ((js: string) => unknown) | undefined,
  page: undefined as Page | undefined,
}
;(globalThis as Record<string, unknown>).__pageStub = pageStub

/** Stands in for a NativeImage: every crop and resize of it is still "it", and its JPEG is its name. */
export function fakeShot(name: string, width = 800, height = 600): unknown {
  const shot = { getSize: () => ({ width, height }), crop: () => shot, resize: () => shot, toJPEG: () => Buffer.from(name) }
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
    send: (msg: { type: string }) => void pageStub.sent.push(msg),
    // No pixels here: the controller sends the note without a screenshot, unless the test gives one.
    capture: () => (pageStub.capture ? Promise.resolve(pageStub.capture()) : Promise.reject(new Error("no screenshots in this test"))),
    reloadWhenIdle: () => void pageStub.sent.push({ type: "RELOAD" }),
    evaluate: async (js: string) => pageStub.evaluate?.(js),
    // The overlay is never mid-note here.
    overlay: async () => false,
    focus() {},
    dispose() {},
  } as unknown as Page
  pageStub.message = opts.onMessage
  pageStub.sent.length = 0
  pageStub.capture = undefined
  pageStub.evaluate = undefined
  pageStub.page = page
  return page
}
