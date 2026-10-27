import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launch, serverReady, waitUntil } from "./support/servers";

// The signed-out Invite Link page (social network #246): the gateway serves /api/public/invites/<token> from the
// public records store, under the public read limiter, with no session lookup, and nothing behind it wakes PostgreSQL.
describe("public invite page", () => {
  // slow (process): launches real API and auth server processes. The timeout covers serverReady's 30 s deadline.
  it(
    "answers the Display Name signed out, ignores cookies, limits callers and never wakes a database",
    { tags: ["slow"], timeout: 60_000 },
    async () => {
      // A counting listener stands in for PostgreSQL: every connection is a wakeup.
      let wakeups = 0;
      const counter: Server = createServer((socket) => {
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
      const directory = mkdtempSync(join(tmpdir(), "public-invite-"));
      const children: ChildProcess[] = [];
      const store = {
        PUBLIC_PROJECTION_DIR: directory,
        PUBLIC_PROJECTION_ADAPTER: "filesystem",
      };
      const token = "Inv1te_tokenAAAAAAAAAAAAAAAAAAAA";
      const unknown = "Unknown_tokenAAAAAAAAAAAAAAAAAAA";
      const hash = createHash("sha256").update(token).digest("hex");
      try {
        expect(token).toHaveLength(32);
        expect(unknown).toHaveLength(32);
        const init = spawnSync(
          ".venv/bin/python",
          ["scripts/init_public_records.py"],
          {
            cwd: process.cwd(),
            env: { ...process.env, ...store },
            encoding: "utf8",
          }
        );
        expect(init.status).toBe(0);
        // The record the profile drain writes (api/app/social/profile.py), written here without PostgreSQL.
        execFileSync(
          ".venv/bin/python",
          [
            "-c",
            `import time
from app.public_records import invite_key, public_record_store
store = public_record_store()
key = invite_key('${hash}')
found = store.read_records([key], deadline=time.monotonic() + 5).records
assert store.compare_and_swap({key: found[key].version}, {key: {'display_name': 'Misty'}}, deadline=time.monotonic() + 5)`,
          ],
          {
            cwd: process.cwd(),
            env: { ...process.env, ...store, PYTHONPATH: "api" },
            encoding: "utf8",
          }
        );

        const databasePort = await listen(counter);
        const apiPort = await freePort();
        const gatewayPort = await freePort();
        const isolated = {
          ...process.env,
          ...store,
          DATABASE_URL: `postgresql://nobody:nobody@127.0.0.1:${databasePort}/none`,
        };
        children.push(
          launch(
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
            isolated
          ),
          launch("node", ["--import", "tsx", "auth/src/server.ts"], {
            ...isolated,
            AUTH_PORT: String(gatewayPort),
            API_ORIGIN: `http://127.0.0.1:${apiPort}`,
          })
        );
        const gateway = `http://127.0.0.1:${gatewayPort}`;
        const page = (path: string, headers: Record<string, string> = {}) =>
          fetch(`${gateway}/api/public/invites/${path}`, { headers });
        // The gateway usually listens before the API does and answers 503 until it can reach it.
        await serverReady(
          children,
          `${gateway}/api/public/invites/${unknown}`,
          (response) => response.status === 404
        );
        const baseline = wakeups;

        const signedOut = await page(token);
        expect(signedOut.status).toBe(200);
        expect(signedOut.headers.get("cache-control")).toBe("no-store");
        expect(await signedOut.json()).toEqual({ display_name: "Misty" });
        // A cookie, real or forged, changes nothing: the gateway never looks a session up for a public path.
        const forged = await page(token, {
          cookie: "better-auth.session_token=forged.value",
        });
        expect(forged.status).toBe(200);
        expect(await forged.json()).toEqual({ display_name: "Misty" });
        const missing = await page(unknown);
        expect(missing.status).toBe(404);
        expect((await missing.json()).detail.code).toBe("INVITE_NOT_FOUND");
        // Only GET: any other method is refused before a session lookup or the limiter (HEAD skips the Origin check).
        const head = await fetch(`${gateway}/api/public/invites/${token}`, {
          method: "HEAD",
        });
        expect(head.status).toBe(405);

        // The public read limiter: 120 reads a minute from one caller, then 429 with Retry-After.
        let limited: Response | null = null;
        for (let read = 0; read < 125 && !limited; read++) {
          const response = await page(token);
          await response.body?.cancel();
          if (response.status === 429) limited = response;
          else expect(response.status).toBe(200);
        }
        expect(limited).not.toBeNull();
        expect(Number(limited!.headers.get("retry-after"))).toBeGreaterThan(0);

        expect(wakeups).toBe(baseline);
        // Control: a private route does wake the database, so the counter is live.
        await fetch(`http://127.0.0.1:${apiPort}/api/locations`);
        // The API counts the request in the background, after the response.
        expect(await waitUntil(() => wakeups > baseline)).toBe(true);
      } finally {
        for (const child of children) {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill();
            await new Promise((resolve) => child.once("exit", resolve));
          }
        }
        await new Promise((resolve) => counter.close(resolve));
        rmSync(directory, { recursive: true, force: true });
      }
    }
  );
});
