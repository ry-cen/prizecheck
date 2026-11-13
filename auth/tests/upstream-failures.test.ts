import {
  freePort,
  scriptedApi,
  type Seen,
  type Behaviour,
} from "./support/gateway";
import { afterEach, beforeEach, expect, it } from "vitest";
import { type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { request as httpRequest, type Server } from "node:http";
import { launch, serverReady } from "./support/servers";

let gateway: ChildProcess;
let stderr = "";
let api: Server;
let base = "";
const cookie = "session=fixture";
const origin = "http://localhost:5173";
const seen: Seen[] = [];
let behaviour: Behaviour = () => undefined;
beforeEach(async () => {
  const port = await freePort();
  const apiPort = await freePort();
  base = `http://127.0.0.1:${port}`;
  api = scriptedApi(seen, () => behaviour);
  await new Promise<void>((resolve) =>
    api.listen(apiPort, "127.0.0.1", resolve)
  );
  gateway = launch(
    process.execPath,
    [
      "--import",
      "tsx",
      "--import",
      "./auth/tests/support/stream-gateway.mjs",
      "auth/src/server.ts",
    ],
    {
      ...process.env,
      OWNER_EMAIL: "owner@example.test",
      INTERNAL_AUTH_SECRET: "stream-test-internal-secret",
      BETTER_AUTH_SECRET: "stream-test-better-auth-secret",
      DATABASE_URL: "postgresql://unused/unused",
      AUTH_PORT: String(port),
      API_ORIGIN: `http://127.0.0.1:${apiPort}`,
      PUBLIC_ORIGIN: origin,
    }
  );
  stderr = "";
  gateway.stderr?.on("data", (chunk) => {
    stderr += chunk;
  });
  await serverReady([gateway], base + "/auth/session");
});
afterEach(async () => {
  if (gateway && gateway.exitCode === null) {
    gateway.kill();
    await new Promise((resolve) => gateway.once("exit", resolve));
  }
  api?.closeAllConnections();
  await new Promise<void>((resolve) => api?.close(() => resolve()));
});

const art = `/api/art/${randomUUID()}/small`;
for (const [kind, path] of [
  ["art", art],
  ["download", "/api/export"],
  ["json", "/api/mutation"],
]) {
  for (const phase of [
    "before",
    "body",
    ...(kind === "json" ? [] : ["disconnect", "early-disconnect"]),
  ]) {
    it(`${kind}: contains ${phase} failures without replay`, async () => {
      const pid = gateway.pid;
      let release!: () => void;
      let arrived!: () => void;
      let send!: () => void;
      const arrival = new Promise<void>((resolve) => {
        arrived = resolve;
      });
      behaviour = (_, response) => {
        release = () => response.destroy();
        if (phase === "before") {
          response.destroy();
          return;
        }
        send = () => {
          response.writeHead(200, {
            "content-type": kind === "art" ? "image/png" : "application/json",
            "content-length": "1000000",
            ...(kind === "download"
              ? { "content-disposition": "attachment; filename=test.bin" }
              : {}),
          });
          response.write("partial");
        };
        arrived();
        if (phase !== "early-disconnect") send();
      };
      seen.length = 0;
      let disconnect!: () => void;
      const result = new Promise<{
        status?: number;
        body: string;
        broken: boolean;
      }>((resolve) => {
        const req = httpRequest(
          base + path,
          {
            method: kind === "json" ? "POST" : "GET",
            headers: { cookie, origin },
          },
          (res) => {
            let body = "";
            res.on("data", (chunk) => {
              body += chunk;
              if (phase === "disconnect") res.destroy();
              release();
            });
            res.on("error", () =>
              resolve({ status: res.statusCode, body, broken: true })
            );
            res.on("end", () =>
              resolve({ status: res.statusCode, body, broken: false })
            );
            res.on("close", () => {
              if (phase === "disconnect")
                resolve({ status: res.statusCode, body, broken: true });
            });
          }
        );
        disconnect = () => req.destroy();
        req.on("error", () => resolve({ body: "", broken: true }));
        req.end();
      });
      if (phase === "body" && kind === "json") {
        await arrival;
        release();
      }
      if (phase === "early-disconnect") {
        await arrival;
        disconnect();
        await result;
        await fetch(base + "/auth/session", { headers: { cookie } }).catch(
          (error) => {
            throw new Error(stderr, { cause: error });
          }
        );
        send();
        await fetch(base + "/auth/session", { headers: { cookie } }).catch(
          (error) => {
            throw new Error(stderr, { cause: error });
          }
        );
        release();
      }
      const failed = await result;
      if (phase === "before" || kind === "json") {
        expect(failed.status).toBe(503);
        expect(JSON.parse(failed.body)).toEqual({
          error: "Service temporarily unavailable",
        });
      } else expect(failed.broken).toBe(true);
      behaviour = (_, response) => response.end("{}");
      expect(gateway.exitCode, stderr).toBeNull();
      const session = await fetch(base + "/auth/session", {
        headers: { cookie },
      }).catch((error) => {
        throw new Error(stderr, { cause: error });
      });
      expect(session.status).toBe(200);
      expect(await session.json()).toMatchObject({
        signedIn: true,
        userId: "stream-reader",
      });
      expect(
        (await fetch(base + "/api/probe", { headers: { cookie } })).status
      ).toBe(200);
      expect(gateway.exitCode).toBeNull();
      expect(gateway.pid).toBe(pid);
      expect(seen.filter((request) => request.url === path)).toHaveLength(1);
    });
  }
}

it("preserves successful art and download bytes and their header rules", async () => {
  const bytes = Buffer.from([0xff, 0, 0x80, 0xfe]);
  for (const kind of ["art", "encoded-art", "download"]) {
    const encoded = kind === "encoded-art";
    const sent = encoded ? gzipSync(bytes) : bytes;
    behaviour = (_, response) => {
      response.writeHead(200, {
        "content-type": "image/png",
        ...(encoded ? { "content-encoding": "gzip" } : {}),
        "content-length": String(sent.length),
        "cache-control": "private, max-age=60",
        "set-cookie": "upstream=secret",
        "access-control-allow-origin": "*",
        ...(kind === "download"
          ? {
              "content-disposition": "attachment; filename=cards.bin",
              "x-robots-tag": "noindex",
            }
          : {}),
      });
      response.end(sent);
    };
    const response = await fetch(
      base + (kind !== "download" ? art : "/api/export"),
      { headers: { cookie } }
    );
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("cache-control")).toBe(
      kind !== "download" ? "private, max-age=60" : "no-store"
    );
    if (kind !== "download") {
      expect(response.headers.get("content-length")).toBe(encoded ? null : "4");
      expect(response.headers.get("content-encoding")).toBeNull();
      expect(response.headers.get("cross-origin-resource-policy")).toBe(
        "same-origin"
      );
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    } else {
      expect(response.headers.get("content-disposition")).toBe(
        "attachment; filename=cards.bin"
      );
      expect(response.headers.get("x-robots-tag")).toBe("noindex");
      expect(response.headers.get("content-length")).toBeNull();
    }
  }
});
