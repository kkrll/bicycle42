// Where the address an agent says its site is at points, read from the address alone (no DNS).
//
// An agent on another computer serves its site on that computer: its localhost is forwarded here
// (core.ts, hereFor) and the page opens the forward. Any other address would load on this
// computer, as this computer's network sees it: a name that resolves here (localtest.me is
// 127.0.0.1 everywhere), a machine on the reviewer's own network (192.168.1.1), the open web. So
// only an address that is that computer's own loopback (or "any address" a server listens on) is
// forwarded; everything else is the reviewer's to open or not. A hostname is never matched as
// text: the address is parsed as the browser parses it, and an IP literal is read as an IP,
// whatever way it is written (IPv4-mapped IPv6, 0x7f.1, 2130706433).
import net from "node:net"

export type SiteAt =
  /** On the agent's computer: `there` is what to forward to on it (an address of its loopback,
   *  or `localhost`), at `port`. */
  | { on: "computer"; there: string; port: number }
  /** Not that computer's own: it would load somewhere else. */
  | { on: "elsewhere" }

/** Where `address` (http or https) points from the agent's computer. Not an address at all is
 *  "elsewhere": nothing is forwarded for it. */
export function siteAt(address: string): SiteAt {
  let u: URL
  try {
    u = new URL(address)
  } catch {
    return { on: "elsewhere" }
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { on: "elsewhere" }
  const there = loopbackOf(u.hostname)
  if (!there) return { on: "elsewhere" }
  return { on: "computer", there, port: Number(u.port || (u.protocol === "https:" ? 443 : 80)) }
}

/** The address to forward to on the agent's computer when `hostname` (as the URL parser left it:
 *  lower case, an IPv6 literal in brackets, an IPv4 one as four numbers) is its loopback or its
 *  unspecified address; undefined for anything else. */
export function loopbackOf(hostname: string): string | undefined {
  const name = hostname.replace(/\.$/, "")
  // The name the agent's computer itself answers for itself. Any name under it is loopback too
  // (RFC 6761, and Chromium never asks DNS for one).
  if (name === "localhost") return "localhost"
  if (name.endsWith(".localhost")) return "127.0.0.1"
  if (net.isIPv4(name)) return v4(name)
  const six = /^\[(.*)\]$/.exec(name)?.[1]
  if (six && net.isIPv6(six)) {
    const g = groups(six)
    if (!g) return undefined
    const zeros = (n: number) => g.slice(0, n).every((x) => x === 0)
    if (zeros(8)) return "::1" // [::], "any address": a server on it answers on ::1
    if (zeros(7) && g[7] === 1) return "::1"
    // IPv4-mapped (::ffff:a.b.c.d): an IPv4 address written as IPv6.
    if (zeros(5) && g[5] === 0xffff) return v4(`${g[6]! >> 8}.${g[6]! & 255}.${g[7]! >> 8}.${g[7]! & 255}`)
  }
  return undefined
}

/** 127.0.0.0/8 is the loopback (forwarded as it is); 0.0.0.0, "any address", is reached on 127.0.0.1. */
function v4(ip: string): string | undefined {
  if (ip === "0.0.0.0") return "127.0.0.1"
  return ip.split(".")[0] === "127" ? ip : undefined
}

/** An IPv6 address (no brackets, valid by net.isIPv6) as its eight 16-bit groups. */
function groups(ip: string): number[] | undefined {
  let s = ip.split("%")[0]!
  // A dotted quad at the end is the last two groups.
  const quad = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s)
  if (quad) {
    const [a, b, c, d] = quad.slice(1).map(Number) as [number, number, number, number]
    s = `${s.slice(0, quad.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  const [head, tail] = s.split("::") as [string, string | undefined]
  const part = (p: string) => (p ? p.split(":").map((x) => parseInt(x, 16)) : [])
  const h = part(head)
  if (tail === undefined) return h.length === 8 ? h : undefined
  const t = part(tail)
  const fill = 8 - h.length - t.length
  return fill < 0 ? undefined : [...h, ...Array<number>(fill).fill(0), ...t]
}
