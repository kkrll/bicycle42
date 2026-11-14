// What a conversation is called.
//
// A conversation is made before anything is said in it, so it starts with a placeholder: where
// it is ("Review · localhost:3000"). The first thing the reviewer says names it: the words of
// the note, or of the message. A name a person gave (/rename, or the list) is never replaced:
// only a placeholder is.

const PLACEHOLDER = /^Review · /
const MAX = 56

/** The name a new conversation has until something is said in it. */
export const placeholderTitle = (where: string) => `Review · ${where}`

/** A name nobody chose: the placeholder, or none. */
export const isPlaceholder = (title: string) => !title.trim() || PLACEHOLDER.test(title)

/** A name from what was said: its first line with something in it, without the marks of a
 *  list or a heading, cut at a word. Undefined when there is nothing to make a name of (a
 *  command, a picture alone). */
export function titleFrom(text: string): string | undefined {
  const line = text
    .split("\n")
    .map((l) => l.replace(/^[\s#>*\-–—•\d.)]+(?=\S)/, "").replace(/\s+/g, " ").trim())
    .find((l) => /[\p{L}\p{N}]/u.test(l))
  if (!line || line.startsWith("/")) return undefined
  const name = line.replace(/[.:;,!\s]+$/, "")
  if (!name) return undefined
  const first = name[0]!.toUpperCase() + name.slice(1)
  if (first.length <= MAX) return first
  const cut = first.slice(0, MAX)
  const space = cut.lastIndexOf(" ")
  return `${(space > MAX / 2 ? cut.slice(0, space) : cut).replace(/[.:;,!\s]+$/, "")}…`
}
