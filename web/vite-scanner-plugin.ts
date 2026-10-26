import type { IncomingMessage } from "node:http";
import type { Plugin } from "vite";
import { SCANNER_PATH } from "./src/scanner/route";

const DOCUMENT_DESTINATIONS = new Set([
  "document",
  "iframe",
  "frame",
  "embed",
  "object",
]);

function isHtmlDocument(request: IncomingMessage): boolean {
  const destination = request.headers["sec-fetch-dest"];
  if (typeof destination === "string")
    return DOCUMENT_DESTINATIONS.has(destination);
  return String(request.headers.accept ?? "").includes("text/html");
}

/**
 * Dev server counterpart of nginx's scanner location (deploy/docker/nginx.conf): serves web/scan.html at
 * /collection/scan, where Vite would otherwise fall back to index.html, with COOP same-origin and COEP require-corp
 * on that document. Worker and module URLs get COEP; no other HTML document gets either header.
 */
export function scannerEntryPlugin(): Plugin {
  return {
    name: "prizecheck-scanner-entry",
    configureServer(server) {
      // Registered before Vite's own middlewares, so the rewrite happens before the HTML fallback.
      server.middlewares.use((request, response, next) => {
        const url = new URL(request.url ?? "/", "http://localhost");
        // The entry is served only at its own path, as nginx does, never by its file name.
        if (url.pathname === "/scan.html") {
          response.statusCode = 404;
          response.end();
          return;
        }
        if (
          url.pathname === SCANNER_PATH &&
          (request.method === "GET" || request.method === "HEAD")
        ) {
          request.url = `/scan.html${url.search}`;
          response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
          response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
        } else if (!isHtmlDocument(request)) {
          response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
        }
        next();
      });
    },
  };
}
