import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// The art host as the API's fetcher sees it in a verification stack (#359). The API sends its upstream requests to the
// loopback origin this file writes to $CATALOG_PROCESS_FIXTURE_DIR/art-upstream-origin (api/tests/catalog_process_fixture/
// art_fixture.py), so a scanner image only loads when it comes through /api/art. The stub answers like assets.tcgdex.net
// does for about one file in five: Access-Control-Allow-Origin twice, and no Cross-Origin-Resource-Policy.

export const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=",
  "base64"
);

export type ArtUpstream = {
  origin: string;
  /** Request paths the stub has seen since the last reset. */
  requests: string[];
  /** Paths the stub answers 404 for. */
  missing: Set<string>;
  reset(): void;
};

let started: Promise<ArtUpstream> | undefined;

function start(): Promise<ArtUpstream> {
  const requests: string[] = [];
  const missing = new Set<string>();
  const server: Server = createServer((req, res) => {
    const path = req.url ?? "";
    requests.push(path);
    if (missing.has(path)) {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.statusCode = 200;
    res.setHeader("content-type", "image/png");
    res.setHeader("access-control-allow-origin", ["*", "*"]);
    res.end(PIXEL);
  });
  server.unref();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        origin: `http://127.0.0.1:${port}`,
        requests,
        missing,
        reset() {
          requests.length = 0;
          missing.clear();
        },
      });
    });
  });
}

/** The worker's stub (one per worker process), with the API told to fetch from it. */
export async function artUpstream(): Promise<ArtUpstream> {
  const root = process.env.CATALOG_PROCESS_FIXTURE_DIR;
  if (!root)
    throw new Error(
      "CATALOG_PROCESS_FIXTURE_DIR is unset: run this spec through npm run verify"
    );
  started ??= start();
  const upstream = await started;
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "art-upstream-origin"), upstream.origin);
  return upstream;
}
