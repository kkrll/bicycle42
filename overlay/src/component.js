// ── the framework's name for an element ─────────────────────────────────────────────────────
// Reads the page's own objects (React's fibers, Vue's instances), so it only finds something
// when it runs among the page's scripts. It is built twice: into the overlay, for a host that
// runs the overlay there (the harness), and alone as the lookup script (build.mjs, buildLookup),
// which a host that gives the overlay its own world adds to the page's. Nothing but `el` in it.
export function componentOf(el) {
  const key = Object.keys(el).find((k) => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$"));
  if (key) {
    const stack = [];
    let source;
    for (let f = el[key]; f && stack.length < 4; f = f.return) {
      if (!source && f._debugSource) source = f._debugSource;
      const t = f.type;
      if (!t || typeof t === "string") continue;
      const n =
        t.displayName ||
        t.name ||
        (t.render && (t.render.displayName || t.render.name)) ||
        (t.type && (t.type.displayName || t.type.name));
      if (n && /^[A-Z]/.test(n) && stack[stack.length - 1] !== n) stack.push(n);
    }
    if (stack.length) {
      const c = { framework: "react", name: stack[0], stack };
      if (source) c.source = `${source.fileName}:${source.lineNumber}`;
      return c;
    }
  }
  let v = el.__vueParentComponent;
  if (v) {
    const stack = [];
    let source;
    for (; v && stack.length < 4; v = v.parent) {
      const n = v.type && (v.type.name || v.type.__name);
      if (!source && v.type && v.type.__file) source = v.type.__file;
      if (n) stack.push(n);
    }
    if (stack.length) return { framework: "vue", name: stack[0], stack, ...(source ? { source } : {}) };
  }
  return null;
}
