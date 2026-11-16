# A packed app

**What.** `bun run pack` in `app/` builds a real app for this computer in `app/release/`, unsigned.

**Drive.** `cd app && bun run pack`, then open the app in `release/`. There is no headless check;
packing is proven by launching it once and seeing the connect screen.

**What lies.** `bun run start` loads `dist/` straight from the repo; the packed app loads from its
own resources. A path that works in one can break in the other (`__dirname`, the overlay's files,
the icon). Pack after a change to `scripts/build.mjs`, `pack.mjs` or how main finds a file.
