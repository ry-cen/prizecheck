import {
  freePort,
  hex,
  scriptedApi,
  signer,
  type Behaviour,
  type Seen,
} from "./support/gateway";
import { afterEach, describe, expect, it } from "vitest";
import { type ChildProcess } from "node:child_process";
import { request as httpRequest, type Server } from "node:http";
import { launch, serverReady } from "./support/servers";

// ADR 0023 (2026-11-16 amendment): Riftbound gets its own /api/riftbound prefix through the gateway. It is off unless
// RIFTBOUND_API_ORIGIN names an upstream, and when on it forwards no identity. The session lookup is replaced by a
// stub that logs each call (support/riftbound-gateway.mjs); everything else is the real gateway.
const origin = "http://localhost:5173";
const cookie = "session=fixture";
const secret = "riftbound-gateway-test-internal-secret";
const sign = signer(secret);

let gateway: ChildProcess | undefined;
let stderr = "";
const servers: Server[] = [];
const pokemonSeen: Seen[] = [];
const riftboundSeen: Seen[] = [];
let pokemonBehaviour: Behaviour = (_, response) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ from: "pokemon" }));
};
let riftboundBehaviour: Behaviour = (_, response) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ from: "riftbound" }));
};

async function listen(seen: Seen[], behaviour: () => Behaviour) {
  const server = scriptedApi(seen, behaviour);
  const port = await freePort();
  await new Promise<void>((resolve) =>
    server.listen(port, "127.0.0.1", resolve)
  );
  servers.push(server);
  return port;
}

/** Starts both mock upstreams and a gateway; `riftbound` picks the RIFTBOUND_API_ORIGIN setting. */
async function start(
  riftbound: "unset" | "empty" | "on" | ((riftboundPort: number) => string)
) {
  pokemonSeen.length = 0;
  riftboundSeen.length = 0;
  const pokemonPort = await listen(pokemonSeen, () => pokemonBehaviour);
  const riftboundPort = await listen(riftboundSeen, () => riftboundBehaviour);
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OWNER_EMAIL: "owner@example.test",
    INTERNAL_AUTH_SECRET: secret,
    BETTER_AUTH_SECRET: "riftbound-gateway-test-better-auth-secret",
    DATABASE_URL: "postgresql://unused/unused",
    AUTH_PORT: String(port),
    API_ORIGIN: `http://127.0.0.1:${pokemonPort}`,
    PUBLIC_ORIGIN: origin,
  };
  delete env.RIFTBOUND_API_ORIGIN;
  if (riftbound === "empty") env.RIFTBOUND_API_ORIGIN = "";
  if (riftbound === "on")
    env.RIFTBOUND_API_ORIGIN = `http://127.0.0.1:${riftboundPort}`;
  if (typeof riftbound === "function")
    env.RIFTBOUND_API_ORIGIN = riftbound(riftboundPort);
  gateway = launch(
    process.execPath,
    [
      "--import",
      "tsx",
      "--import",
      "./auth/tests/support/riftbound-gateway.mjs",
      "auth/src/server.ts",
    ],
    env
  );
  stderr = "";
  gateway.stderr?.on("data", (chunk) => {
    stderr += chunk;
  });
  const base = `http://127.0.0.1:${port}`;
  await serverReady([gateway], base + "/auth/session");
  // The readiness probe is a session read of its own; count only what the test causes.
  stderr = "";
  return base;
}

async function stopAll() {
  if (gateway && gateway.exitCode === null) {
    gateway.kill();
    await new Promise((resolve) => gateway!.once("exit", resolve));
  }
  gateway = undefined;
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
afterEach(stopAll);

/** A request with the target exactly as given: fetch() would normalise dot segments and backslashes first. */
function rawRequest(
  base: string,
  target: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {}
) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: new URL(base).port,
        path: target,
        method: options.method || "GET",
        headers: { cookie, ...options.headers },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode!, body }));
      }
    );
    req.on("error", reject);
    req.end(options.body);
  });
}

const lookups = () => stderr.split("session-lookup").length - 1;

