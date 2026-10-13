// TEST ONLY. Loaded with `node --import tsx --import ./auth/testing/oauth-fake/preload.ts auth/src/server.ts`.
import http from "node:http";
import { syncBuiltinESMExports } from "node:module";
import {
  createFakeFetch,
  isLoopbackOrigin,
  wrapRequestListener,
} from "./core.js";

const origin = process.env.PUBLIC_ORIGIN;
if (!isLoopbackOrigin(origin)) {
  throw new Error(
    "OAuth fake refuses to load: PUBLIC_ORIGIN must be a loopback origin (localhost, 127.0.0.1 or [::1])"
  );
}
globalThis.fetch = createFakeFetch(globalThis.fetch.bind(globalThis));
const createServer = http.createServer;
http.createServer = function (...args: unknown[]) {
  const index = args.findIndex((arg) => typeof arg === "function");
  if (index >= 0)
    args[index] = wrapRequestListener(
      args[index] as http.RequestListener,
      origin!
    );
  return (createServer as (...a: unknown[]) => http.Server).apply(http, args);
} as typeof http.createServer;
syncBuiltinESMExports();
