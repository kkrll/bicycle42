// A shell for the controller (src/main/core.ts) in plain Node, where src/main/index.ts is the
// Electron one: a folder, a record of what went to the window, and a page that is
// no browser, just a URL, a record of what the controller sent to the overlay, and a way for the
// test to speak as the overlay.
import { createCore, type Core } from "../../src/main/core"
import type { Frame } from "../../src/main/images"
import type { Page, PageMessage, PageState } from "../../src/main/page"
import type { Transport } from "../../src/main/acp"
import type { Pane } from "../../src/shared/types"

export type TestShell = {
  core: Core
  /** [stream, value] for everything the controller sent to the window. */
  sent: [string, unknown][]
  dialogs: unknown[]
  /** The Save dialog: the name each one was opened for, and what it answers (a file, or
   *  undefined as if cancelled), which the test sets before it is opened. */
  saveDialog: { asked: string[]; answer?: string | Promise<string | undefined> }
  page: {
    load(url: string): void
    /** Speak as the overlay (which may say anything). */
    message(msg: unknown): void
    /** What the controller sent to the overlay, plus { type: "RELOAD" } for reloadWhenIdle(). */
    sent: { type: string; [k: string]: unknown }[]
    /** Set by a test that wants screenshots: returns the next picture. */
    capture?: () => Frame
    /** [what, value] for each call the controller or the shell made on the page: "bounds", "load", "device", "admit", and "partition" and "touch" (when they changed). */
    calls: [string, unknown][]
    /** The session the page is in (Page.setPartition): the one the shell made it in, then each
     *  the controller moved it to. */
    partition: string
    /** Set by a test whose page has an overlay that answers "frame": the window it says it has. */
    viewport?: { w: number; h: number; dpr: number; scrollX: number; scrollY: number }
  }
}

/** Starts a controller on `dataDir` the way the shell does: the page made, laid out where it was
 *  last and hidden, loaded at the address it was last at, then `start`. */
export function testShell(dataDir: string, opts: { docks?: Pane[]; agent?: (command: string[]) => Transport } = {}): TestShell {
  const sent: TestShell["sent"] = []
  const dialogs: unknown[] = []
  const saveDialog: TestShell["saveDialog"] = { asked: [] }
  const core = createCore({
    dataDir,
    emit: (stream, value) => void sent.push([stream, value]),
    dialog: (box) => void dialogs.push(box),
    saveDialog: async (name) => {
      saveDialog.asked.push(name)
      return saveDialog.answer
    },
    ...(opts.docks ? { docks: opts.docks } : {}),
    ...(opts.agent ? { agentTransport: opts.agent } : {}),
    log: (level, msg, data) => console[level === "info" ? "log" : level](`[bicycle42] ${msg}`, data === undefined ? "" : data),
  })

  let url = ""
  let touch = false
  const state = (): PageState => ({ url, loading: false, canGoBack: false, canGoForward: false, hmr: false })
  const stub: TestShell["page"] = {
    load: (next) => page.load(next),
    message: (msg) => core.pageEvents.onMessage(msg as PageMessage),
    sent: [],
    calls: [],
    // As the shell makes it: in the session of the saved agent's computer.
    partition: core.partition(),
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
    setDevice: (device, phone) => void stub.calls.push(["device", device], ...(device === "phone" ? [["phone", phone.id] as [string, string]] : [])),
    setZoom: () => undefined,
    setTouch(on) {
      if (on === touch) return
      touch = on
      stub.calls.push(["touch", on])
    },
    setSurround: () => undefined,
    admitNote: () => void stub.calls.push(["admit", null]),
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
    focus: () => void stub.calls.push(["focus", null]),
    openDevTools() {},
    setPartition(name) {
      if (name === stub.partition) return false
      stub.partition = name
      stub.calls.push(["partition", name])
      // A page made again: nothing loaded in it yet.
      url = ""
      core.pageEvents.onChange()
      return true
    },
    dispose() {},
  }
  core.attach(page)
  const last = core.lastPageBounds()
  if (last) page.setBounds(last)
  page.setBounds(null)
  page.load(core.lastUrl())
  core.start()
  return { core, sent, dialogs, saveDialog, page: stub }
}
