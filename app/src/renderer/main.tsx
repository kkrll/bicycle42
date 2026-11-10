// Entry: theme, bridge, mount. Inside the app `window.b42` comes from preload.ts; opened as a
// plain page (or with ?mock) a stand-in is loaded from its own chunk, which the real app never
// fetches.
import { render } from "solid-js/web"
import type { Bridge } from "../shared/types"
import { App } from "./app"
import { start } from "./store"
import "./styles.css"
import "./chat.css"

declare global {
  interface Window {
    b42?: Bridge
  }
}

// Dark mode is the `.dark` class on <html>, following the system and staying in step with it.
const dark = matchMedia("(prefers-color-scheme: dark)")
const applyTheme = () => document.documentElement.classList.toggle("dark", dark.matches)
dark.addEventListener("change", applyTheme)
applyTheme()

// Nothing in this window navigates. A link in the agent's reply is handed to main, which opens
// web addresses in the system browser and refuses everything else.
document.addEventListener("click", (e) => {
  const link = (e.target as Element).closest?.("a[href]")
  if (!link) return
  e.preventDefault()
  const href = link.getAttribute("href") ?? ""
  if (/^https?:\/\//i.test(href)) window.open(href)
})

const params = new URLSearchParams(location.search)
const bridge =
  window.b42 && !params.has("mock") ? window.b42 : (await import("./mock")).install(params.get("mock") || "review", params)

start(bridge)
render(() => <App />, document.getElementById("root")!)
