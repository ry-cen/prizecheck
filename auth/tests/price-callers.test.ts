import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { createServer as netServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { dropDatabase, launch, serverReady } from "./support/servers";
import {
  anonymousDigest,
  callerFor,
  normalizeIp,
  trustedClientIp,
  type CallerRequest,
} from "../src/caller.js";

const SECRET = "test-internal-secret";
const HOUR = 3_600_000;
const request = (
  peer: string,
  headers: Record<string, string> = {}
): CallerRequest => ({ socket: { remoteAddress: peer }, headers });
const options = (now: number, secret = SECRET, trusted = "10.0.0.1") => ({
  secret,
  now: () => now,
  trustedProxies: trusted,
});

describe("IP normalisation", () => {
  it("keeps IPv4 as-is and maps IPv4-in-IPv6 back", () => {
    expect(normalizeIp("192.0.2.7")).toBe("192.0.2.7");
    expect(normalizeIp("::ffff:192.0.2.7")).toBe("192.0.2.7");
  });
  it("collapses IPv6 to its /64 whatever the spelling", () => {
    const expected = "2001:db8:1:2::/64";
    expect(normalizeIp("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe(expected);
    expect(normalizeIp("2001:0DB8:0001:0002::1")).toBe(expected);
    expect(normalizeIp("2001:db8:1:2::")).toBe(expected);
    expect(normalizeIp("2001:db8:1:3::1")).not.toBe(expected);
    expect(normalizeIp("::1")).toBe("0:0:0:0::/64");
    expect(normalizeIp("fe80::1%en0")).toBe("fe80:0:0:0::/64");
  });
});

describe("callerFor", () => {
  it("names a signed-in caller by user id", () => {
    expect(
      callerFor(request("203.0.113.9"), { user: { id: "u-1" } }, options(0))
    ).toBe("user:u-1");
  });
  it("derives the same anon digest on two instances sharing the secret within an interval", () => {
    const a = callerFor(request("203.0.113.9"), null, options(5 * HOUR + 1));
    const b = callerFor(request("203.0.113.9"), null, options(6 * HOUR - 1));
    expect(a).toMatch(/^anon:[0-9a-f]{32}$/);
    expect(b).toBe(a);
  });
  it("differs by address, by secret and across the hour boundary", () => {
    const base = callerFor(request("203.0.113.9"), null, options(5 * HOUR));
    expect(
      callerFor(request("203.0.113.10"), null, options(5 * HOUR))
    ).not.toBe(base);
    expect(
      callerFor(request("203.0.113.9"), null, options(5 * HOUR, "other"))
    ).not.toBe(base);
    expect(callerFor(request("203.0.113.9"), null, options(6 * HOUR))).not.toBe(
      base
    );
  });
  it("treats a whole IPv6 /64 as one caller", () => {
    const one = callerFor(request("2001:db8:1:2::1"), null, options(0));
    expect(callerFor(request("2001:db8:1:2:f::9"), null, options(0))).toBe(one);
    expect(callerFor(request("2001:db8:1:3::1"), null, options(0))).not.toBe(
      one
    );
  });
  it("honours x-real-ip only from a trusted peer", () => {
    const real = { "x-real-ip": "198.51.100.4" };
    const viaProxy = callerFor(request("10.0.0.1", real), null, options(0));
    expect(viaProxy).toBe(callerFor(request("198.51.100.4"), null, options(0)));
    const spoofed = callerFor(request("203.0.113.9", real), null, options(0));
    expect(spoofed).toBe(callerFor(request("203.0.113.9"), null, options(0)));
    expect(spoofed).not.toBe(viaProxy);
    expect(
      trustedClientIp(
        request("10.0.0.1", { "x-real-ip": "nonsense" }),
        "10.0.0.1"
      )
    ).toBe("10.0.0.1");
  });
  it("never embeds the address or the key in the caller", () => {
    const caller = callerFor(request("203.0.113.9"), null, options(0));
    expect(caller).not.toContain("203");
    expect(caller).not.toContain(SECRET);
    expect(anonymousDigest(SECRET, "203.0.113.9", 0)).toHaveLength(32);
  });
  it("refuses to mint an anonymous caller without a secret", () => {
    expect(() =>
      callerFor(request("203.0.113.9"), null, options(0, ""))
    ).toThrow();
  });
});

// Gateway seam: a real gateway in front of a scripted API shows what actually leaves the process.
const admin = new Pool({ connectionString: process.env.DATABASE_URL });
const database = "tcg_callers_" + randomUUID().replaceAll("-", "");
const directory = mkdtempSync(join(tmpdir(), "tcg-callers-"));
const origin = process.env.TEST_ORIGIN || "http://localhost:5173";
let pool: Pool;
let gateway: ChildProcess;
let api: Server;
let base = "";
let cookie = "";
let userId = "";
const seen: IncomingMessage["headers"][] = [];
const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = netServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
const post = (path: string, body: string, extra: Record<string, string> = {}) =>
  fetch(base + path, {
    method: "POST",
    headers: { origin, "content-type": "application/json", cookie, ...extra },
    body,
  });

describe("gateway seam", () => {
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
      DATABASE_URL: connection.toString(),
      AUTH_PORT: String(port),
      API_ORIGIN: `http://127.0.0.1:${apiPort}`,
      MAIL_MODE: "file",
      MAIL_FILE: join(directory, "mail"),
      SIGNUP_MODE: "local-public",
      NODE_ENV: "test",
      OWNER_EMAIL: "owner@example.test",
      PUBLIC_ORIGIN: origin,
      TRUSTED_PROXY_IPS: "127.0.0.1,::1,::ffff:127.0.0.1",
    };
    await new Promise<void>((resolve, reject) => {
      spawn(".venv/bin/python", ["scripts/migrate.py"], {
        env,
        stdio: "ignore",
      }).on("exit", (status) =>
        status === 0 ? resolve() : reject(new Error("Migration failed"))
      );
    });
    api = createServer((incoming, response) => {
      incoming.resume();
      incoming.on("end", () => {
        seen.push(incoming.headers);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ prices: [], withheld: false }));
      });
    });
    await new Promise<void>((resolve) =>
      api.listen(apiPort, "127.0.0.1", resolve)
    );
    gateway = launch("node", ["--import", "tsx", "auth/src/server.ts"], env);
    await serverReady([gateway], base + "/auth/session");
    const email = "caller-reader@example.test";
    expect(
      (await post("/auth/request-code", JSON.stringify({ email }))).status
    ).toBe(202);
    const code = JSON.parse(
      readFileSync(join(directory, "mail"), "utf8").trim().split("\n").at(-1)!
    ).otp;
    const signin = await post(
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

  it("keeps the private price route on user: and forwards no address upstream", async () => {
    seen.length = 0;
    const response = await post(
      "/api/prices/editions",
      JSON.stringify({ edition_ids: [randomUUID()] }),
      { "x-real-ip": "198.51.100.77", "x-forwarded-for": "198.51.100.78" }
    );
    expect(response.status).toBe(200);
    const [headers] = seen;
    expect(headers["x-internal-caller"]).toBe(`user:${userId}`);
    const everything = JSON.stringify(headers);
    for (const raw of ["198.51.100.77", "198.51.100.78"])
      expect(everything).not.toContain(raw);
    expect(headers["x-real-ip"]).toBeUndefined();
    expect(headers["x-forwarded-for"]).toBeUndefined();
  });
});
