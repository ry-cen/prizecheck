import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createHmac, createHash, randomUUID } from "node:crypto";
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

// The gateway runs here against its own database and a scripted API, so the budget, the abort and the download pipe are
// observed from outside: what the API receives, what the browser receives, and when.
const admin = new Pool({ connectionString: process.env.DATABASE_URL });
const database = "tcg_prices_" + randomUUID().replaceAll("-", "");
const directory = mkdtempSync(join(tmpdir(), "tcg-prices-"));
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
const hex = (value: string) => createHash("sha256").update(value).digest("hex");
const sign = (message: string) =>
  createHmac("sha256", secret).update(message).digest("hex");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
  const email = "price-reader@example.test";
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

const ok = (_: IncomingMessage, response: ServerResponse) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ prices: [], withheld: false }));
};

describe("budgeted price route", () => {
  it("stamps a signed budget for this caller and request, and discards client-supplied internal headers", async () => {
    behaviour = ok;
    seen.length = 0;
    const body = JSON.stringify({ edition_ids: [randomUUID()] });
    const forged = {
      "x-internal-budget-ms": "99999",
      "x-internal-caller": "user:someone-else",
      "x-internal-budget-signature": "0".repeat(64),
      "x-internal-user": "someone-else",
      "x-internal-budget-time": "1",
    };
    const response = await gatewayPost("/api/prices/editions", body, forged);
    expect(response.status).toBe(200);
    const [request] = seen;
    const { headers } = request;
    expect(headers["x-internal-user"]).toBe(userId);
    expect(headers["x-internal-caller"]).toBe(`user:${userId}`);
    const milliseconds = Number(headers["x-internal-budget-ms"]);
    expect(milliseconds).toBeGreaterThan(2_000);
    expect(milliseconds).toBeLessThanOrEqual(3_000);
    // The budget stamp is epoch milliseconds (the API subtracts the time since it); the identity stamp stays seconds.
    const stamp = headers["x-internal-budget-time"] as string;
    expect(stamp).toMatch(/^\d{13}$/);
    expect(Math.abs(Number(stamp) - Date.now())).toBeLessThan(30_000);
    expect(headers["x-internal-budget-signature"]).toBe(
      sign(
        `budget\nPOST\n/api/prices/editions\n${hex(body)}\nuser:${userId}\n${headers["x-internal-budget-ms"]}\n${stamp}`
      )
    );
    // The existing identity message is unchanged.
    expect(headers["x-internal-signature"]).toBe(
      sign(
        `POST\n/api/prices/editions\n${hex(body)}\n${userId}\n${headers["x-internal-time"]}`
      )
    );
  });

  it("does not stamp a budget on other routes", async () => {
    behaviour = ok;
    seen.length = 0;
    await fetch(base + "/api/locations", { headers: { cookie } });
    expect(seen[0].headers["x-internal-user"]).toBe(userId);
    for (const name of [
      "x-internal-budget-ms",
      "x-internal-caller",
      "x-internal-budget-signature",
      "x-internal-budget-time",
    ])
      expect(seen[0].headers[name]).toBeUndefined();
  });

  it("stamps a budget on the Want List cost, signed over its path and not its query, and on no other Want List route", async () => {
    behaviour = ok;
    seen.length = 0;
    const deck = randomUUID();
    const response = await fetch(`${base}/api/want-list/cost?deck=${deck}`, {
      headers: { cookie },
    });
    expect(response.status).toBe(200);
    const [request] = seen;
    expect(request.url).toBe(`/api/want-list/cost?deck=${deck}`);
    const { headers } = request;
    expect(headers["x-internal-caller"]).toBe(`user:${userId}`);
    const milliseconds = Number(headers["x-internal-budget-ms"]);
    expect(milliseconds).toBeGreaterThan(2_000);
    expect(milliseconds).toBeLessThanOrEqual(3_000);
    expect(headers["x-internal-budget-signature"]).toBe(
      sign(
        `budget\nGET\n/api/want-list/cost\n${hex("")}\nuser:${userId}\n${headers["x-internal-budget-ms"]}\n${headers["x-internal-budget-time"]}`
      )
    );
    // The list itself and Buy on TCGplayer read no price: no budget, so a download is never cut at three seconds.
    seen.length = 0;
    for (const path of [
      "/api/want-list",
      "/api/want-list/exports/tcgplayer",
      "/api/want-list/exports/tcgplayer.txt?owner_revision=1",
    ])
      await fetch(base + path, { headers: { cookie } });
    expect(seen).toHaveLength(3);
    for (const { headers: sent } of seen) {
      expect(sent["x-internal-user"]).toBe(userId);
      for (const name of [
        "x-internal-budget-ms",
        "x-internal-caller",
        "x-internal-budget-signature",
        "x-internal-budget-time",
      ])
        expect(sent[name]).toBeUndefined();
    }
  });

  // slow (wall-clock): waits out the gateway's real 3 s budget (BUDGET_MS in auth/src/server.ts has no test seam).
  it(
    "answers 504 PRICE_DEADLINE inside three seconds when the API hangs",
    { tags: ["slow"], timeout: 10_000 },
    async () => {
      behaviour = (_, response) => {
        setTimeout(() => response.end("{}"), 5_000).unref();
      };
      const started = performance.now();
      const response = await gatewayPost(
        "/api/prices/editions",
        JSON.stringify({ edition_ids: [randomUUID()] })
      );
      const elapsed = performance.now() - started;
      expect(response.status).toBe(504);
      expect(await response.json()).toEqual({
        detail: { code: "PRICE_DEADLINE" },
      });
      expect(elapsed).toBeLessThanOrEqual(3_000);
      expect(elapsed).toBeGreaterThan(2_000);
    }
  );

  // slow (wall-clock): waits out the gateway's real 3 s budget (BUDGET_MS in auth/src/server.ts has no test seam).
  it(
    "answers 504 when the API stalls mid-body, before any status line is sent",
    { tags: ["slow"], timeout: 10_000 },
    async () => {
      behaviour = (_, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.write('{"prices":');
        setTimeout(() => response.end("[]}"), 5_000).unref();
      };
      const started = performance.now();
      const response = await gatewayPost(
        "/api/prices/editions",
        JSON.stringify({ edition_ids: [randomUUID()] })
      );
      expect(response.status).toBe(504);
      expect(performance.now() - started).toBeLessThanOrEqual(3_000);
    }
  );

  // slow (wall-clock): a real slow session lookup inside the 3 s budget.
  it(
    "takes the receipt time before a slow session lookup, so the API sees only what is left",
    { tags: ["slow"], timeout: 10_000 },
    async () => {
      behaviour = ok;
      seen.length = 0;
      const blocker = await pool.connect();
      await blocker.query("BEGIN");
      await blocker.query('LOCK TABLE "session" IN ACCESS EXCLUSIVE MODE');
      const pending = gatewayPost(
        "/api/prices/editions",
        JSON.stringify({ edition_ids: [randomUUID()] })
      );
      await sleep(1_200);
      await blocker.query("ROLLBACK");
      blocker.release();
      expect((await pending).status).toBe(200);
      const milliseconds = Number(seen[0].headers["x-internal-budget-ms"]);
      expect(milliseconds).toBeLessThanOrEqual(1_800);
      expect(milliseconds).toBeGreaterThan(0);
    }
  );

  // slow (wall-clock): waits out the gateway's real 3 s budget (BUDGET_MS in auth/src/server.ts has no test seam).
  it(
    "gives up with 504 when the session lookup alone spends the budget, and PostgreSQL ends the abandoned lookup",
    { tags: ["slow"], timeout: 10_000 },
    async () => {
      behaviour = ok;
      seen.length = 0;
      const blocker = await pool.connect();
      await blocker.query("BEGIN");
      await blocker.query('LOCK TABLE "session" IN ACCESS EXCLUSIVE MODE');
      try {
        const started = performance.now();
        const response = await gatewayPost(
          "/api/prices/editions",
          JSON.stringify({ edition_ids: [randomUUID()] })
        );
        expect(response.status).toBe(504);
        expect(performance.now() - started).toBeLessThanOrEqual(3_000);
        expect(seen).toHaveLength(0);
        // The abandoned lookup is cancelled by its own pool's statement timeout while the lock is still held, rather
        // than keeping a connection until the lock goes.
        const waiting = async () =>
          (
            await pool.query(
              "SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock'",
              [database]
            )
          ).rows[0].count;
        await expect.poll(waiting, { timeout: 1_500, interval: 50 }).toBe(0);
      } finally {
        await blocker.query("ROLLBACK");
        blocker.release();
      }
    }
  );

  it("rejects bodies over 16 KiB by byte length with 413 and never reaches the API", async () => {
    behaviour = ok;
    seen.length = 0;
    const exact = " ".repeat(16_384 - 2) + "{}";
    expect((await gatewayPost("/api/prices/editions", exact)).status).toBe(200);
    expect(seen).toHaveLength(1);
    const over = exact + " ";
    expect((await gatewayPost("/api/prices/editions", over)).status).toBe(413);
    // 9,000 two-byte characters are under 16,384 characters and over 16,384 bytes.
    const wide = JSON.stringify({ pad: "é".repeat(9_000) });
    expect(wide.length).toBeLessThan(16_384);
    expect((await gatewayPost("/api/prices/editions", wide)).status).toBe(413);
    expect(seen).toHaveLength(1);
  });

  it("lets the decklist import routes carry a 20,000-character paste and refuses their bodies over 64 KiB with 413", async () => {
    behaviour = ok;
    seen.length = 0;
    // A paste of the API's 20,000-character limit is over the 16 KiB other routes accept.
    const paste = JSON.stringify({
      source: { text: "x".repeat(20_000) },
      fixes: [],
    });
    const reviewed = await gatewayPost("/api/decks/import/review", paste);
    expect(reviewed.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("/api/decks/import/review");
    expect(seen[0].body).toBe(paste);
    expect(seen[0].headers["x-internal-signature"]).toBe(
      sign(
        `POST\n/api/decks/import/review\n${hex(paste)}\n${userId}\n${seen[0].headers["x-internal-time"]}`
      )
    );
    const exact = " ".repeat(65_536 - 2) + "{}";
    for (const path of ["/api/decks/import/review", "/api/decks/import"]) {
      expect((await gatewayPost(path, exact)).status).toBe(200);
      expect((await gatewayPost(path, exact + " ")).status).toBe(413);
    }
    // 33,000 two-byte characters are under 65,536 characters and over 65,536 bytes.
    const wide = JSON.stringify({ pad: "é".repeat(33_000) });
    expect(wide.length).toBeLessThan(65_536);
    expect((await gatewayPost("/api/decks/import/review", wide)).status).toBe(
      413
    );
    expect(seen).toHaveLength(3);
    // Other routes keep their 16 KiB limit: the paste never reaches the API through them.
    expect((await gatewayPost("/api/decks", paste)).status).not.toBe(200);
    expect(seen).toHaveLength(3);
  });

  it("requires a session", async () => {
    behaviour = ok;
    seen.length = 0;
    const response = await fetch(base + "/api/prices/editions", {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(401);
    expect(seen).toHaveLength(0);
  });
});

describe("public routes", () => {
  it("refuses every method but GET with 405 before a session lookup, a body read or the API", async () => {
    behaviour = ok;
    seen.length = 0;
    const path = `/api/public/decks/${"T".repeat(32)}/versions/1/cost`;
    for (const method of ["POST", "PUT", "PATCH", "DELETE"])
      for (const extra of [{}, { cookie }]) {
        const response = await fetch(base + path, {
          method,
          headers: { origin, "content-type": "application/json", ...extra },
          body: "{}",
        });
        expect(response.status).toBe(405);
        expect(response.headers.get("allow")).toBe("GET");
      }
    const head = await fetch(base + "/api/public/sitemap.xml", {
      method: "HEAD",
    });
    expect(head.status).toBe(405);
    expect(seen).toHaveLength(0);
    // A GET still goes through, anonymously.
    expect((await fetch(base + path, { headers: { cookie } })).status).toBe(
      200
    );
    expect(seen).toHaveLength(1);
    expect(seen[0].headers["x-internal-user"]).toBeUndefined();
  });
});

describe("attachment pass-through", () => {
  it("streams a download without buffering it and forwards its disposition", async () => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    const chunk = Buffer.alloc(64 * 1024, 97);
    const total = 48;
    behaviour = (_, response) => {
      response.writeHead(200, {
        "content-type": "text/plain; charset=utf-8",
        "content-disposition": 'attachment; filename="deck.txt"',
      });
      response.write(chunk);
      void released.then(async () => {
        for (let n = 1; n < total; n++) {
          if (!response.write(chunk))
            await new Promise((resolve) => response.once("drain", resolve));
        }
        response.end();
      });
    };
    const response = await fetch(
      base + "/api/decks/x/exports/live.txt?owner_revision=1",
      { headers: { cookie } }
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="deck.txt"'
    );
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const reader = response.body!.getReader();
    // The first chunk arrives while the API is still holding the rest: nothing is buffered to completion.
    const first = await reader.read();
    expect(first.done).toBe(false);
    let received = first.value!.length;
    release();
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      received += next.value.length;
    }
    expect(received).toBe(chunk.length * total);
  }, 20_000);

  it("stops reading from the API when the browser walks away", async () => {
    let closed!: () => void;
    const upstreamClosed = new Promise<void>((resolve) => (closed = resolve));
    behaviour = (_, response) => {
      response.writeHead(200, {
        "content-type": "text/plain",
        "content-disposition": "attachment; filename=big.txt",
      });
      const timer = setInterval(
        () => response.write(Buffer.alloc(32 * 1024, 98)),
        5
      );
      response.on("close", () => {
        clearInterval(timer);
        closed();
      });
    };
    const controller = new AbortController();
    const response = await fetch(
      base + "/api/decks/x/exports/tcgplayer.txt?owner_revision=1",
      {
        headers: { cookie },
        signal: controller.signal,
      }
    );
    await response.body!.getReader().read();
    controller.abort();
    await Promise.race([
      upstreamClosed,
      sleep(5_000).then(() =>
        Promise.reject(new Error("upstream kept streaming"))
      ),
    ]);
  }, 10_000);

  it("keeps ordinary responses buffered, with only the previously forwarded headers", async () => {
    behaviour = (_, response) => {
      response.writeHead(200, {
        "content-type": "application/json",
        "content-disposition": "inline",
        "x-secret": "no",
      });
      response.end('{"ok":true}');
    };
    const response = await fetch(base + "/api/locations", {
      headers: { cookie },
    });
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get("content-disposition")).toBeNull();
    expect(response.headers.get("x-secret")).toBeNull();
  });
});
