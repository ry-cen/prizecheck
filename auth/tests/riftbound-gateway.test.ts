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
import { type Server } from "node:http";
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
async function start(riftbound: "unset" | "empty" | "on") {
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

afterEach(async () => {
  if (gateway && gateway.exitCode === null) {
    gateway.kill();
    await new Promise((resolve) => gateway!.once("exit", resolve));
  }
  gateway = undefined;
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

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