describe("Riftbound prefix, default off", () => {
  for (const setting of ["unset", "empty"] as const) {
    it(`answers 404 with no upstream contact or session lookup (${setting})`, async () => {
      const base = await start(setting);
      for (const method of ["GET", "POST"]) {
        const response = await fetch(base + "/api/riftbound/catalog/sets", {
          method,
          headers: { cookie, origin },
          body: method === "POST" ? "{}" : undefined,
        });
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ error: "Not found" });
      }
      expect(pokemonSeen).toEqual([]);
      expect(riftboundSeen).toEqual([]);
      expect(lookups()).toBe(0);
    });
  }

  it("also answers 404 for the bare prefix and a cross-origin POST, without a lookup", async () => {
    const base = await start("unset");
    expect((await fetch(base + "/api/riftbound")).status).toBe(404);
    const cross = await fetch(base + "/api/riftbound/catalog/sets", {
      method: "POST",
      headers: { cookie, origin: "https://elsewhere.example" },
      body: "{}",
    });
    expect(cross.status).toBe(404);
    expect(pokemonSeen).toEqual([]);
    expect(lookups()).toBe(0);
  });
});

describe("Riftbound prefix, with a synthetic upstream", () => {
  it("maps /api/riftbound/<rest> to /api/<rest> with the query kept", async () => {
    const base = await start("on");
    const response = await fetch(
      base + "/api/riftbound/catalog/editions?q=a&page=2",
      { headers: { cookie } }
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ from: "riftbound" });
    expect(riftboundSeen.map((r) => [r.method, r.url])).toEqual([
      ["GET", "/api/catalog/editions?q=a&page=2"],
    ]);
    expect(pokemonSeen).toEqual([]);
  });

  it("answers 404 for the bare prefix without a lookup or upstream call", async () => {
    const base = await start("on");
    const response = await fetch(base + "/api/riftbound", {
      headers: { cookie },
    });
    expect(response.status).toBe(404);
    expect(riftboundSeen).toEqual([]);
    expect(pokemonSeen).toEqual([]);
    expect(lookups()).toBe(0);
  });

  it("answers 401 with no upstream call when there is no session", async () => {
    const base = await start("on");
    const response = await fetch(base + "/api/riftbound/catalog/sets");
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Authentication required" });
    expect(riftboundSeen).toEqual([]);
    expect(pokemonSeen).toEqual([]);
  });

  it("answers 403 to a cross-origin POST before a lookup or upstream call", async () => {
    const base = await start("on");
    const response = await fetch(base + "/api/riftbound/catalog/sets", {
      method: "POST",
      headers: { cookie, origin: "https://elsewhere.example" },
      body: "{}",
    });
    expect(response.status).toBe(403);
    expect(riftboundSeen).toEqual([]);
    expect(lookups()).toBe(0);
  });

  it("forwards a same-origin POST body and content type", async () => {
    const base = await start("on");
    const response = await fetch(base + "/api/riftbound/catalog/sets", {
      method: "POST",
      headers: { cookie, origin, "content-type": "application/json" },
      body: '{"a":1}',
    });
    expect(response.status).toBe(200);
    expect(riftboundSeen).toHaveLength(1);
    expect(riftboundSeen[0].url).toBe("/api/catalog/sets");
    expect(riftboundSeen[0].body).toBe('{"a":1}');
    expect(riftboundSeen[0].headers["content-type"]).toBe("application/json");
  });

  it("forwards no identity and strips spoofed x-internal headers", async () => {
    const base = await start("on");
    await fetch(base + "/api/riftbound/catalog/sets", {
      headers: {
        cookie,
        "x-internal-user": "spoofed",
        "x-internal-time": "1",
        "x-internal-signature": "forged",
        "x-internal-budget-ms": "3000",
        "x-internal-caller": "spoofed",
      },
    });
    expect(riftboundSeen).toHaveLength(1);
    const names = Object.keys(riftboundSeen[0].headers);
    expect(names.filter((name) => name.startsWith("x-internal"))).toEqual([]);
    expect(names).not.toContain("cookie");
    expect(names).not.toContain("authorization");
  });

  it("relays the upstream status, content type and body", async () => {
    const base = await start("on");
    riftboundBehaviour = (_, response) => {
      response.writeHead(401, { "content-type": "application/json" });
      response.end('{"detail":"Authentication required"}');
    };
    try {
      const response = await fetch(base + "/api/riftbound/catalog/sets", {
        headers: { cookie },
      });
      expect(response.status).toBe(401);
      expect(response.headers.get("content-type")).toBe("application/json");
      expect(await response.text()).toBe(
        '{"detail":"Authentication required"}'
      );
      riftboundBehaviour = (_, response) => {
        response.writeHead(404, { "content-type": "text/plain" });
        response.end("missing");
      };
      const missing = await fetch(base + "/api/riftbound/catalog/editions/x", {
        headers: { cookie },
      });
      expect(missing.status).toBe(404);
      expect(missing.headers.get("content-type")).toBe("text/plain");
      expect(await missing.text()).toBe("missing");
    } finally {
      riftboundBehaviour = (_, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ from: "riftbound" }));
      };
    }
  });
});

