// TEST ONLY. The spec-level stack for web/tests/riftbound-connected.spec.ts: a disposable migrated Riftbound database,
// the Riftbound backend (app.riftbound_main), a signing relay, the real gateway and a dedicated vite.
//
// The relay stands in for the gateway-to-backend identity hop, which is undecided (#531): the gateway forwards no
// x-internal-* header today, so every real Catalog read is a 401. The relay signs one fixed synthetic principal with a
// secret generated per run (held in memory only) and refuses any request that already carries identity. It proves
// Catalog reads for that one principal; identity propagation and per-user authorization are not proven here.
//
// Diagnostics name only the phase and the process, never a URL, environment, cookie, header or child output.
import { execFileSync, type ChildProcess } from "node:child_process";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { canonicalDsn, DsnRejected } from "./riftbound-dsn";
import {
  dropDatabase,
  launch,
  waitForServer,
} from "../../../auth/tests/support/servers";
import {
  freePort,
  PLACEHOLDER_CREDENTIALS,
} from "../../../auth/tests/support/oauth-gateway";

export type RelayMode = "sign" | "unsigned";
export type UpstreamCall = { method: string; path: string; status: number };
export type RiftboundStack = {
  origin: string;
  entry: string;
  databaseUrl: string;
  /** The validated DSN of the database the gateway signs in against (the stack's own, not a raw DATABASE_URL). */
  authDatabaseUrl: string;
  relay: {
    mode: RelayMode;
    calls: number;
    identityHeadersSeen: number;
    upstream: UpstreamCall[];
  };
  seed(name: "empty" | "unaccepted" | "populated"): Record<string, string[]>;
  sql(statement: string): Promise<void>;
  stop(): Promise<void>;
};

const PRINCIPAL = "riftbound-local-proof";

class StackError extends Error {}
class TeardownError extends StackError {}
const fail = (phase: string, what: string) =>
  new StackError(`Riftbound stack: ${phase} failed (${what})`);

/** Only the named variables, so a child never sees another service's secrets. */
function only(
  keys: string[],
  extra: Record<string, string>
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of keys)
    if (process.env[key] !== undefined) env[key] = process.env[key];
  return { ...env, ...extra };
}
const BASE_KEYS = ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR"];
// What the gateway reads and nothing else (auth/src/server.ts, auth.ts): its own secrets and owner, never Riftbound's.
const GATEWAY_KEYS = [
  ...BASE_KEYS,
  "OWNER_EMAIL",
  "INTERNAL_AUTH_SECRET",
  "BETTER_AUTH_SECRET",
  "SIGNUP_MODE",
];

function exited(child: ChildProcess) {
  return child.exitCode !== null || child.signalCode !== null;
}

/** Stops a child and says so when it will not go: a SIGKILLed child that is still there after 3 s is a leak. */
async function terminate(child: ChildProcess) {
  if (exited(child) || child.pid === undefined) return; // never spawned: the start-up phase already reported it
  const gone = new Promise<void>((resolve) =>
    child.once("exit", () => resolve())
  );
  const within = (ms: number) =>
    Promise.race([
      gone.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
    ]);
  child.kill("SIGTERM");
  if (await within(5_000)) return;
  child.kill("SIGKILL");
  if (!(await within(3_000))) throw new Error("did not exit");
}

/** A child whose spawn failure is reported by its phase (the child exits at once), never as an unhandled 'error'. */
function started(child: ChildProcess): ChildProcess {
  child.on("error", () => undefined);
  return child;
}

type Cleanup = [name: string, run: () => Promise<void>];
/** Attempts every action, last first, and names the ones that failed. */
async function runAll(actions: Cleanup[]): Promise<string[]> {
  const failed: string[] = [];
  for (const [name, run] of [...actions].reverse()) {
    try {
      await run();
    } catch {
      failed.push(name);
    }
  }
  return failed;
}

