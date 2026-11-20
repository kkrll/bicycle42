// The preload of the page under review (main/page.ts): it puts the overlay into the page.
//
// Electron runs it before the page's own scripts, in a script world of its own (contextIsolation),
// and only in the top frame. The overlay runs here, in that world: it shares the page's document,
// but the page's scripts can't see its globals or reach ipcRenderer. Its way to the app is the
// same as it always was, window.__review(json), defined in this world only; the app's messages
// come in over IPC and go to window.__b42.receive.
//
// The overlay's code is in this file, put here by scripts/build.mjs ("b42:page-overlay"): a
// sandboxed preload can't read files, and nothing has to wait for main to send it.
import { contextBridge, ipcRenderer, webFrame } from "electron"
import { lookup, overlay } from "b42:page-overlay"

/** overlay → main, and main → overlay: the channels main/page.ts listens and sends on. */
const FROM_OVERLAY = "b42:overlay-says"
const TO_OVERLAY = "b42:host-says"
/** Asked at once, before the page's first script: is this document shown as a phone's? */
const IS_PHONE = "b42:is-phone"

// The placeholder and the blank first page are the app's own: no overlay there.
if (window === window.top && !/^(data|about):$/.test(location.protocol)) {
  // What a framework calls an element is in the page's own objects: that one lookup runs among the
  // page's scripts, before any of them, and answers the overlay through an event (component.js).
  try {
    contextBridge.executeInMainWorld({ func: lookup })
  } catch (err) {
    console.warn("[b42] the component lookup did not start", err)
  }
  // A phone's document starts with a scrollbar that takes no room, until it has loaded: main
  // can only make it a phone's (overlay scrollbars and all) a moment after it began, and a
  // layout before that with a desktop's scrollbar leaves the page zoomed out too far for good
  // (main/page.ts says how). Once it is a phone's the rule changes nothing, and it goes, so the
  // page's own rules for its scrollbar count as they did.
  try {
    if (ipcRenderer.sendSync(IS_PHONE) === true) {
      const rule = webFrame.insertCSS("html::-webkit-scrollbar { width: 0; height: 0 }")
      // (A page whose load never ends, one request that never answers, is not left without its
      // scrollbar's rules: by then it has long been a phone's.)
      let there = true
      const back = () => there && ((there = false), webFrame.removeInsertedCSS(rule))
      window.addEventListener("load", () => setTimeout(back, 200), { once: true })
      setTimeout(back, 4000)
    }
  } catch (err) {
    console.warn("[b42] the phone's scrollbar was not set", err)
  }
  Object.defineProperty(window, "__review", { value: (json: string) => ipcRenderer.send(FROM_OVERLAY, json) })
  ipcRenderer.on(TO_OVERLAY, (_event, msg: string) => window.__b42?.receive(msg))
  overlay()
}