describe("Pokémon routes are unchanged", () => {
  for (const setting of ["unset", "on"] as const) {
    it(`still signs and forwards /api paths to the Pokémon upstream (Riftbound ${setting})`, async () => {
      const base = await start(setting);
      for (const path of [
        "/api/catalog/search?q=riftbound",
        "/api/riftboundx/thing",
        "/api/decks/riftbound",
      ]) {
        pokemonSeen.length = 0;
        const response = await fetch(base + path, { headers: { cookie } });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ from: "pokemon" });
        expect(pokemonSeen).toHaveLength(1);
        const seen = pokemonSeen[0];
        expect(seen.url).toBe(path);
        const stamp = seen.headers["x-internal-time"] as string;
        expect(seen.headers["x-internal-user"]).toBe("stream-reader");
        expect(seen.headers["x-internal-signature"]).toBe(
          sign(
            `GET\n${path.split("?")[0]}\n${hex("")}\nstream-reader\n${stamp}`
          )
        );
      }
      expect(riftboundSeen).toEqual([]);
    });
  }
});

describe("Riftbound prefix, request body limit", () => {
  const post = (base: string, body: string) =>
    fetch(base + "/api/riftbound/catalog/sets", {
      method: "POST",
      headers: { cookie, origin, "content-type": "text/plain" },
      body,
    });

  it("passes an ASCII body of exactly 16,384 bytes and refuses 16,385", async () => {
    const base = await start("on");
    expect((await post(base, "a".repeat(16_384))).status).toBe(200);
    expect(riftboundSeen).toHaveLength(1);
    expect(riftboundSeen[0].body).toHaveLength(16_384);
    riftboundSeen.length = 0;
    expect((await post(base, "a".repeat(16_385))).status).toBe(413);
    expect(riftboundSeen).toEqual([]);
    expect(pokemonSeen).toEqual([]);
  });

  it("counts bytes: a multibyte body under 16,384 characters but over 16,384 bytes is refused", async () => {
    const base = await start("on");
    // 8,193 characters, 16,386 bytes.
    const response = await post(base, "é".repeat(8_193));
    expect(response.status).toBe(413);
    expect(riftboundSeen).toEqual([]);
    expect(pokemonSeen).toEqual([]);
    // 8,192 characters is exactly 16,384 bytes and passes, bytes unchanged.
    expect((await post(base, "é".repeat(8_192))).status).toBe(200);
    expect(Buffer.byteLength(riftboundSeen[0].body)).toBe(16_384);
  });
});

describe("Riftbound prefix, raw request targets", () => {
  // Each target is sent exactly as written. The namespace is read twice, on the raw target and on the normalised path;
  // any disagreement, and any dot segment, encoded slash or backslash inside the namespace, is a 404 before a session
  // lookup, a body read or an upstream call.
  const refused = [
    "/api/riftbound/%2e%2e/loans",
    "/api/riftbound/%2E%2E/loans",
    "/api/riftbound/.%2e/loans",
    "/api/riftbound/../loans",
    "/api/riftbound/./catalog/sets",
    "/api/riftbound/%2e/catalog/sets",
    "/api/riftbound\\..\\loans",
    "/api/riftbound\\catalog\\sets",
    "/api/riftbound/x/%2e%2e/%2e%2e/loans",
    "/api/riftbound/catalog%2fsets",
    "/api/riftbound/catalog%2Fsets",
    "/api/riftbound/catalog%5csets",
    "/api/riftbound/catalog%5Csets",
    "/api/catalog/%2e%2e/riftbound/x",
    "/api/catalog/../riftbound/x",
    "/api/riftbound/%2e",
    "/api/riftbound/%2e?q=1",
  ];
  for (const setting of ["on", "unset"] as const) {
    it(`answers 404 with no lookup or upstream call (Riftbound ${setting})`, async () => {
      const base = await start(setting);
      for (const target of refused) {
        const response = await rawRequest(base, target);
        expect([target, response.status]).toEqual([target, 404]);
      }
      const cross = await rawRequest(base, "/api/riftbound/%2e%2e/loans", {
        method: "POST",
        headers: { origin: "https://elsewhere.example" },
        body: "{}",
      });
      expect(cross.status).toBe(404);
      expect(lookups()).toBe(0);
      expect(pokemonSeen).toEqual([]);
      expect(riftboundSeen).toEqual([]);
    });
  }

  it("answers 404 for the bare prefix with a trailing slash, without a lookup or upstream call", async () => {
    const base = await start("on");
    for (const target of ["/api/riftbound/", "/api/riftbound/?q=1"])
      expect([target, (await rawRequest(base, target)).status]).toEqual([
        target,
        404,
      ]);
    expect(lookups()).toBe(0);
    expect(pokemonSeen).toEqual([]);
    expect(riftboundSeen).toEqual([]);
  });

  it("forwards /api/riftbound//x as /api//x and sends /api//riftbound/x to the Pokémon upstream", async () => {
    const base = await start("on");
    expect((await rawRequest(base, "/api/riftbound//x")).status).toBe(200);
    expect(riftboundSeen.map((r) => r.url)).toEqual(["/api//x"]);
    expect(pokemonSeen).toEqual([]);
    riftboundSeen.length = 0;
    expect((await rawRequest(base, "/api//riftbound/x")).status).toBe(200);
    expect(pokemonSeen.map((r) => r.url)).toEqual(["/api//riftbound/x"]);
    expect(riftboundSeen).toEqual([]);
  });

  it("leaves other targets alone: a Pokémon path with dot segments still reaches the Pokémon upstream", async () => {
    const base = await start("on");
    expect((await rawRequest(base, "/api/catalog/../loans")).status).toBe(200);
    expect(pokemonSeen).toHaveLength(1);
    expect(riftboundSeen).toEqual([]);
  });
});

