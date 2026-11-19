# The page view

**What.** The site under review, in a `WebContentsView` placed over the window's `.page` box. The
URL bar, back, forward and reload are in the top bar. A note reloads the page when it is done,
unless that is switched off in the settings.

**Reach.** Type an address in the top bar (`mod+L`), or the app reopens the last page.

**Drive.**

```
"url harness/canvas.html"    a harness page; any http(s) URL works too
"size 1100 800"              the window; prints the view's bounds
"cmd reload"
"state page"                 url, loading, error, canGoBack, hmr
"shot page"
```

`--site http://localhost:3000` starts on a real dev server instead of the harness.

**What lies.**

- The view's bounds come from the renderer (`report()` in `app.tsx` → `setPageBounds`). A layout
  change in the window that forgets to report shows a page in the wrong place only in a real
  window, and never in a renderer shot. Compare `pageBounds` from `shot` with where the pane is in
  the window shot.
- Headless Electron lays out the view only after the window is resized; the driver resizes once at
  start, and `size` does again.
