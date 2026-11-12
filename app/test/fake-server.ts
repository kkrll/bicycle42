// A stand-in for the OpenCode server, for tests: real HTTP on a loopback port, Basic auth, the
// SSE stream at /api/event, and whatever JSON routes a test scripts.
//
//   const server = await start()
//   server.route("GET", "/api/session/ses_1", { json: { data: { id: "ses_1" } } })
//   const backend = createOpenCode({ url: server.url, password: server.password })
//   ...
//   server.emit({ id: "evt_1", type: "session.renamed", data: { sessionID: "ses_1", title: "x" } })
//   await server.stop()
//
// Out of the box it answers /api/info and /api/event, and lists no commands, skills or files
// (/api/command, /api/skill, /api/fs/find); everything else is 404 until routed.
// Nothing here runs on a timer: heartbeats and dropped connections happen when the test says so.
import http from "node:http"
import type { AddressInfo } from "node:net"

export type FakeRequest = {
  method: string
  /** Without the query string. */
  path: string
  query: URLSearchParams
  /** The parsed JSON body, or undefined when there was none. */
  body: unknown
  authorized: boolean
}

export type FakeReply = { status?: number; json?: unknown; text?: string }

export type FakeServer = {
  url: string
  password: string
  /** Every request received, oldest first, including unauthorized ones and the event stream. */
  requests: FakeRequest[]
  /** Scripts an answer. A later route for the same method and path replaces an earlier one. */
  route(method: string, path: string | RegExp, reply: FakeReply | ((req: FakeRequest) => FakeReply)): void
  /** Sends one event to every open event stream. */
  emit(event: unknown): void
  heartbeat(): void
  /** Cuts every open event stream, as a network drop would. */
  drop(): void
  /** Event names this server does not know. A stream whose filter names one is refused with a
   *  400, as a server older than the client would. None by default. */
  unknownEvents?: RegExp
  /** How many event streams are open now. */
  streams(): number
  stop(): Promise<void>
}

export const VERSION = "2.2.6-fake"

/** `port` 0 picks a free one; a test that needs a server to appear later at a known address passes it. */
export async function start(port = 0): Promise<FakeServer> {
  const password = "fake-password-" + Math.random().toString(36).slice(2)
  const expected = "Basic " + Buffer.from(`opencode:${password}`).toString("base64")
  const routes: { method: string; path: string | RegExp; reply: FakeReply | ((req: FakeRequest) => FakeReply) }[] = []
  const streams = new Set<http.ServerResponse>()
  const requests: FakeRequest[] = []
  let fake: FakeServer

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://fake")
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const text = Buffer.concat(chunks).toString("utf8")
    const request: FakeRequest = {
      method: req.method ?? "GET",
      path: url.pathname,
      query: url.searchParams,
      body: text ? JSON.parse(text) : undefined,
      authorized: req.headers.authorization === expected,
    }
    requests.push(request)

    const answer = (reply: FakeReply) => {
      const body = reply.text ?? (reply.json === undefined ? "" : JSON.stringify(reply.json))
      res.writeHead(reply.status ?? (body ? 200 : 204), { "content-type": reply.text === undefined ? "application/json" : "text/html" })
      res.end(body)
    }

    if (!request.authorized)
      return answer({ status: 401, json: { _tag: "UnauthorizedError", message: "Authentication required" } })

    const route = routes.find((r) => r.method === request.method && (typeof r.path === "string" ? r.path === request.path : r.path.test(request.path)))
    if (route) return answer(typeof route.reply === "function" ? route.reply(request) : route.reply)

    if (request.method === "GET" && request.path === "/api/info") return answer({ json: { version: VERSION, hostname: "fake-box.local" } })
    // The catalogs of a folder: empty unless a test scripts them.
    if (request.method === "GET" && ["/api/command", "/api/skill", "/api/fs/find"].includes(request.path))
      return answer({ json: { location: { directory: request.query.get("location[directory]") ?? "/" }, data: [] } })
    if (request.method === "GET" && request.path === "/api/event") {
      // Like the real one: the filter is a repeated parameter, and a comma list is an error.
      if (request.query.getAll("types").some((t) => t.includes(",") || fake.unknownEvents?.test(t)))
        return answer({ status: 400, json: { _tag: "InvalidRequestError", message: "Invalid types", kind: "Query" } })
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform" })
      res.write(`data: {"id":"evt_connected","type":"server.connected","data":{}}\n\n: heartbeat\n\n`)
      streams.add(res)
      res.on("close", () => streams.delete(res))
      return
    }
    answer({ status: 404, json: { _tag: "NotFoundError", message: `Not found: ${request.path}` } })
  })

  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve))
  port = (server.address() as AddressInfo).port

  return (fake = {
    url: `http://127.0.0.1:${port}`,
    password,
    requests,
    route: (method, path, reply) => void routes.unshift({ method, path, reply }),
    emit(event) {
      for (const res of streams) res.write(`data: ${JSON.stringify(event)}\n\n`)
    },
    heartbeat() {
      for (const res of streams) res.write(": heartbeat\n\n")
    },
    drop() {
      for (const res of streams) res.destroy()
      streams.clear()
    },
    streams: () => streams.size,
    stop() {
      server.closeAllConnections()
      return new Promise((resolve) => server.close(() => resolve()))
    },
  })
}

/** Waits until `condition` holds, for tests that follow something asynchronous. */
export async function until(condition: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for: " + condition.toString())
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