export async function startRiftboundStack(): Promise<RiftboundStack> {
  const cleanups: Cleanup[] = [];
  const defer = (name: string, fn: () => Promise<void>) =>
    void cleanups.push([name, fn]);
  let cleaned = false;
  // Runs every cleanup action once, then fails naming the phases that did not clean up (never why or with what).
  const cleanUp = async () => {
    if (cleaned) return;
    cleaned = true;
    const failed = await runAll(cleanups);
    if (failed.length)
      throw new TeardownError(
        `Riftbound stack: teardown failed (${failed.join(", ")})`
      );
  };
  try {
    const adminUrl = process.env.DATABASE_URL;
    if (!adminUrl) throw fail("database", "no stack database configured");
    let adminDsn: string;
    try {
      adminDsn = canonicalDsn(adminUrl); // loopback, no query: nothing in it can retarget the connection
    } catch (error) {
      if (error instanceof DsnRejected) throw fail("database", error.message);
      throw fail("database", "unreadable address");
    }
    const adminPool = new Pool({ connectionString: adminDsn });
    defer("admin pool", () => adminPool.end());
    const name = "tcg_rb_" + randomUUID().replaceAll("-", "");
    try {
      await adminPool.query(`CREATE DATABASE "${name}"`);
    } catch (error) {
      if ((error as { code?: string }).code === "42501")
        throw new StackError(
          "Riftbound stack: the stack's database role cannot CREATE DATABASE"
        );
      throw fail("database", "CREATE DATABASE");
    }
    defer("DROP DATABASE", () => dropDatabase(adminPool, name));
    const databaseUrl = canonicalDsn(adminUrl, name);
    const directory = mkdtempSync(join(tmpdir(), "tcg-rb-"));
    defer("temp directory", async () =>
      rmSync(directory, { recursive: true, force: true })
    );

    try {
      execFileSync(".venv/bin/python", ["scripts/migrate_riftbound.py"], {
        env: only(BASE_KEYS, {
          RIFTBOUND_DATABASE_URL: databaseUrl,
          DATABASE_URL: "postgresql://unused.invalid/pokemon",
        }),
        stdio: "ignore",
      });
    } catch {
      throw fail("migration", "migrate_riftbound.py");
    }

    const secret = randomBytes(32).toString("hex");

    const ready = async (
      phase: string,
      children: ChildProcess[],
      url: string
    ) => {
      let response: Response | undefined;
      try {
        response = await waitForServer(children, url, (r) => r.ok);
      } catch {
        throw fail(phase, "process exited before it answered");
      }
      if (!response) throw fail(phase, "no answer within 30 s");
      await response.body?.cancel();
    };

    // Backend.
    const apiPort = await freePort();
    const backend = started(
      launch(
        ".venv/bin/uvicorn",
        [
          "app.riftbound_main:app",
          "--app-dir",
          "api",
          "--host",
          "127.0.0.1",
          "--port",
          String(apiPort),
          "--no-access-log",
        ],
        only(BASE_KEYS, {
          RIFTBOUND_DATABASE_URL: databaseUrl,
          RIFTBOUND_INTERNAL_AUTH_SECRET: secret,
        })
      )
    );
    defer("backend process", () => terminate(backend));
    await ready("backend", [backend], `http://127.0.0.1:${apiPort}/api/health`);

    // Relay.
    const relay: RiftboundStack["relay"] = {
      mode: "sign",
      calls: 0,
      identityHeadersSeen: 0,
      upstream: [],
    };
    const relayServer: Server = createServer(async (req, res) => {
      relay.calls += 1;
      const reply = (status: number, type: string, bytes: Buffer | string) => {
        res.writeHead(status, { "content-type": type });
        res.end(bytes);
      };
      try {
        if (Object.keys(req.headers).some((h) => h.startsWith("x-internal-"))) {
          relay.identityHeadersSeen += 1;
          return reply(
            500,
            "application/json",
            '{"error":"relay received identity"}'
          );
        }
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const body = Buffer.concat(chunks);
        const method = req.method ?? "GET";
        const target = req.url ?? "/";
        const headers: Record<string, string> = {
          "accept-encoding": "identity",
        };
        if (req.headers.accept) headers.accept = String(req.headers.accept);
        if (relay.mode === "sign") {
          const pathname = new URL(target, "http://relay").pathname;
          let decoded = pathname;
          try {
            decoded = decodeURIComponent(pathname);
          } catch {
            /* the backend would see the raw path */
          }
          const stamp = String(Math.floor(Date.now() / 1000));
          const digest = createHash("sha256").update(body).digest("hex");
          headers["x-internal-user"] = PRINCIPAL;
          headers["x-internal-time"] = stamp;
          headers["x-internal-signature"] = createHmac("sha256", secret)
            .update(`${method}\n${decoded}\n${digest}\n${PRINCIPAL}\n${stamp}`)
            .digest("hex");
        }
        const noBody = method === "GET" || method === "HEAD";
        const upstream = await fetch(`http://127.0.0.1:${apiPort}${target}`, {
          method,
          headers,
          ...(noBody ? {} : { body }),
        });
        relay.upstream.push({
          method,
          path: new URL(target, "http://relay").pathname,
          status: upstream.status,
        });
        reply(
          upstream.status,
          upstream.headers.get("content-type") ?? "application/octet-stream",
          Buffer.from(await upstream.arrayBuffer())
        );
      } catch {
        if (!res.headersSent)
          reply(502, "application/json", '{"error":"relay failed"}');
        else res.end();
      }
    });
    const relayPort = await freePort();
    await new Promise<void>((resolve, reject) => {
      relayServer.once("error", reject);
      relayServer.listen(relayPort, "127.0.0.1", resolve);
    }).catch(() => {
      throw fail("relay", "listen");
    });
    defer(
      "relay server",
      () =>
        new Promise<void>((resolve, reject) => {
          relayServer.closeAllConnections();
          relayServer.close((error) => (error ? reject(error) : resolve()));
        })
    );

    // Gateway and vite, restarted together with new ports once if either loses a port race.
    const gatewayEnvBase = {
      ...only(GATEWAY_KEYS, {}),
      ...PLACEHOLDER_CREDENTIALS,
      DATABASE_URL: adminDsn,
      AUTH_HOST: "127.0.0.1",
    };
    const front = async () => {
      const mine: Cleanup[] = [];
      try {
        const authPort = await freePort();
        const webPort = await freePort();
        const origin = `http://localhost:${webPort}`;
        const gateway = started(
          launch(
            "node",
            [
              "--import",
              "tsx",
              "--import",
              "./auth/testing/oauth-fake/preload.ts",
              "auth/src/server.ts",
            ],
            {
              ...gatewayEnvBase,
              AUTH_PORT: String(authPort),
              PUBLIC_ORIGIN: origin,
              TEST_ORIGIN: origin,
              REVIEW_BROWSER_ORIGIN: origin,
              RIFTBOUND_API_ORIGIN: `http://127.0.0.1:${relayPort}`,
              EMAIL_SIGN_IN: "off",
            }
          )
        );
        mine.push(["gateway process", () => terminate(gateway)]);
        await ready(
          "gateway",
          [gateway],
          `http://127.0.0.1:${authPort}/auth/session`
        );
        const cache = mkdtempSync(join(tmpdir(), "tcg-rb-vite-"));
        mine.push([
          "vite cache",
          async () => rmSync(cache, { recursive: true, force: true }),
        ]);
        const vite = started(
          launch(
            "node",
            [
              "node_modules/vite/bin/vite.js",
              "--config",
              "web/vite.config.ts",
              "--strictPort",
            ],
            only(BASE_KEYS, {
              WEB_PORT: String(webPort),
              AUTH_PORT: String(authPort),
              VITE_CACHE_DIR: join(cache, "vite-cache"),
            })
          )
        );
        mine.push(["vite process", () => terminate(vite)]);
        const entry = `${origin}/src/games/riftbound/connected/index.html`;
        await ready("vite", [vite], entry);
        await ready(
          "vite",
          [vite],
          `${origin}/src/games/riftbound/connected/main.tsx`
        );
        return { origin, entry, stops: mine };
      } catch (error) {
        const failed = await runAll(mine);
        if (failed.length)
          throw new TeardownError(
            `${error instanceof StackError ? error.message : "Riftbound stack: start-up failed"}; Riftbound stack: teardown failed (${failed.join(", ")})`
          );
        throw error;
      }
    };
    let up: Awaited<ReturnType<typeof front>>;
    try {
      up = await front();
    } catch (error) {
      if (error instanceof TeardownError) throw error; // a leftover child is not retried over
      up = await front();
    }
    for (const [name, stop] of up.stops) defer(name, stop);

    const run = (args: string[], what: string) => {
      try {
        return execFileSync(".venv/bin/python", args, {
          env: only(BASE_KEYS, {
            PYTHONPATH: "api:api/tests",
            RIFTBOUND_DATABASE_URL: databaseUrl,
          }),
          stdio: ["ignore", "pipe", "ignore"],
        }).toString();
      } catch {
        throw fail("seed", what);
      }
    };

    return {
      origin: up.origin,
      entry: up.entry,
      databaseUrl,
      authDatabaseUrl: adminDsn,
      relay,
      seed: (scenario) =>
        JSON.parse(
          run(
            [
              "api/tests/riftbound_catalog_seed.py",
              scenario,
              "--database",
              name,
            ],
            scenario
          )
        ).editions,
      sql: async (statement) => {
        const pool = new Pool({ connectionString: databaseUrl });
        try {
          await pool.query(statement);
        } finally {
          await pool.end();
        }
      },
      stop: cleanUp,
    };
  } catch (error) {
    try {
      await cleanUp();
    } catch (teardown) {
      const first =
        error instanceof StackError ? error.message : "Riftbound stack failed";
      throw new StackError(`${first}; ${(teardown as Error).message}`);
    }
    throw error;
  }
}
