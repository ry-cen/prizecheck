import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createHmac, createHash, randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createServer as netServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { dropDatabase, launch, serverReady } from "./support/servers";

// Card art (#358, ADR 0020): the gateway passes a 200 image answer from /api/art as raw bytes, forwards the API's
// Cache-Control and always adds the isolation headers; every other answer keeps the text path and no-store. It runs
// against its own database and a scripted API, so what the browser receives is compared byte for byte.
const admin = new Pool({ connectionString: process.env.DATABASE_URL });
const database = "tcg_art_gateway_" + randomUUID().replaceAll("-", "");
const directory = mkdtempSync(join(tmpdir(), "tcg-art-gateway-"));
const origin = process.env.TEST_ORIGIN || "http://localhost:5173";
const secret = process.env.INTERNAL_AUTH_SECRET!;
let pool: Pool;
let gateway: ChildProcess;
let api: Server;
let base = "";
let cookie = "";
let userId = "";

type Seen = {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
};
const seen: Seen[] = [];
let behaviour: (
  request: IncomingMessage,
  response: ServerResponse,
  body: string
) => void = () => undefined;

function freePort() {
  return new Promise<number>((resolve) => {
    const probe = netServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}
const hex = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const sign = (message: string) =>
  createHmac("sha256", secret).update(message).digest("hex");

async function gatewayPost(
  path: string,
  body: string,
  extra: Record<string, string> = {}
) {
  return fetch(base + path, {
    method: "POST",
    headers: { origin, "content-type": "application/json", cookie, ...extra },
    body,
  });
}

// The timeout covers serverReady's 30 s deadline plus the migration and sign-in on a loaded host.
beforeAll(async () => {
  await admin.query(`CREATE DATABASE "${database}"`);
  const connection = new URL(process.env.DATABASE_URL!);
  connection.pathname = "/" + database;
  pool = new Pool({ connectionString: connection.toString() });
  const port = await freePort();
  const apiPort = await freePort();
  base = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    EMAIL_SIGN_IN: "on",
    TRUSTED_PROXY_IPS: "127.0.0.1",
    DATABASE_URL: connection.toString(),
    AUTH_PORT: String(port),
    API_ORIGIN: `http://127.0.0.1:${apiPort}`,
    MAIL_MODE: "file",
    MAIL_FILE: join(directory, "mail"),
    SIGNUP_MODE: "local-public",
    NODE_ENV: "test",
    OWNER_EMAIL: "owner@example.test",
    PUBLIC_ORIGIN: origin,
  };
  await new Promise<void>((resolve, reject) => {
    spawn(".venv/bin/python", ["scripts/migrate.py"], {
      env,
      stdio: "ignore",
    }).on("exit", (status) =>
      status === 0 ? resolve() : reject(new Error("Migration failed"))
    );
  });
  api = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      seen.push({
        method: request.method!,
        url: request.url!,
        headers: request.headers,
        body,
      });
      behaviour(request, response, body);
    });
  });
  await new Promise<void>((resolve) =>
    api.listen(apiPort, "127.0.0.1", resolve)
  );
  gateway = launch("node", ["--import", "tsx", "auth/src/server.ts"], env);
  await serverReady([gateway], base + "/auth/session");
  const email = "art-reader@example.test";
  expect(
    (await gatewayPost("/auth/request-code", JSON.stringify({ email }))).status
  ).toBe(202);
  const code = JSON.parse(
    readFileSync(join(directory, "mail"), "utf8").trim().split("\n").at(-1)!
  ).otp;
  const signin = await gatewayPost(
    "/auth/verify-code",
    JSON.stringify({ email, code })
  );
  expect(signin.status).toBe(200);
  cookie = signin.headers.get("set-cookie")!.split(";")[0];
  userId = (await pool.query('SELECT id FROM "user" WHERE email=$1', [email]))
    .rows[0].id;
}, 60_000);

afterAll(async () => {
  if (gateway && gateway.exitCode === null) {
    gateway.kill();
    await new Promise((resolve) => gateway.once("exit", resolve));
  }
  api?.closeAllConnections();
  await new Promise((resolve) => api?.close(resolve));
  await pool?.end();
  await dropDatabase(admin, database);
  await admin.end();
  rmSync(directory, { recursive: true, force: true });
});

/** Bytes with 0xFF 0x00 0x80 and other sequences that are not UTF-8; a text decode would change them. */
function pixels(size: number) {
  const bytes = Buffer.alloc(size);
  for (let index = 0; index < size; index += 1)
    bytes[index] = (index * 7) % 256;
  bytes.set([0xff, 0x00, 0x80, 0xc3, 0x28, 0xfe], 0);
  return bytes;
}

