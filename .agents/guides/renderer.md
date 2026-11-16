# Renderer

`app/src/renderer/` is the app window: Solid, styled with the `@kkrll/design` tokens. It is a
sandboxed web page. Dependency rules keep electron, node and main out of it, and lint holds the
Solid rules. This guide holds what neither can.

## State comes from main

- `store.ts` mirrors `AppState` from `window.b42.onState`. The window renders it and sends
  commands (`window.b42.invoke`); it keeps no durable state of its own. What must survive a
  reload or a restart belongs in main.
- UI-only state (open menus, the notes list folded) lives in signals in the component that owns
  it, or through `recall`/`remember` in `store.ts` (localStorage) when it should outlast a reload.

## Solid

- Read props as `props.x` inside JSX or a tracked scope, never destructured. `solid/reactivity`
  flags misses; when it is wrong about a custom helper, write the one-line reason next to the
  disable.
- Element refs are `let el: HTMLElement | undefined` plus `ref={el}`.

## Markup and styles

- Markup from the agent or the page goes through `markdown.tsx`, which runs DOMPurify. Lint
  holds every other `innerHTML` to `mock.ts`.
- Colours, spacing, radii and type come from the design tokens. `bun run check:design` checks the
  styles against the design system's Floor (`node_modules/@kkrll/design/design.md`), and
  `scripts/check.mjs` runs it.

## Every state has a shot

A new screen or state gets a scenario in `mock.ts` and a line in `SHOTS` in `scripts/shot.mjs`, so
`bun run visual` covers it in light and dark. A change that is meant to move pixels comes with
new baselines (`node scripts/visual.mjs --update` after the shots), and the PR says which.
