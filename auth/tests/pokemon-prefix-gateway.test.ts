import { freePort, hex, signer, signUp } from "./support/gateway";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { dropDatabase, launch, serverReady } from "./support/servers";

// The per-game prefix (docs/planning/pokemon-api-prefix.md): the gateway serves the Pokémon-only routes under
// /api/pokemon/ beside their old /api/ paths. A /api/pokemon request is rewritten to its old path before any other
// rule looks at it, so the upstream sees, and the signatures cover, the path it has always had. Every other
// /api/pokemon/... is a 404 that never reaches the upstream. Runs against its own database and a scripted API.
const admin = new Pool({ connectionString: process.env.DATABASE_URL });
const database = "tcg_pokemon_prefix_" + randomUUID().replaceAll("-", "");
const directory = mkdtempSync(join(tmpdir(), "tcg-pokemon-prefix-"));
const origin = process.env.TEST_ORIGIN || "http://localhost:5173";
const secret = process.env.INTERNAL_AUTH_SECRET!;
const FIVE_MIB = 5 * 1024 * 1024;
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
  body: Buffer;
};
const seen: Seen[] = [];
const sign = signer(secret);

async function call(
  method: string,
  path: string,
  options: { body?: string | Buffer; signedIn?: boolean; origin?: string } = {}
) {
  const { body, signedIn = true } = options;
  const headers: Record<string, string> = {};
  if (signedIn) headers.cookie = cookie;
  if (method !== "GET") headers.origin = options.origin ?? origin;
  if (body !== undefined) headers["content-type"] = "application/json";
  return fetch(base + path, { method, headers, body });
}

async function post(path: string, body: string | Buffer) {
  return call("POST", path, { body });
}

