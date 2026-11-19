// A shell for the controller (src/main/core.ts) in plain Node, where src/main/index.ts is the
// Electron one: a folder, no keychain, a record of what went to the window, and a page that is
// no browser, just a URL, a record of what the controller sent to the overlay, and a way for the
// test to speak as the overlay.
import { createCore, type Core } from "../../src/main/core"
import type { Frame } from "../../src/main/images"
import type { Page, PageMessage, PageState } from "../../src/main/page"

export type TestShell = {
  core: Core
  /** [stream, value] for everything the controller sent to the window. */
  sent: [string, unknown][]
  dialogs: unknown[]
  page: {
    load(url: string): void
    /** Speak as the overlay (which may say anything). */
    message(msg: unknown): void
    /** What the controller sent to the overlay, plus { type: "RELOAD" } for reloadWhenIdle(). */
    sent: { type: string; [k: string]: unknown }[]
    /** Set by a test that wants screenshots: returns the next picture. */
    capture?: () => Frame
    /** [what, value] for each call the controller or the shell made on the page: "bounds", "load" and "device". */
    calls: [string, unknown][]
    /** Set by a test whose page has an overlay that answers "frame": the window it says it has. */
    viewport?: { w: number; h: number; dpr: number; scrollX: number; scrollY: number }
  }
}

/** Starts a controller on `dataDir` the way the shell does: the page made, laid out where it was
 *  last and hidden, loaded at the address it was last at, then `start`. */
export function testShell(dataDir: string, opts: { docks?: ("canvas" | "motion")[] } = {}): TestShell {
  const sent: TestShell["sent"] = []
  const dialogs: unknown[] = []
  const core = createCore({
    dataDir,
    secrets: { available: () => false, encrypt: (secret) => Buffer.from(secret), decrypt: String },
    emit: (stream, value) => void sent.push([stream, value]),
    dialog: (box) => void dialogs.push(box),
    ...(opts.docks ? { docks: opts.docks } : {}),
    log: (level, msg, data) => console[level === "info" ? "log" : level](`[bicycle42] ${msg}`, data === undefined ? "" : data),
  })

  let url = ""
  const state = (): PageState => ({ url, loading: false, canGoBack: false, canGoForward: false, hmr: false })
  const stub: TestShell["page"] = {
    load: (next) => page.load(next),
    message: (msg) => core.pageEvents.onMessage(msg as PageMessage),
    sent: [],
    calls: [],
  }
  const page: Page = {
    state,
    load(next) {
      stub.calls.push(["load", next])
      url = next
      core.pageEvents.onChange()
    },
    reload() {},
    back() {},
    forward() {},
    setBounds: (bounds) => void stub.calls.push(["bounds", bounds]),
    setDevice: (device) => void stub.calls.push(["device", device]),
    send(msg) {
      stub.sent.push(msg)
      // The overlay answers a "frame" a moment later, as it does two frames on.
      const viewport = stub.viewport
      if (msg.type === "frame" && viewport) setImmediate(() => core.pageEvents.onMessage({ type: "frame-shown", id: msg.id, viewport }))
    },
    // No pixels here: the controller sends the note without a screenshot, unless the test gives one.
    capture: () => (stub.capture ? Promise.resolve(stub.capture()) : Promise.reject(new Error("no screenshots in this test"))),
    reloadWhenIdle: () => void stub.sent.push({ type: "RELOAD" }),
    // The overlay is never mid-note here.
    busy: async () => false,
    holdFrames: () => () => {},
    focus() {},
    openDevTools() {},
    dispose() {},
  }
  core.attach(page)
  const last = core.lastPageBounds()
  if (last) page.setBounds(last)
  page.setBounds(null)
  page.load(core.lastUrl())
  core.start()
  return { core, sent, dialogs, page: stub }
}
