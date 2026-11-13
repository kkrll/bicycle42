// The script a host adds among the page's own scripts when the overlay runs in a world apart
// from them: it answers the overlay's "b42:component" (see page.js) with what the framework
// calls the element. It is in before the page's scripts, so they never see either event.
// Built on its own (build.mjs, buildLookup): nothing of the overlay but component.js is in it.
import { componentOf } from "./component.js";

window.addEventListener(
  "b42:component",
  (e) => {
    e.stopImmediatePropagation();
    const el = /** @type {any} */ (e.composedPath()[0]);
    if (!el || el.nodeType !== 1) return;
    let c = null;
    try {
      c = componentOf(el);
    } catch {}
    if (c) el.dispatchEvent(new CustomEvent("b42:component-is", { detail: JSON.stringify(c), bubbles: true, composed: true }));
  },
  true,
);