/** `size` bytes holding every byte value in turn. */
function binary(size: number) {
  const bytes = Buffer.alloc(size);
  for (let index = 0; index < size; index += 1) bytes[index] = index % 256;
  return bytes;
}

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
  api = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      seen.push({
        method: request.method!,
        url: request.url!,
        headers: request.headers,
        body: Buffer.concat(chunks),
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  await new Promise<void>((resolve) =>
    api.listen(apiPort, "127.0.0.1", resolve)
  );
  gateway = launch("node", ["--import", "tsx", "auth/src/server.ts"], env);
  await serverReady([gateway], base + "/auth/session");
  ({ cookie, userId } = await signUp(
    (path, body) =>
      fetch(base + path, {
        method: "POST",
        headers: { origin, "content-type": "application/json", cookie },
        body,
      }),
    "pokemon-prefix@example.test",
    directory,
    pool
  ));
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

const id = randomUUID();
// One request per moved prefix, at least: [method, the new path, the upstream path it must reach], query included.
const MOVED: [string, string, string][] = [
  ["GET", "/catalog/status", "/api/catalog/status"],
  [
    "GET",
    "/catalog/search?name=Pika&number=25",
    "/api/catalog/search?name=Pika&number=25",
  ],
  [
    "GET",
    "/catalog/editions?q=Professor%20Oak&q=x",
    "/api/catalog/editions?q=Professor%20Oak&q=x",
  ],
  ["GET", `/catalog/printings/${id}`, `/api/catalog/printings/${id}`],
  ["POST", "/catalog/metadata-reports", "/api/catalog/metadata-reports"],
  [
    "POST",
    "/collection-imports?location_id=leaf-1",
    "/api/collection-imports?location_id=leaf-1",
  ],
  ["GET", "/collection-imports/current", "/api/collection-imports/current"],
  [
    "POST",
    `/collection-imports/${id}/save`,
    `/api/collection-imports/${id}/save`,
  ],
  ["GET", `/want-list?deck=${id}`, `/api/want-list?deck=${id}`],
  [
    "GET",
    "/want-list/exports/tcgplayer.txt?owner_revision=1",
    "/api/want-list/exports/tcgplayer.txt?owner_revision=1",
  ],
  ["POST", "/missing-card-reports", "/api/missing-card-reports"],
  ["GET", `/missing-card-reports/${id}`, `/api/missing-card-reports/${id}`],
  ["POST", "/prices/editions", "/api/prices/editions"],
  ["POST", "/trades/value", "/api/trades/value"],
  ["POST", "/holdings/reassign", "/api/holdings/reassign"],
  ["GET", "/admin/catalog-runs", "/api/admin/catalog-runs"],
  ["GET", "/admin/missing-card-reports", "/api/admin/missing-card-reports"],
  [
    "GET",
    `/admin/catalog-reviews/${id}/editions`,
    `/api/admin/catalog-reviews/${id}/editions`,
  ],
  [
    "GET",
    "/admin/catalog-metadata/queue?matched=card_number",
    "/api/admin/catalog-metadata/queue?matched=card_number",
  ],
  ["GET", "/admin/catalog-rules", "/api/admin/catalog-rules"],
  ["GET", "/admin/card-attributes/queue", "/api/admin/card-attributes/queue"],
  [
    "GET",
    `/admin/card-identities?printing_id=${id}`,
    `/api/admin/card-identities?printing_id=${id}`,
  ],
  [
    "POST",
    "/admin/reprint-groups/decisions",
    "/api/admin/reprint-groups/decisions",
  ],
];

describe("Pokémon routes under /api/pokemon", () => {
  it.each(MOVED)(
    "%s /api/pokemon%s reaches the upstream at %s with an identity signature over the upstream path",
    async (method, path, upstream) => {
      seen.length = 0;
      const body = method === "GET" ? undefined : JSON.stringify({ a: "é" });
      const response = await call(method, `/api/pokemon${path}`, { body });
      expect(response.status).toBe(200);
      expect(seen).toHaveLength(1);
      const [request] = seen;
      expect(request.method).toBe(method);
      expect(request.url).toBe(upstream);
      expect(request.body.toString("utf8")).toBe(body ?? "");
      const pathname = upstream.split("?")[0];
      expect(request.headers["x-internal-user"]).toBe(userId);
      expect(request.headers["x-internal-signature"]).toBe(
        sign(
          `${method}\n${pathname}\n${hex(body ?? "")}\n${userId}\n${request.headers["x-internal-time"]}`
        )
      );
    }
  );

  it.each(MOVED)(
    "%s /api%s, the old path a stale tab still calls, reaches the same upstream path and query as before",
    async (method, path, upstream) => {
      seen.length = 0;
      const body = method === "GET" ? undefined : JSON.stringify({ a: "é" });
      const response = await call(method, `/api${path}`, { body });
      expect(response.status).toBe(200);
      expect(seen).toHaveLength(1);
      const [request] = seen;
      expect(request.url).toBe(upstream);
      expect(request.headers["x-internal-signature"]).toBe(
        sign(
          `${method}\n${upstream.split("?")[0]}\n${hex(body ?? "")}\n${userId}\n${request.headers["x-internal-time"]}`
        )
      );
    }
  );

  it("sends the old and the new path as the same upstream request, so a stale tab and a fresh one are indistinguishable", async () => {
    for (const [path, query] of [
      ["/catalog/editions", "?q=Starmie&cursor=abc"],
      ["/want-list", ""],
    ]) {
      seen.length = 0;
      const body = undefined;
      await call("GET", `/api${path}${query}`, { body });
      await call("GET", `/api/pokemon${path}${query}`, { body });
      expect(seen).toHaveLength(2);
      const [old, fresh] = seen;
      expect(fresh.url).toBe(old.url);
      expect(fresh.method).toBe(old.method);
      expect(fresh.body.equals(old.body)).toBe(true);
      const names = (headers: IncomingMessage["headers"]) =>
        Object.keys(headers)
          .filter((name) => name.startsWith("x-internal-"))
          .sort();
      expect(names(fresh.headers)).toEqual(names(old.headers));
      expect(fresh.headers["x-internal-user"]).toBe(
        old.headers["x-internal-user"]
      );
    }
  });

  it("requires a session and, for a write, the site's origin, exactly as the old paths do", async () => {
    seen.length = 0;
    for (const [method, path] of [
      ["GET", "/api/pokemon/want-list"],
      ["GET", "/api/pokemon/catalog/editions"],
      ["POST", "/api/pokemon/prices/editions"],
    ]) {
      const response = await call(method, path, {
        signedIn: false,
        body: method === "GET" ? undefined : "{}",
      });
      expect(response.status).toBe(401);
    }
    for (const wrong of ["https://evil.example", ""]) {
      for (const path of [
        "/api/pokemon/missing-card-reports",
        "/api/pokemon/collection-imports",
        "/api/missing-card-reports",
      ]) {
        const response = await fetch(base + path, {
          method: "POST",
          headers: {
            cookie,
            "content-type": "application/json",
            ...(wrong ? { origin: wrong } : {}),
          },
          body: "{}",
        });
        expect(response.status).toBe(403);
      }
    }
    expect(seen).toHaveLength(0);
  });
});

describe("budgeted routes under /api/pokemon", () => {
  const budget = (
    method: string,
    pathname: string,
    body: string,
    headers: IncomingMessage["headers"]
  ) => {
    const milliseconds = headers["x-internal-budget-ms"] as string;
    const stamp = headers["x-internal-budget-time"] as string;
    expect(Number(milliseconds)).toBeGreaterThan(2_000);
    expect(Number(milliseconds)).toBeLessThanOrEqual(3_000);
    expect(stamp).toMatch(/^\d{13}$/);
    expect(headers["x-internal-caller"]).toBe(`user:${userId}`);
    expect(headers["x-internal-budget-signature"]).toBe(
      sign(
        `budget\n${method}\n${pathname}\n${hex(body)}\nuser:${userId}\n${milliseconds}\n${stamp}`
      )
    );
  };

  it("gives POST /api/pokemon/prices/editions and /trades/value the budget headers, signed over the upstream path", async () => {
    for (const [route, body] of [
      ["/prices/editions", JSON.stringify({ edition_ids: [id] })],
      ["/trades/value", JSON.stringify({ lines: [] })],
    ]) {
      for (const prefix of ["/api/pokemon", "/api"]) {
        seen.length = 0;
        // Client-supplied internal headers never survive, whichever path carries them.
        const response = await fetch(base + prefix + route, {
          method: "POST",
          headers: {
            origin,
            cookie,
            "content-type": "application/json",
            "x-internal-budget-ms": "99999",
            "x-internal-caller": "user:someone-else",
          },
          body,
        });
        expect(response.status).toBe(200);
        expect(seen).toHaveLength(1);
        expect(seen[0].url).toBe(`/api${route}`);
        budget("POST", `/api${route}`, body, seen[0].headers);
        expect(seen[0].headers["x-internal-signature"]).toBe(
          sign(
            `POST\n/api${route}\n${hex(body)}\n${userId}\n${seen[0].headers["x-internal-time"]}`
          )
        );
      }
    }
  });

  it("budgets the Want List cost and no other Want List route, signed over the path and not its query", async () => {
    seen.length = 0;
    const response = await call(
      "GET",
      `/api/pokemon/want-list/cost?deck=${id}`
    );
    expect(response.status).toBe(200);
    expect(seen[0].url).toBe(`/api/want-list/cost?deck=${id}`);
    budget("GET", "/api/want-list/cost", "", seen[0].headers);
    seen.length = 0;
    for (const path of [
      "/api/pokemon/want-list",
      "/api/pokemon/want-list/exports/tcgplayer",
    ])
      await call("GET", path);
    expect(seen).toHaveLength(2);
    for (const { headers } of seen)
      for (const name of [
        "x-internal-budget-ms",
        "x-internal-caller",
        "x-internal-budget-signature",
        "x-internal-budget-time",
      ])
        expect(headers[name]).toBeUndefined();
  });

  it("holds a budgeted body to 16 KiB under the new path as under the old", async () => {
    seen.length = 0;
    const narrow = " ".repeat(16_384 - 2) + "{}";
    expect((await post("/api/pokemon/prices/editions", narrow)).status).toBe(
      200
    );
    expect(
      (await post("/api/pokemon/prices/editions", narrow + " ")).status
    ).toBe(413);
    expect((await post("/api/prices/editions", narrow + " ")).status).toBe(413);
    expect(seen).toHaveLength(1);
  });
});

describe("Collection Import bodies under /api/pokemon", () => {
  it("lets the start route carry a 5 MiB file and refuses one byte more, and leaves the old path as it was", async () => {
    for (const prefix of ["/api/pokemon", "/api"]) {
      seen.length = 0;
      const file = binary(FIVE_MIB);
      const started = await fetch(
        `${base}${prefix}/collection-imports?location_id=leaf-1`,
        {
          method: "POST",
          headers: { origin, cookie, "content-type": "application/zip" },
          body: file,
        }
      );
      expect(started.status).toBe(200);
      expect(seen).toHaveLength(1);
      expect(seen[0].url).toBe("/api/collection-imports?location_id=leaf-1");
      expect(seen[0].headers["content-type"]).toBe("application/zip");
      expect(seen[0].body.equals(file)).toBe(true);
      expect(seen[0].headers["x-internal-signature"]).toBe(
        sign(
          `POST\n/api/collection-imports\n${hex(file)}\n${userId}\n${seen[0].headers["x-internal-time"]}`
        )
      );
      const refused = await fetch(
        `${base}${prefix}/collection-imports?location_id=leaf-1`,
        {
          method: "POST",
          headers: { origin, cookie, "content-type": "text/csv" },
          body: Buffer.concat([file, Buffer.from([0x0a])]),
        }
      );
      expect(refused.status).toBe(413);
      expect(seen).toHaveLength(1);
    }
  });

  it("carries a 1 MiB payload (over nginx's 64k default, under 5 MiB) on both start paths with location_id unchanged", async () => {
    const file = Buffer.from("Quantity,Name\n" + "1,Starmie\n".repeat(100_000));
    expect(file.length).toBeGreaterThan(65_536);
    expect(file.length).toBeLessThan(FIVE_MIB);
    for (const prefix of ["/api/pokemon", "/api"]) {
      seen.length = 0;
      const response = await fetch(
        `${base}${prefix}/collection-imports?location_id=leaf-9`,
        {
          method: "POST",
          headers: { origin, cookie, "content-type": "text/csv" },
          body: file,
        }
      );
      expect(response.status).toBe(200);
      expect(seen).toHaveLength(1);
      expect(seen[0].url).toBe("/api/collection-imports?location_id=leaf-9");
      expect(seen[0].body.equals(file)).toBe(true);
    }
  });

  it("gives the changes route 64 KiB and keeps the other Collection Import routes at 16 KiB", async () => {
    seen.length = 0;
    const wide = " ".repeat(65_536 - 2) + "{}";
    const narrow = " ".repeat(16_384 - 2) + "{}";
    const changes = `/api/pokemon/collection-imports/${id}/changes`;
    expect((await post(changes, wide)).status).toBe(200);
    expect((await post(changes, wide + " ")).status).toBe(413);
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe(`/api/collection-imports/${id}/changes`);
    for (const path of [
      `/api/pokemon/collection-imports/${id}/save`,
      `/api/pokemon/collection-imports/${id}`,
      "/api/pokemon/collection-imports/current",
      "/api/pokemon/collection-imports/",
    ])
      expect((await post(path, narrow + " ")).status).toBe(503);
    // The start route's limit is for POST alone.
    const put = await fetch(
      `${base}/api/pokemon/collection-imports?location_id=x`,
      {
        method: "PUT",
        headers: { origin, cookie, "content-type": "text/csv" },
        body: narrow + " ",
      }
    );
    expect(put.status).toBe(503);
    expect(seen).toHaveLength(1);
  });
});

describe("what /api/pokemon does not serve", () => {
  const NOT_MOVED = [
    "/api/pokemon",
    "/api/pokemon/",
    "/api/pokemon/health",
    "/api/pokemon/auth/session",
    "/api/pokemon/auth/callback/google",
    "/api/pokemon/public/decks/x",
    "/api/pokemon/public/art/a/b",
    "/api/pokemon/art/a/b",
    "/api/pokemon/loans",
    "/api/pokemon/social/friends",
    "/api/pokemon/scanner/index",
    "/api/pokemon/decks",
    "/api/pokemon/collection",
    "/api/pokemon/collection/borrowed",
    "/api/pokemon/holdings",
    "/api/pokemon/holdings/1",
    "/api/pokemon/trades",
    "/api/pokemon/trades/list",
    "/api/pokemon/trade-wants",
    "/api/pokemon/prices",
    "/api/pokemon/admin",
    "/api/pokemon/admin/operations",
    "/api/pokemon/publications",
    // Not on a segment boundary, or a different spelling of a moved route.
    "/api/pokemon/catalogue",
    "/api/pokemon/want-listing",
    "/api/pokemon/catalog%2Feditions",
    "/api/pokemon/collection-imports-x",
    // Never a double prefix, and never another game.
    "/api/pokemon/pokemon/catalog/editions",
    "/api/pokemon/riftbound/catalog/editions",
    "/api/pokemon//catalog/editions",
  ];

  it.each(NOT_MOVED)(
    "answers 404 for %s without contacting the upstream",
    async (path) => {
      seen.length = 0;
      for (const method of ["GET", "POST"]) {
        for (const signedIn of [true, false]) {
          const response = await call(method, path, {
            signedIn,
            body: method === "POST" ? "{}" : undefined,
          });
          // Not a 401 for a visitor and not a 403 for a cross-site write: the route does not exist.
          expect(response.status).toBe(404);
        }
      }
      expect(seen).toHaveLength(0);
    }
  );

  it("leaves paths that only start with the letters alone, as before", async () => {
    // /api/pokemonx is not under the prefix: it is an unknown route the upstream answers, and the gateway still
    // requires a session first.
    seen.length = 0;
    const response = await call("GET", "/api/pokemonx/catalog/editions");
    expect(response.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("/api/pokemonx/catalog/editions");
  });

  it("keeps every old path for the routes it does not move exactly where it was", async () => {
    seen.length = 0;
    for (const path of [
      "/api/locations",
      "/api/decks",
      "/api/collection",
      "/api/trades/list",
      "/api/scanner/index",
    ]) {
      expect((await call("GET", path)).status).toBe(200);
    }
    expect(seen.map((request) => request.url)).toEqual([
      "/api/locations",
      "/api/decks",
      "/api/collection",
      "/api/trades/list",
      "/api/scanner/index",
    ]);
    expect((await call("GET", "/api/health", { signedIn: false })).status).toBe(
      200
    );
    expect(
      (await call("GET", "/api/auth/session", { signedIn: false })).status
    ).toBe(404);
  });
});