const cache = "private, max-age=31536000, immutable";
const art = `/api/art/${randomUUID()}/small?v=abcd1234`;

describe("card art", () => {
  it("art bytes pass unchanged with cache and isolation headers", async () => {
    const bytes = pixels(200 * 1024 + 3);
    behaviour = (_, response) => {
      response.writeHead(200, {
        "content-type": "image/webp",
        "content-length": String(bytes.length),
        "cache-control": cache,
        "access-control-allow-origin": "*",
        "set-cookie": "leak=1",
        "cross-origin-resource-policy": "cross-origin",
      });
      response.end(bytes);
    };
    seen.length = 0;
    const response = await fetch(base + art, { headers: { cookie } });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/webp");
    expect(response.headers.get("cache-control")).toBe(cache);
    expect(response.headers.get("cross-origin-resource-policy")).toBe(
      "same-origin"
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("set-cookie")).toBeNull();
    const received = Buffer.from(await response.arrayBuffer());
    expect(received.length).toBe(bytes.length);
    expect(hex(received)).toBe(hex(bytes));
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe(art);
    expect(seen[0].headers["x-internal-user"]).toBe(userId);
  });

  it("a fallback-art redirect passes on as a redirect, and only to the linked address shape", async () => {
    const link = "https://tcgplayer-cdn.tcgplayer.com/product/777_400w.jpg";
    behaviour = (_, response) => {
      response.writeHead(302, { location: link, "cache-control": cache });
      response.end();
    };
    const response = await fetch(base + art, {
      headers: { cookie },
      redirect: "manual",
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(link);
    expect(response.headers.get("cache-control")).toBe(cache);
    // Any other target is not passed on, and the gateway does not follow it.
    for (const other of [
      "https://example.org/product/777_400w.jpg",
      "https://tcgplayer-cdn.tcgplayer.com.example.org/product/777_400w.jpg",
      "http://tcgplayer-cdn.tcgplayer.com/product/777_400w.jpg",
    ]) {
      behaviour = (_, response) => {
        response.writeHead(302, { location: other });
        response.end();
      };
      const refused = await fetch(base + art, {
        headers: { cookie },
        redirect: "manual",
      });
      expect(refused.headers.get("location")).toBeNull();
      expect(refused.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("an art 404 stays JSON and no-store", async () => {
    behaviour = (_, response) => {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ detail: { code: "ART_UNAVAILABLE" } }));
    };
    const response = await fetch(base + art, { headers: { cookie } });
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("cross-origin-resource-policy")).toBeNull();
    expect((await response.json()).detail.code).toBe("ART_UNAVAILABLE");
  });

  it("an art 503 keeps its Retry-After and stays no-store, and another 503 does not gain one", async () => {
    behaviour = (_, response) => {
      response.writeHead(503, {
        "content-type": "application/json",
        "retry-after": "5",
        "cache-control": "max-age=60",
      });
      response.end(JSON.stringify({ detail: { code: "ART_UNAVAILABLE" } }));
    };
    const response = await fetch(base + art, { headers: { cookie } });
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await response.json()).detail.code).toBe("ART_UNAVAILABLE");
    // Only the art route's 503 carries it; a 404 does not, whatever the API sent.
    behaviour = (_, response) => {
      response.writeHead(404, {
        "content-type": "application/json",
        "retry-after": "5",
      });
      response.end("{}");
    };
    const missing = await fetch(base + art, { headers: { cookie } });
    expect(missing.status).toBe(404);
    expect(missing.headers.get("retry-after")).toBeNull();
    // Nor does another route's 503.
    behaviour = (_, response) => {
      response.writeHead(503, {
        "content-type": "application/json",
        "retry-after": "5",
      });
      response.end("{}");
    };
    const other = await fetch(base + "/api/decks", { headers: { cookie } });
    expect(other.status).toBe(503);
    expect(other.headers.get("retry-after")).toBeNull();
  });

  it("an encoded art answer is not given a stale content-length", async () => {
    const bytes = pixels(50 * 1024);
    const encoded = gzipSync(bytes);
    behaviour = (_, response) => {
      response.writeHead(200, {
        "content-type": "image/png",
        "content-encoding": "gzip",
        "content-length": String(encoded.length),
        "cache-control": cache,
      });
      response.end(encoded);
    };
    const response = await fetch(base + art, { headers: { cookie } });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).not.toBe(
      String(encoded.length)
    );
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(hex(Buffer.from(await response.arrayBuffer()))).toBe(hex(bytes));
  });

  it("a non-art image answer keeps the old path", async () => {
    behaviour = (_, response) => {
      response.writeHead(200, {
        "content-type": "image/png",
        "cache-control": cache,
      });
      response.end("not really a png");
    };
    const response = await fetch(base + "/api/other", { headers: { cookie } });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("cross-origin-resource-policy")).toBeNull();
    expect(await response.text()).toBe("not really a png");
  });
});

