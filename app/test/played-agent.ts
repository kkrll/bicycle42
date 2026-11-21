// The fake ACP agent of test/fake-agent.ts with its turns played by the test: each message the
// agent gets is a turn that waits until the test ends it (or fails it, or says something in it).
// Used in this process by the controller's tests (test/controller.test.ts) and by the whole app
// in Electron (test/app.e2e.ts).
import { fakeAgent, type FakeAgent } from "./fake-agent"

/** What a message the agent got said: its words, its pictures (as their bytes, read as text) and
 *  the files it names. */
export type Said = { session: string; text: string; images: string[]; links: string[] }
type Block = { type: string; text?: string; data?: string; uri?: string }
export const saidOf = (p: Record<string, unknown>): Said => {
  const blocks = p.prompt as Block[]
  return {
    session: p.sessionId as string,
    text: blocks.flatMap((b) => (b.type === "text" ? [b.text!] : [])).join(""),
    images: blocks.flatMap((b) => (b.type === "image" ? [Buffer.from(b.data!, "base64").toString()] : [])),
    links: blocks.flatMap((b) => (b.type === "resource_link" ? [b.uri!] : [])),
  }
}

/** A turn of the agent's, under way until the test ends it. */
export type Live = {
  session: string
  text: string
  ended: boolean
  /** It ends its turn: done, or with a stop reason ("cancelled", "refusal", …). */
  end(stop?: string): void
  /** Its turn fails with an error. */
  fail(message: string): void
  /** It says something in its turn. */
  say(text: string): Promise<void>
  /** It counts the conversation's context. */
  usage(used: number, size?: number): Promise<void>
}

/** A fake agent whose turns wait for the test (`auto`: each ends at once, "ok"). */
export function playedAgent() {
  const fa: FakeAgent = fakeAgent()
  const live: Live[] = []
  const w = {
    fa,
    live,
    auto: false,
    /** Every message the agent got, in order. */
    get prompts(): Said[] {
      return fa.calls.filter((c) => c.method === "session/prompt").map((c) => saidOf(c.params))
    },
    /** How many conversations it made. */
    get creates() {
      return fa.calls.filter((c) => c.method === "session/new").length
    },
  }
  fa.onPrompt = (t) =>
    new Promise<string | void>((resolve, reject) => {
      const n = live.length
      const l: Live = {
        session: t.session,
        text: t.text,
        ended: false,
        end: (stop) => void (l.ended || ((l.ended = true), resolve(stop))),
        fail: (message) => void (l.ended || ((l.ended = true), reject(new Error(message)))),
        say: (text) => t.say({ sessionUpdate: "agent_message_chunk", content: { type: "text", text }, messageId: `a${n}` }),
        usage: (used, size) => t.say({ sessionUpdate: "usage_update", used, ...(size ? { size } : {}) }),
      }
      void t.cancelled.then(() => (l.ended = true))
      live.push(l)
      if (w.auto) void l.say("ok").then(() => l.end())
    })
  return w
}
export type Played = ReturnType<typeof playedAgent>

