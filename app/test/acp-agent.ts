// The fake ACP agent of test/fake-agent.ts as a program of its own, for the controller's tests of
// an agent on this computer (test/controller-acp.test.ts): the app starts it as it starts Claude
// Code's adapter, and speaks to it over stdin and stdout.
//
//   node dist/test/acp-agent.cjs <state file>
//
// What a turn does is in its words: "HANG" never ends (until the turn is cancelled or the process
// ended), "CRASH" ends the process a moment after it began (once per state file), anything else
// is answered "done".
import fs from "node:fs"
import { Readable, Writable } from "node:stream"
import { ndJsonStream } from "@agentclientprotocol/sdk/unstable"
import { fakeAgent } from "./fake-agent"

const file = process.argv[2]!
const fake = fakeAgent({ file })
fake.onPrompt = async (turn) => {
  await turn.say({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "on it" }, messageId: `m-${turn.text.length}` })
  if (turn.text.includes("CRASH") && !fs.existsSync(`${file}.crashed`)) {
    fs.writeFileSync(`${file}.crashed`, "")
    setTimeout(() => process.exit(3), 100)
    return new Promise(() => {})
  }
  if (turn.text.includes("HANG")) return new Promise(() => {})
  await turn.say({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: " done" }, messageId: `m-${turn.text.length}` })
}
const transport = fake.connect()
// This process's stdin and stdout, framed as ACP frames them, joined to the fake's pipes.
const stdio = ndJsonStream(Writable.toWeb(process.stdout) as WritableStream<Uint8Array>, Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>)
void stdio.readable.pipeTo(transport.stream.writable).finally(() => process.exit(0))
void transport.stream.readable.pipeTo(stdio.writable)
