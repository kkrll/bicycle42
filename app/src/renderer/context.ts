// How full the conversation's context is, as the message box shows it: nothing while there is
// room, a quiet percentage from half full, the warning colour when the server is about to
// summarise by itself. The numbers are the server's (see `AppState.context`); this is only the
// arithmetic, kept apart from the component so it can be tested without a window.
import type { AppState } from "../shared/types"

/** From this share of the window the meter shows. */
export const SHOWN_FROM = 0.5
/** From this share it warns. The server summarises by itself a little later (at 85% of the
 *  window unless it is configured otherwise), so the warning comes while there is still a choice. */
export const WARN_FROM = 0.8

export type Meter = {
  /** Whole percent, rounded down: "80%" is never said before it is true. */
  percent: number
  warn: boolean
  /** "124k of 200k tokens". */
  numbers: string
}

/** "950", "124k", "1M", "1.5M": a token count as a person says it. */
export function tokens(n: number): string {
  if (n < 1000) return String(Math.round(n))
  if (n < 999_500) return `${Math.round(n / 1000)}k`
  return `${String(Math.round(n / 100_000) / 10)}M`
}

/** The meter for a context, or undefined when there is nothing to show: the count or the
 *  window is not known, or less than half of it is used. */
export function meter(context: AppState["context"]): Meter | undefined {
  if (!context?.limit || context.limit <= 0 || !(context.used >= 0)) return undefined
  const share = context.used / context.limit
  if (share < SHOWN_FROM) return undefined
  return { percent: Math.floor(share * 100), warn: share >= WARN_FROM, numbers: `${tokens(context.used)} of ${tokens(context.limit)} tokens` }
}