const publicArt = `/api/public/art/${"a".repeat(48)}/small?v=abcd1234`;

describe("public card art", () => {
  it("anonymous art bytes pass unchanged with public cache and isolation headers", async () => {
    const bytes = pixels(200 * 1024 + 3);
    const publicCache = "public, max-age=31536000, immutable";
    behaviour = (_, response) => {
      response.writeHead(200, {
        "content-type": "image/jpeg",
        "content-length": String(bytes.length),
        "cache-control": publicCache,
      });
      response.end(bytes);
    };
    for (const headers of [{}, { cookie }]) {
      seen.length = 0;
      const response = await fetch(base + publicArt, { headers });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/jpeg");
      expect(response.headers.get("cache-control")).toBe(publicCache);
      expect(response.headers.get("cross-origin-resource-policy")).toBe(
        "same-origin"
      );
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
      expect(seen).toHaveLength(1);
      expect(seen[0].url).toBe(publicArt);
      expect(seen[0].headers["x-internal-user"]).toBeUndefined();
    }
  });

  it("a public art 404 stays JSON and no-store", async () => {
    behaviour = (_, response) => {
      response.writeHead(404, {
        "content-type": "application/json",
        "cache-control": "public, max-age=60",
      });
      response.end(JSON.stringify({ detail: { code: "ART_NOT_FOUND" } }));
    };
    const response = await fetch(base + publicArt);
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      detail: { code: "ART_NOT_FOUND" },
    });
  });

  it("a public art redirect is neither followed nor relayed", async () => {
    seen.length = 0;
    behaviour = (_, response) => {
      response.writeHead(302, {
        location: "/api/public/redirect-target",
        "cache-control": cache,
      });
      response.end();
    };
    const response = await fetch(base + publicArt, { redirect: "manual" });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    await response.text();
    expect(seen).toHaveLength(1);
  });

  it("art and other public reads have independent per-IP budgets", async () => {
    behaviour = (_, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    };
    // Retry with fresh callers if the real gateway clock crosses its fixed minute window during the requests.
    for (let attempt = 0; attempt < 3; attempt++) {
      const window = Math.floor(Date.now() / 60_000);
      const read = async (path: string, ip: string) => {
        const response = await fetch(base + path, {
          headers: { "x-real-ip": ip },
        });
        await response.text();
        return response;
      };
      const fill = async (path: string, ip: string, count: number) => {
        const statuses: number[] = [];
        for (let offset = 0; offset < count; offset += 20) {
          statuses.push(
            ...(await Promise.all(
              Array.from(
                { length: Math.min(20, count - offset) },
                async () => (await read(path, ip)).status
              )
            ))
          );
        }
        return statuses;
      };
      const artFirst = `192.0.2.${attempt * 2 + 1}`;
      const otherFirst = `192.0.2.${attempt * 2 + 2}`;
      const artStatuses = await fill(publicArt, artFirst, 600);
      const artLimited = await read(publicArt, artFirst);
      const otherStatuses = await fill("/api/public/decks", artFirst, 120);
      const otherLimited = await read("/api/public/decks", artFirst);
      const reverseOther = await fill("/api/public/decks", otherFirst, 120);
      const reverseLimited = await read("/api/public/decks", otherFirst);
      const reverseArt = await fill(publicArt, otherFirst, 600);
      const reverseArtLimited = await read(publicArt, otherFirst);
      if (Math.floor(Date.now() / 60_000) !== window) continue;
      for (const statuses of [
        artStatuses,
        otherStatuses,
        reverseOther,
        reverseArt,
      ])
        expect(statuses.every((status) => status === 200)).toBe(true);
      for (const response of [
        artLimited,
        otherLimited,
        reverseLimited,
        reverseArtLimited,
      ]) {
        expect(response.status).toBe(429);
        expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
        expect(response.headers.get("cache-control")).toBe("no-store");
      }
      return;
    }
    throw new Error("Public read checks crossed three minute boundaries");
  });
});
