// Paths as the window shows them: under the home folder as "~", and cut in the middle to fit.
// Pure, so they are tested in Node (test/paths.test.ts).

/** `path` with `home` as "~" when it is in it ("/home/k/code/site" → "~/code/site"). */
export function atHome(path: string, home: string | undefined): string {
  const h = home?.replace(/\/+$/, "")
  if (!h || h === "/") return path
  return path === h ? "~" : path.startsWith(`${h}/`) ? `~${path.slice(h.length)}` : path
}

/** The longest form of `full` that fits `room` px: whole folders out of the middle first
 *  ("~/code/…/internal-tools/storefront", the last folders kept before the first ones), then,
 *  when even "~/…/storefront" is too long, characters. */
export function middleCut(full: string, room: number, width: (text: string) => number): string {
  if (width(full) <= room) return full
  const segs = full.split("/")
  const n = segs.length
  for (let kept = n - 1; kept >= 2; kept--)
    for (let tail = kept - 1; tail >= 1; tail--) {
      const head = kept - tail
      const text = `${segs.slice(0, head).join("/")}/…/${segs.slice(n - tail).join("/")}`
      if (width(text) <= room) return text
    }
  const last = full.slice(full.lastIndexOf("/"))
  const cut = (k: number) => {
    const end = Math.min(k, Math.max(Math.min(last.length, k), Math.ceil(k * 0.6)))
    return `${full.slice(0, k - end)}…${full.slice(full.length - end)}`
  }
  let lo = 1
  let hi = full.length - 1
  let best = cut(1)
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (width(cut(mid)) <= room) (best = cut(mid)), (lo = mid + 1)
    else hi = mid - 1
  }
  return best
}
