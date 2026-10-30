import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test as base } from "@playwright/test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
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

type RunningUpstream = ArtUpstream & { close(): Promise<void> };
let scope: { started?: Promise<RunningUpstream> } | undefined;

/** Activation is lazy, but belongs to one test, including failures and timeouts. */
export const test = base.extend<{ _artUpstream: void }>({
  _artUpstream: [
    async ({}, use) => {
      const owned: { started?: Promise<RunningUpstream> } = {};
      scope = owned;
      try {
        await use();
      } finally {
        scope = undefined;
        if (owned.started) {
          const upstream = await owned.started;
          const root = process.env.CATALOG_PROCESS_FIXTURE_DIR;
          try {
            if (root)
              rmSync(join(root, "art-upstream-origin"), { force: true });
          } finally {
            upstream.reset();
            await upstream.close();
          }
        }
      }
    },
    { auto: true },
  ],
});

function start(): Promise<RunningUpstream> {
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
        close() {
          server.closeAllConnections();
          return new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve()))
          );
        },
        reset() {
          requests.length = 0;
          missing.clear();
        },
      });
    });
  });
}

/** Activate this test's upstream. Callers must use the test fixture exported above. */
export async function artUpstream(): Promise<ArtUpstream> {
  const root = process.env.CATALOG_PROCESS_FIXTURE_DIR;
  if (!root)
    throw new Error(
      "CATALOG_PROCESS_FIXTURE_DIR is unset: run this spec through npm run verify"
    );
  if (!scope)
    throw new Error(
      "Use test from support/art-upstream for test-scoped art activation"
    );
  scope.started ??= start();
  const upstream = await scope.started;
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "art-upstream-origin"), upstream.origin);
  return upstream;
}
