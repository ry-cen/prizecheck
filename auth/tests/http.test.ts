import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:net";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = process.env.TEST_BASE_URL || "http://localhost:5173";
const origin = process.env.TEST_ORIGIN || "http://localhost:5173";
const email = process.env.OWNER_EMAIL || "owner@example.test";
const mailFile = process.env.MAIL_FILE || "/tmp/tcg-ticket01-mail";
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function latestCode(): string {
  const lines = readFileSync(mailFile, "utf8").trim().split("\n");
  return JSON.parse(lines.at(-1)!).otp;
}
async function post(path: string, body: object, cookie = "") {
  return fetch(base + path, {
    method: "POST",
    headers: { origin, "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
}

describe("live Better Auth boundary", () => {
  beforeAll(async () => {
    await pool.query("DELETE FROM auth_send_event");
    await pool.query("DELETE FROM verification");
  });

  it("keeps requests uniform, stores hashed codes, rotates and expires them", async () => {
    const outsider = await post("/auth/request-code", {
      email: "other@example.test",
    });
    const owner = await post("/auth/request-code", { email });
    expect(outsider.status).toBe(202);
    expect(await outsider.json()).toEqual(await owner.json());
    const first = latestCode();
    const stored = await pool.query(
      'SELECT value FROM verification ORDER BY "createdAt" DESC LIMIT 1'
    );
    expect(stored.rows[0].value).not.toContain(first);
    await post("/auth/request-code", { email });
    expect(latestCode()).toBe(first); // one per minute
    await pool.query(
      "UPDATE auth_send_event SET sent_at = now() - interval '61 seconds'"
    );
    await post("/auth/request-code", { email });
    const second = latestCode();
    expect(second).not.toBe(first);
    expect(
      (await post("/auth/verify-code", { email, code: first })).status
    ).toBe(401);
    await pool.query(
      "UPDATE verification SET \"expiresAt\" = now() - interval '1 second'"
    );
    expect(
      (await post("/auth/verify-code", { email, code: second })).status
    ).toBe(401);
  });

  it("rejects three wrong attempts and signs out a valid session", async () => {
    await pool.query(
      "UPDATE auth_send_event SET sent_at = now() - interval '61 seconds'"
    );
    await post("/auth/request-code", { email });
    const code = latestCode();
    for (let i = 0; i < 3; i++)
      expect(
        (await post("/auth/verify-code", { email, code: "000000" })).status
      ).toBe(401);
    expect((await post("/auth/verify-code", { email, code })).status).toBe(401);
    await pool.query(
      "UPDATE auth_send_event SET sent_at = now() - interval '61 seconds'"
    );
    await post("/auth/request-code", { email });
    const fresh = latestCode();
    const signedIn = await post("/auth/verify-code", { email, code: fresh });
    expect(signedIn.status).toBe(200);
    expect(await signedIn.json()).toEqual({ signedIn: true });
    const users = await pool.query('SELECT id FROM "user" WHERE email = $1', [
      email,
    ]);
    const onboarded = await pool.query(
      "SELECT name, kind FROM location WHERE owner_id = $1",
      [users.rows[0].id]
    );
    expect(onboarded.rows).toContainEqual({
      name: "Unsorted",
      kind: "storage_leaf",
    });
    const cookie = signedIn.headers.get("set-cookie")!.split(";")[0];
    expect(signedIn.headers.get("set-cookie")).toContain("HttpOnly");
    expect(signedIn.headers.get("set-cookie")).toContain("SameSite=Lax");
    expect(
      (await fetch(base + "/api/locations", { headers: { cookie } })).status
    ).toBe(200);
    const signedOut = await post("/auth/sign-out", {}, cookie);
    expect(signedOut.status).toBe(200);
    expect(
      (await fetch(base + "/api/locations", { headers: { cookie } })).status
    ).toBe(401);
  });

  it("serves Published Deck reads with no, forged and valid cookies without waking either database", async () => {
    // A counting listener stands in for PostgreSQL: every connection attempt is a wakeup.
    let wakeups = 0;
    const database: Server = createServer((socket) => {
      wakeups++;
      socket.destroy();
    });
    const listen = (server: Server) =>
      new Promise<number>((resolve) =>
        server.listen(0, "127.0.0.1", () =>
          resolve((server.address() as { port: number }).port)
        )
      );
    const freePort = async () => {
      const probe = createServer();
      const port = await listen(probe);
      await new Promise((resolve) => probe.close(resolve));
      return port;
    };
    const databasePort = await listen(database);
    const apiPort = await freePort();
    const gatewayPort = await freePort();
    const databaseUrl = `postgresql://nobody:nobody@127.0.0.1:${databasePort}/none`;
    const directory = mkdtempSync(join(tmpdir(), "public-deck-boundary-"));
    const token = "A".repeat(32);
    const edition = {
      set_id: "base",
      set_name: "Base Set",
      collector_number: "25",
      variant: { label: "Unspecified Variant" },
      image_url: null,
      quantity: "3",
      edition_ref: "a".repeat(48),
      printing_ref: "b".repeat(48),
    };
    const snapshot = {
      title: "Boundary deck",
      published_at: "2026-01-02T03:04:05Z",
      version: 1,
      total: "3",
      identities: [{ name: "Pikachu", quantity: "3", editions: [edition] }],
      checks: {
        size_status: "short",
        shortage: "57",
        excess: "0",
        identities: [
          { name: "Pikachu", quantity: "3", status: "within_limit" },
        ],
      },
    };
    const projection = join(directory, "current.json");
    writeFileSync(
      projection,
      JSON.stringify({
        format: 1,
        revision: 0,
        decks: { [token]: { visibility: "unlisted", snapshot } },
      })
    );
    const children: ChildProcess[] = [];
    const environment = {
      ...process.env,
      DATABASE_URL: databaseUrl,
      PUBLIC_PROJECTION_DIR: directory,
      PUBLIC_PROJECTION_ADAPTER: "filesystem",
    };
    // A valid session from the live gateway: the isolated gateway must ignore it.
    await pool.query(
      "UPDATE auth_send_event SET sent_at = now() - interval '61 seconds'"
    );
    await post("/auth/request-code", { email });
    const signedIn = await post("/auth/verify-code", {
      email,
      code: latestCode(),
    });
    expect(signedIn.status).toBe(200);
    const valid = signedIn.headers.get("set-cookie")!.split(";")[0];
    try {
      children.push(
        spawn(
          ".venv/bin/uvicorn",
          [
            "app.main:app",
            "--app-dir",
            "api",
            "--host",
            "127.0.0.1",
            "--port",
            String(apiPort),
            "--no-access-log",
          ],
          { cwd: process.cwd(), env: environment, stdio: "ignore" }
        ),
        spawn("node", ["--import", "tsx", "auth/src/server.ts"], {
          cwd: process.cwd(),
          env: {
            ...environment,
            AUTH_PORT: String(gatewayPort),
            API_ORIGIN: `http://127.0.0.1:${apiPort}`,
          },
          stdio: "ignore",
        })
      );
      const gateway = `http://127.0.0.1:${gatewayPort}`;
      let ready = false;
      for (let attempt = 0; attempt < 100 && !ready; attempt++) {
        try {
          ready =
            (await fetch(gateway + "/api/public/discovery")).status === 200;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      expect(ready).toBe(true);
      const baseline = wakeups;
      const read = (cookie?: string, path = `/api/public/decks/${token}`) =>
        fetch(gateway + path, cookie ? { headers: { cookie } } : undefined);
      const bodies: string[] = [];
      for (const cookie of [
        undefined,
        "better-auth.session_token=forged",
        valid,
      ]) {
        const response = await read(cookie);
        expect(response.status).toBe(200);
        expect(response.headers.get("set-cookie")).toBeNull();
        expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
        bodies.push(await response.text());
      }
      expect(new Set(bodies).size).toBe(1);
      const shown = JSON.parse(bodies[0]);
      // Strict public allowlist, including the additive opaque references.
      expect(Object.keys(shown).sort()).toEqual([
        "checks",
        "identities",
        "published_at",
        "title",
        "total",
        "version",
      ]);
      expect(Object.keys(shown.identities[0].editions[0]).sort()).toEqual(
        Object.keys(edition).sort()
      );
      expect(shown.identities[0].editions[0]).toMatchObject({
        edition_ref: edition.edition_ref,
        printing_ref: edition.printing_ref,
      });
      expect(bodies[0]).not.toMatch(/owner|location_id|holding|session|email/i);
      for (const cookie of [
        undefined,
        "better-auth.session_token=forged",
        valid,
      ]) {
        expect(
          (await read(cookie, `/api/public/decks/${"B".repeat(32)}`)).status
        ).toBe(404);
      }
      // Durable storage loss is unavailable, never 404, and reads recover without a restart.
      renameSync(projection, projection + ".away");
      expect((await read(valid)).status).toBe(503);
      renameSync(projection + ".away", projection);
      expect((await read(valid)).status).toBe(200);
      expect(wakeups).toBe(baseline);
      // Control: a private route does wake the gateway database, so the counter is live.
      expect(
        (
          await fetch(gateway + "/api/locations", {
            headers: { cookie: "better-auth.session_token=forged" },
          })
        ).status
      ).toBeGreaterThanOrEqual(401);
      expect(wakeups).toBeGreaterThan(baseline);
    } finally {
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill();
          await new Promise((resolve) => child.once("exit", resolve));
        }
      }
      await new Promise((resolve) => database.close(resolve));
      rmSync(directory, { recursive: true, force: true });
      await post("/auth/sign-out", {}, valid);
    }
  });

  it("rejects missing origin and forged identity headers", async () => {
    const csrf = await fetch(base + "/auth/request-code", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });
    expect(csrf.status).toBe(403);
    const forged = await fetch(base + "/api/locations", {
      headers: {
        "x-internal-user": "other-owner",
        "x-internal-signature": "forged",
      },
    });
    expect(forged.status).toBe(401);
  });

  it("enforces durable email, trusted IP, and global send ceilings", async () => {
    const before = readFileSync(mailFile, "utf8").trim().split("\n").length;
    const source = await pool.query(
      "SELECT email_key, ip_key FROM auth_send_event LIMIT 1"
    );
    const { email_key, ip_key } = source.rows[0];
    await pool.query("DELETE FROM auth_send_event");
    await pool.query(
      "INSERT INTO auth_send_event(email_key,ip_key,sent_at) SELECT $1,$2,now()-interval '2 minutes' FROM generate_series(1,5)",
      [email_key, ip_key]
    );
    expect((await post("/auth/request-code", { email })).status).toBe(202);
    expect(readFileSync(mailFile, "utf8").trim().split("\n").length).toBe(
      before
    );
    await pool.query("DELETE FROM auth_send_event");
    await pool.query(
      "INSERT INTO auth_send_event(email_key,ip_key,sent_at) SELECT 'other-'||n,$1,now() FROM generate_series(1,20) n",
      [ip_key]
    );
    await post("/auth/request-code", { email });
    expect(readFileSync(mailFile, "utf8").trim().split("\n").length).toBe(
      before
    );
    await pool.query("DELETE FROM auth_send_event");
    await pool.query(
      "INSERT INTO auth_send_event(email_key,ip_key,sent_at) SELECT 'other-'||n,'ip-'||n,now() FROM generate_series(1,100) n"
    );
    await post("/auth/request-code", { email });
    expect(readFileSync(mailFile, "utf8").trim().split("\n").length).toBe(
      before
    );
  });

  it("fails closed when the auth database is unavailable", async () => {
    const child = spawn("node", ["--import", "tsx", "auth/src/server.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        AUTH_PORT: process.env.TEST_UNAVAILABLE_AUTH_PORT || "3002",
        DATABASE_URL: "postgresql://raian@127.0.0.1:1/unavailable",
      },
      stdio: "ignore",
    });
    try {
      let response: Response | undefined;
      for (let attempt = 0; attempt < 30; attempt++) {
        try {
          response = await fetch(
            `http://127.0.0.1:${process.env.TEST_UNAVAILABLE_AUTH_PORT || "3002"}/api/locations`,
            {
              headers: {
                cookie: "better-auth.session_token=forged",
                "x-internal-user": "victim",
              },
            }
          );
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      expect(response?.status).toBe(503);
      const publicDiscovery = await fetch(
        `http://127.0.0.1:${process.env.TEST_UNAVAILABLE_AUTH_PORT || "3002"}/api/public/discovery`,
        { headers: { cookie: "better-auth.session_token=forged" } }
      );
      expect(publicDiscovery.status).toBe(200);
      expect((await publicDiscovery.json()).decks).toBeInstanceOf(Array);
      const request = await fetch(
        `http://127.0.0.1:${process.env.TEST_UNAVAILABLE_AUTH_PORT || "3002"}/auth/request-code`,
        {
          method: "POST",
          headers: { origin, "content-type": "application/json" },
          body: JSON.stringify({ email }),
        }
      );
      expect(request.status).toBe(202);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        await new Promise((resolve) => child.once("exit", resolve));
      }
    }
  });
});