describe("Riftbound prefix, absolute-form targets", () => {
  // An absolute-form request line names its own path: `GET http://host/api/... HTTP/1.1`. The gateway reads that raw path
  // like an origin-form one, and refuses every absolute-form target that is in the namespace on either reading.
  const refused = [
    "http://host/api/riftbound/%2E%2e/loans",
    "HTTP://host/api/riftbound/x/%2e%2e/%2e%2e/loans",
    "http://host/api/riftbound/..\\loans",
    "http://host/api/catalog/%2e%2e/riftbound/x",
    "http://host/api/riftbound/x",
    "https://host:8443/api/riftbound/catalog/sets?q=a",
    "http://host/api/riftbound",
  ];
  for (const setting of ["on", "unset"] as const) {
    it(`answers 404 with no lookup or upstream call (Riftbound ${setting})`, async () => {
      const base = await start(setting);
      for (const target of refused) {
        const response = await rawRequest(base, target);
        expect([target, response.status]).toEqual([target, 404]);
      }
      const cross = await rawRequest(base, refused[0], {
        method: "POST",
        headers: { origin: "https://elsewhere.example" },
        body: "{}",
      });
      expect(cross.status).toBe(404);
      expect(lookups()).toBe(0);
      expect(pokemonSeen).toEqual([]);
      expect(riftboundSeen).toEqual([]);
    });
  }

  it("does not look at an absolute-form target outside the namespace", async () => {
    const base = await start("on");
    // What the gateway makes of this target is unchanged; it only must not be refused as a Riftbound target.
    await rawRequest(base, "http://host/api/catalog/x");
    expect(lookups()).toBe(1);
    expect(riftboundSeen).toEqual([]);
  });
});

describe("Riftbound prefix, origin setting", () => {
  it("ignores a trailing slash and any path in the setting", async () => {
    for (const suffix of ["/", "/prefix/", "/prefix"]) {
      const base = await start((port) => `http://127.0.0.1:${port}${suffix}`);
      expect(
        (
          await fetch(base + "/api/riftbound/catalog/sets?q=a", {
            headers: { cookie },
          })
        ).status
      ).toBe(200);
      expect(riftboundSeen.map((r) => r.url)).toEqual([
        "/api/catalog/sets?q=a",
      ]);
      await stopAll();
    }
  });

  it("treats an unparsable or non-HTTP value as off, with no crash", async () => {
    for (const value of [
      "not a url",
      "127.0.0.1:9",
      "ftp://example.test",
      "  ",
    ]) {
      const base = await start(() => value);
      const response = await fetch(base + "/api/riftbound/catalog/sets", {
        headers: { cookie },
      });
      expect([value, response.status]).toEqual([value, 404]);
      expect(lookups()).toBe(0);
      expect(riftboundSeen).toEqual([]);
      expect((await fetch(base + "/auth/session")).status).toBe(200);
      await stopAll();
    }
  });
});
