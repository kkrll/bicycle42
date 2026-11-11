// Static server for the harness: serves overlay/ so the harness and the page share an origin
// (the host must reach into the iframe). Usage: node scripts/serve.mjs [port]
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json" };

export function serve(port = 0, host = "127.0.0.1") {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    let path = decodeURIComponent(url.pathname);
    // Redirect so the harness's relative URLs (./host.js, ../overlay.js) resolve under /harness/.
    if (path === "/" || path === "/harness" || path === "/harness/")
      return res.writeHead(302, { location: `/harness/index.html${url.search}` }).end();
    if (path.endsWith("/")) path += "index.html"; // a folder: its index, as /harness/motion/
    const file = normalize(join(ROOT, path));
    if (!file.startsWith(ROOT)) return res.writeHead(403).end();
    try {
      const body = await readFile(file);
      res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
      res.end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  });
  return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2] ?? process.env.PORT ?? 4173);
  const host = process.env.HOST ?? "127.0.0.1";
  const server = await serve(port, host);
  console.log(`harness: http://${host}:${server.address().port}/`);
}
