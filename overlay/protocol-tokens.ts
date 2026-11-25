// The page's design system: its variables (design tokens), which the host draws in a view of its
// own in place of the page (the "tokens" pane; see Pane in protocol.ts). Types only.
//
// The overlay reads them from the page's stylesheets: every custom property a rule declares, with
// the rule it is in (so a variable has a value per theme), what it comes to on the root element,
// and how many rules use it. A stylesheet of another origin cannot be read as rules: its variables
// are those the root element has in effect, with no rule to name. Nothing is read unless the
// host's view asks ("view" until "stop"), and again only when asked ("refresh") or after a change
// the view made itself.
//
// A value the reviewer sets is the page's at once (a stylesheet of the layer's own, over the
// page's), and stays until it is put back ("reset") or the page is loaded again. The agent is told
// by the host, in words: the overlay sends no note for it.
// Its strings are the page's own text: the host draws them as text, never as markup.

/** What a variable's value is, as far as it can be told from the value (and, for a font, the name). */
export type TokenKind = "colour" | "size" | "time" | "ease" | "shadow" | "font" | "number" | "other"

/** One rule that declares the variable: where ("`:root`", "`.dark`", "`@media (prefers-color-scheme:
 *  dark) :root`"), and the value as it is written there (`var(--gray-900)`, not what it comes to). */
export type TokenWhere = { scope: string; value: string }

export type Token = {
  name: string
  kind: TokenKind
  /** What it comes to on the root element, the `var()`s in it put in. Of a variable only a
   *  component's rule declares (`local`), the value as that rule writes it. */
  value: string
  /** A colour: the value as a CSS colour, when the value itself is only its numbers
   *  (`--background: 0 0% 100%` is `hsl(0 0% 100%)`). */
  css?: string
  /** A size: in px (a plain number: the number), to put a scale in order. */
  size?: number
  /** The rules that declare it, in the stylesheets' order; none when no readable rule does. */
  where: TokenWhere[]
  /** How many rules' declarations use it (`var(--name)`), other variables' included. */
  uses: number
  /** Not in effect on the root element: a component's own. */
  local?: true
  /** The reviewer's value, not yet in the code; `value` is then what that comes to. */
  set?: string
  /** …and what it came to before. */
  was?: string
}

/** A value the page's rules write out themselves, with no variable: a colour, or a size where
 *  the page has a scale of that kind (spacing, radius, text). What a suggestion is made of. */
export type LooseValue = {
  kind: "colour" | "space" | "radius" | "text"
  /** As it is written most often. */
  value: string
  /** How many rules write it, and a few of their selectors. */
  rules: number
  where: string[]
  /** The variables that say the same (a size: of this kind only), best name first. None: the
   *  page has no variable for it. */
  tokens: string[]
}

export type TokensView = {
  tokens: Token[]
  /** Values written out in two rules or more (a size: three) or that a variable already says,
   *  the most written first, sixty at most. */
  loose: LooseValue[]
  /** Stylesheets that could not be read as rules (another origin's). */
  unread: number
  /** There are more variables than are listed. */
  partial: boolean
}

/** What the host's view asks. "view": it is shown, read the variables (and again on "refresh")
 *  until "stop". "set": this value for the variable, on the page at once (in every rule that
 *  declares it; an empty value puts it back). "reset": every value put back. */
export type TokensAct =
  | { type: "view" }
  | { type: "stop" }
  | { type: "refresh" }
  | { type: "set"; name: string; value: string }
  | { type: "reset" }
