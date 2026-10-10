// Shared harness for auth/tests/price-runners.test.ts (ticket 08-C): one disposable PostgreSQL database, the record
// store behind the transactional HTTP relay, two uvicorn APIs with the real launcher, two gateways, a fake TCGdex HTTP
// server and a fake PostgreSQL port. Launched runners find the fake source through the CI fixture's origin file in this
// harness's private PRICE_RUNNER_LOCK_DIR, and register their pids there; every process count and every signal below is
// scoped to that registry, never to a host-wide process search.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  createServer as httpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createServer as netServer, type Server as NetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Pool } from "pg";

const run = promisify(execFile);
export const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));
export const hex = (bytes: number) => randomBytes(bytes).toString("hex");
export const SCHEDULER = "admission:price:scheduler";
export const LEASES = ["lease:price:runner:0", "lease:price:runner:1"];
export const SOURCE_BACKOFF = "backoff:price:source";
export const HOUR = 3_600_000;
const TOKEN = "conformance-secret";
const ORIGIN_FILE = "fixture-source-origin"; // price_fixture.ORIGIN_FILE
const PIDS_DIR = "runner-pids"; // price_fixture.PIDS_DIR
const CONNECTS = "connects.log"; // price_fixture.CONNECTS

/** Timing margins for the report: stderr, plus price-runners-metrics.log in TEST_LOG_DIR when the gate sets it. */
export function metric(line: string) {
  process.stderr.write(`[price-runners] ${line}\n`);
  if (process.env.TEST_LOG_DIR)
    appendFileSync(
      join(process.env.TEST_LOG_DIR, "price-runners-metrics.log"),
      `${new Date().toISOString()} ${line}\n`
    );
}

export async function waitFor<T>(
  probe: () => Promise<T | false | null | undefined> | T | false | null,
  what: string,
  limit = 10_000,
  step = 25
): Promise<T> {
  const end = performance.now() + limit;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (performance.now() > end)
      throw new Error("Timed out waiting for " + what);
    await sleep(step);
  }
}

const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = netServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });

// ---------------------------------------------------------------- the fake TCGdex
export type Behaviour =
  | { kind: "ok" } // the registered Editions' record (see Card)
  | { kind: "status"; code: number }
  | { kind: "malformed" }
  | { kind: "hang" } // never answers; the runner's 2 s deadline ends it
  | { kind: "hold" }; // answers ok only when release(card) is called
export type Entry = {
  descriptor: Record<string, unknown>;
  variant: string;
  productId: number;
  price: string | null; // raw JSON number text, or null for a matching block without a price
  updated: string;
};
export type Request = {
  card: string;
  slot: string | null;
  pid: number | null;
  pgid: number | null;
  at: number; // Date.now() on arrival
  end: number | null;
};

export class FakeSource {
  server: Server;
  origin = "";
  log: Request[] = [];
  records = new Map<string, Entry[]>();
  behaviour = new Map<string, Behaviour>();
  callers = new Map<string, string>(); // card -> caller, for the per-caller peak
  delayMs = 0;
  live = new Set<Request>();
  peak = {
    all: 0,
    slot: new Map<string, number>(),
    caller: new Map<string, number>(),
  };
  onArrive: ((request: Request) => void) | null = null;
  private held = new Map<string, Array<() => void>>();

  constructor() {
    this.server = httpServer((req, res) => this.handle(req, res));
  }
  async start() {
    await new Promise<void>((resolve) =>
      this.server.listen(0, "127.0.0.1", resolve)
    );
    this.origin = `http://127.0.0.1:${(this.server.address() as { port: number }).port}`;
  }
  get port() {
    return Number(new URL(this.origin).port);
  }
  requests(card: string) {
    return this.log.filter((request) => request.card === card);
  }
  resetPeaks() {
    this.peak = { all: 0, slot: new Map(), caller: new Map() };
  }
  release(card: string) {
    for (const go of this.held.get(card) ?? []) go();
    this.held.delete(card);
  }
  record(card: string): string {
    // marketPrice keeps its exact JSON text (the runner parses floats as text), so "2.50" stays "2.50".
    const entries = (this.records.get(card) ?? []).map((entry) => {
      const block = `{"unit":"USD","updated":${JSON.stringify(entry.updated)},${JSON.stringify(entry.variant)}:{"productId":${entry.productId},"marketPrice":${entry.price ?? "null"}}}`;
      const descriptor = JSON.stringify(entry.descriptor).slice(1, -1);
      return `{${descriptor}${descriptor ? "," : ""}"pricing":{"tcgplayer":${block}}}`;
    });
    return `{"id":${JSON.stringify(card)},"name":"Fixture","variants_detailed":[${entries.join(",")}]}`;
  }
  private count() {
    const live = [...this.live];
    this.peak.all = Math.max(this.peak.all, live.length);
    for (const request of live) {
      const slot = request.slot ?? "?";
      const inSlot = live.filter((r) => (r.slot ?? "?") === slot).length;
      this.peak.slot.set(slot, Math.max(this.peak.slot.get(slot) ?? 0, inSlot));
      const caller = this.callers.get(request.card);
      if (caller) {
        const mine = live.filter(
          (r) => this.callers.get(r.card) === caller
        ).length;
        this.peak.caller.set(
          caller,
          Math.max(this.peak.caller.get(caller) ?? 0, mine)
        );
      }
    }
  }
  private handle(req: IncomingMessage, res: ServerResponse) {
    const match = /^\/v2\/en\/cards\/([^/?]+)$/.exec(req.url ?? "");
    const number = (name: string) => {
      const value = req.headers[name];
      return typeof value === "string" && /^\d+$/.test(value)
        ? Number(value)
        : null;
    };
    const request: Request = {
      card: match ? decodeURIComponent(match[1]) : (req.url ?? ""),
      slot: (req.headers["x-fixture-slot"] as string) ?? null,
      pid: number("x-fixture-pid"),
      pgid: number("x-fixture-pgid"),
      at: Date.now(),
      end: null,
    };
    this.log.push(request);
    this.live.add(request);
    this.count();
    const done = () => {
      if (request.end === null) request.end = Date.now();
      this.live.delete(request);
    };
    res.on("close", done);
    this.onArrive?.(request);
    const behaviour = this.behaviour.get(request.card) ?? { kind: "ok" };
    const answer = () => {
      if (res.destroyed || res.writableEnded) return;
      done();
      if (behaviour.kind === "status") {
        res.writeHead(behaviour.code, { "content-type": "application/json" });
        res.end("{}");
      } else if (behaviour.kind === "malformed") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"id": "truncated');
      } else {
        const body = this.record(request.card);
        res.writeHead(200, {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        });
        res.end(body);
      }
    };
    if (behaviour.kind === "hang") return;
    if (behaviour.kind === "hold") {
      const list = this.held.get(request.card) ?? [];
      list.push(answer);
      this.held.set(request.card, list);
      return;
    }
    if (this.delayMs) setTimeout(answer, this.delayMs);
    else answer();
  }
  async close() {
    this.server.closeAllConnections();
    await new Promise((resolve) => this.server.close(resolve));
  }
}

// ---------------------------------------------------------------- scoped runner processes
export type Runner = { pid: number; role: "supervisor" | "worker" };

export class Runners {
  constructor(readonly lockDir: string) {}

  /** Every pid the fixture registered in this harness's lock directory (any state). */
  registered(): Runner[] {
    const directory = join(this.lockDir, PIDS_DIR);
    if (!existsSync(directory)) return [];
    return readdirSync(directory)
      .filter((name) => /^\d+$/.test(name))
      .map((name) => ({
        pid: Number(name),
        role: readFileSync(join(directory, name), "utf8").trim() as
          "supervisor" | "worker",
      }));
  }

  /** Registered runners that are alive (stopped counts as alive; zombies do not), checked by pid only. */
  async live(): Promise<Runner[]> {
    const known = this.registered();
    if (!known.length) return [];
    let out = "";
    try {
      out = (
        await run("ps", [
          "-o",
          "pid=,stat=,args=",
          "-p",
          known.map((r) => r.pid).join(","),
        ])
      ).stdout;
    } catch (error: any) {
      out = error?.stdout ?? ""; // ps exits 1 when none of the pids exist
    }
    const alive = new Set<number>();
    for (const line of out.split("\n")) {
      const found = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line);
      if (
        found &&
        !found[2].startsWith("Z") &&
        found[3].includes("app.price_runner")
      )
        alive.add(Number(found[1]));
    }
    return known.filter((runner) => alive.has(runner.pid));
  }

  async counts() {
    const live = await this.live();
    return {
      supervisors: live.filter((r) => r.role === "supervisor").length,
      workers: live.filter((r) => r.role === "worker").length,
      live,
    };
  }

  /** Samples the live counts every 50 ms until stopped; returns the peaks and every sample. */
  watch() {
    const samples: Array<{ supervisors: number; workers: number }> = [];
    let stopped = false;
    const loop = (async () => {
      while (!stopped) {
        const { supervisors, workers } = await this.counts();
        samples.push({ supervisors, workers });
        await sleep(50);
      }
    })();
    return async () => {
      stopped = true;
      await loop;
      return {
        samples,
        supervisors: Math.max(0, ...samples.map((s) => s.supervisors)),
        workers: Math.max(0, ...samples.map((s) => s.workers)),
      };
    };
  }

  isSupervisor(pid: number | null) {
    return (
      pid !== null &&
      this.registered().some((r) => r.pid === pid && r.role === "supervisor")
    );
  }
  isWorker(pid: number | null) {
    return (
      pid !== null &&
      this.registered().some((r) => r.pid === pid && r.role === "worker")
    );
  }

  /** Signals a runner's whole process group, only if the group leader is one of ours. */
  signalGroup(pgid: number | null, signal: NodeJS.Signals) {
    if (!this.isSupervisor(pgid))
      throw new Error(
        `process group ${pgid} is not a runner this test launched`
      );
    process.kill(-pgid!, signal);
  }

  /** Teardown: continue and kill every registered runner that is still alive. */
  async killAll() {
    for (const runner of await this.live()) {
      for (const signal of ["SIGCONT", "SIGKILL"] as const) {
        try {
          process.kill(runner.pid, signal);
        } catch {
          /* already gone */
        }
      }
    }
    await waitFor(
      async () => (await this.live()).length === 0,
      "the runners to exit",
      5_000
    );
  }

  connects(): Array<{ pid: number; address: unknown }> {
    const path = join(this.lockDir, CONNECTS);
    return existsSync(path)
      ? readFileSync(path, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  }
}

// ---------------------------------------------------------------- the stack
export type Edition = {
  id: string;
  ref: string;
  card: string;
  revision: number;
  variant: string;
  productId: number;
};
export type Price = {
  edition_id: string;
  status: string;
  reason: string | null;
  amount: string | null;
  checked_at: string | null;
  provider_updated_at: string | null;
  refresh: string | null;
  refresh_failed_at: string | null;
};
type Row = { version: string; value: any };

export class Stack {
  admin = new Pool({ connectionString: process.env.DATABASE_URL });
  database = "tcg_price_runners_" + randomUUID().replaceAll("-", "");
  directory = mkdtempSync(join(tmpdir(), "tcg-price-runners-"));
  lockDir = join(this.directory, "locks");
  origin = process.env.TEST_ORIGIN || "http://localhost:5173";
  ownerEmail = "owner@example.test";
  pool!: Pool;
  relayUrl = "";
  gateways: string[] = [];
  apis: string[] = [];
  children: ChildProcess[] = [];
  source = new FakeSource();
  runners = new Runners(this.lockDir);
  fakePg!: NetServer;
  fakePgPort = 0;
  fakePgConnections = 0;
  users: Array<{ id: string; cookie: string; caller: string }> = [];
  activation = "";
  base: NodeJS.ProcessEnv = {};
  private sequence = 0;

  async start() {
    await this.admin.query(`CREATE DATABASE "${this.database}"`);
    const connection = new URL(process.env.DATABASE_URL!);
    connection.pathname = "/" + this.database;
    this.pool = new Pool({ connectionString: connection.toString() });
    const inherited = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) =>
          !key.startsWith("PRICE_FIXTURE_") &&
          !key.startsWith("PUBLIC_PROJECTION_") &&
          key !== "PRICE_RUNNER_LOCK_DIR" &&
          key !== "CATALOG_PROCESS_FIXTURE_DIR"
      )
    );
    this.base = {
      ...inherited,
      DATABASE_URL: connection.toString(),
      MAIL_MODE: "file",
      MAIL_FILE: join(this.directory, "mail"),
      SIGNUP_MODE: "local-public",
      NODE_ENV: "test",
      OWNER_EMAIL: this.ownerEmail,
      PUBLIC_ORIGIN: this.origin,
    };
    await this.python(["scripts/migrate.py"], {});

    // A fake PostgreSQL port: it only counts connections.
    this.fakePg = netServer((socket) => {
      this.fakePgConnections++;
      socket.destroy();
    });
    await new Promise<void>((resolve) =>
      this.fakePg.listen(0, "127.0.0.1", resolve)
    );
    this.fakePgPort = (this.fakePg.address() as { port: number }).port;

    // The relay: the record store every API and every runner shares. Its port arrives on stdout.
    mkdirSync(join(this.directory, "store"), { recursive: true });
    const relay = spawn(
      ".venv/bin/python",
      [
        "-c",
        `import sys
from public_records_fixture import serve_relay
class Out:
    def send(self, port): print(port, flush=True)
    def close(self): pass
serve_relay({'adapter': 'http', 'directory': sys.argv[1]}, Out())`,
        join(this.directory, "store"),
      ],
      {
        env: { ...this.base, PYTHONPATH: "api:api/tests" },
        stdio: ["ignore", "pipe", "ignore"],
      }
    );
    this.children.push(relay);
    const port = await new Promise<number>((resolve, reject) => {
      relay.stdout!.once("data", (chunk) =>
        resolve(Number(String(chunk).trim()))
      );
      relay.once("exit", () => reject(new Error("relay exited")));
    });
    this.relayUrl = `http://127.0.0.1:${port}`;
    await this.relay("initialize", {});

    await this.source.start();
    mkdirSync(this.lockDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(this.lockDir, ORIGIN_FILE), this.source.origin);

    const fake = `postgresql://tcg:tcg@127.0.0.1:${this.fakePgPort}/tcg`;
    const apiEnv = {
      ...this.store(),
      PYTHONPATH:
        join(process.cwd(), "api/tests/catalog_process_fixture") +
        ":" +
        join(process.cwd(), "api"),
      PRICE_RUNNER_LOCK_DIR: this.lockDir,
      // Everything PostgreSQL-shaped a runner could inherit points at the fake port. The launcher's allowlist passes
      // PUBLIC_PROJECTION_* on, so this decoy is visible to every runner; PGHOST/PGPORT must be dropped by the allowlist.
      PUBLIC_PROJECTION_DATABASE_URL: fake,
      PGHOST: "127.0.0.1",
      PGPORT: String(this.fakePgPort),
    };
    for (let index = 0; index < 2; index++) {
      const apiPort = await freePort();
      const gatewayPort = await freePort();
      this.spawn(
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
        apiEnv
      );
      this.spawn("node", ["--import", "tsx", "auth/src/server.ts"], {
        ...this.base,
        AUTH_PORT: String(gatewayPort),
        API_ORIGIN: `http://127.0.0.1:${apiPort}`,
      });
      this.apis.push(`http://127.0.0.1:${apiPort}`);
      this.gateways.push(`http://127.0.0.1:${gatewayPort}`);
    }
    for (const [index, url] of this.apis.entries())
      await waitFor(
        async () => {
          try {
            return (
              (await fetch(url + "/api/health")).ok &&
              (await fetch(this.gateways[index] + "/auth/session")).ok
            );
          } catch {
            return false;
          }
        },
        "a gateway and its API",
        30_000,
        100
      );
  }

  /** The record-store settings for the HTTP relay (APIs, the drain, and through the allowlist, every runner). */
  store() {
    return {
      ...this.base,
      PUBLIC_PROJECTION_ADAPTER: "http",
      PUBLIC_PROJECTION_URL: this.relayUrl,
      PUBLIC_PROJECTION_TOKEN: TOKEN,
    };
  }

  spawn(command: string, args: string[], env: NodeJS.ProcessEnv) {
    const child = spawn(command, args, { env, stdio: "ignore" });
    this.children.push(child);
    return child;
  }

  async python(args: string[], env: NodeJS.ProcessEnv) {
    await run(".venv/bin/python", args, {
      env: { ...this.base, ...env },
      maxBuffer: 16 * 1024 * 1024,
    });
  }

  /** Signs up (local-public) and signs in one user per address; the first is the owner, who reviews rule activations. */
  async signIn(emails: string[]) {
    for (const email of emails) {
      await this.pool.query("DELETE FROM auth_send_event");
      const post = (path: string, body: object) =>
        fetch(this.gateways[0] + path, {
          method: "POST",
          headers: { origin: this.origin, "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      const sent = await post("/auth/request-code", { email });
      if (sent.status !== 202) throw new Error("request-code " + sent.status);
      const code = JSON.parse(
        readFileSync(join(this.directory, "mail"), "utf8")
          .trim()
          .split("\n")
          .at(-1)!
      ).otp;
      const signin = await post("/auth/verify-code", { email, code });
      if (signin.status !== 200)
        throw new Error("verify-code " + signin.status);
      const id = (
        await this.pool.query('SELECT id FROM "user" WHERE email=$1', [email])
      ).rows[0].id;
      this.users.push({
        id,
        cookie: signin.headers.get("set-cookie")!.split(";")[0],
        caller: `user:${id}`,
      });
    }
    const owner = this.users[0].id;
    await this.pool.query(
      "INSERT INTO owner_binding(singleton,user_id) VALUES (true,$1) ON CONFLICT DO NOTHING",
      [owner]
    );
    this.activation = (
      await this.pool.query(
        `INSERT INTO catalog_rule_activation(kind,reviewer_id,evidence_url,reason,clock_revision)
         VALUES ('marketplace_matching',$1,'https://example.org/rule','Fixture activation',1) RETURNING id`,
        [owner]
      )
    ).rows[0].id;
  }

  // ---------------------------------------------------------------- the record store, over the relay
  async relay(action: string, body: object) {
    const response = await fetch(`${this.relayUrl}/records/${action}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ ...body, timeout_ms: 5_000 }),
    });
    if (response.status !== 200)
      throw new Error(`relay ${action} answered ${response.status}`);
    return response.json();
  }
  async read(keys: string[]): Promise<Record<string, Row>> {
    return (await this.relay("read", { keys, generation: null })).records;
  }
  async get(key: string) {
    return (await this.read([key]))[key].value;
  }
  async cas(
    keys: string[],
    change: (rows: Record<string, Row>) => Record<string, unknown>
  ) {
    for (let attempt = 0; attempt < 20; attempt++) {
      const rows = await this.read(keys);
      const changes = change(rows);
      const expected = Object.fromEntries(
        Object.keys(changes).map((key) => [key, rows[key].version])
      );
      const done = await this.relay("transact", {
        expected,
        changes,
        operation_id: "test-" + hex(8),
      });
      if (done.committed) return;
    }
    throw new Error("could not commit to the record store");
  }

  /** Waits until no runner of ours is alive and no lease is held, then clears the scheduler, leases and source backoff. */
  async quiesce() {
    await waitFor(
      async () => (await this.runners.live()).length === 0,
      "our runners to exit",
      15_000,
      50
    );
    await waitFor(
      async () => {
        const rows = await this.read(LEASES);
        return LEASES.every((key) => rows[key].value === null);
      },
      "both runner slots to be free",
      5_000
    );
    await this.cas([SCHEDULER, ...LEASES, SOURCE_BACKOFF], () => ({
      [SCHEDULER]: null,
      [LEASES[0]]: null,
      [LEASES[1]]: null,
      [SOURCE_BACKOFF]: null,
    }));
    this.source.onArrive = null;
    this.source.delayMs = 0;
  }

  // ---------------------------------------------------------------- Editions
  /**
   * One Printing per card with one verified Edition per finish (`normal`, then `reverse-holofoil`), delivered to the
   * record store through the public catalog outbox so the runner's eligibility check finds them. The fake source
   * learns each Edition's TCGdex entry.
   */
  async cards(
    count: number,
    finishes = 1,
    price = "1.25"
  ): Promise<Edition[][]> {
    const made: Edition[][] = [];
    const variants = ["normal", "reverse-holofoil"];
    for (let n = 0; n < count; n++) {
      this.sequence++;
      const card = `rn-${hex(3)}-${this.sequence}`;
      const productId = 700_000 + this.sequence;
      const identity = (
        await this.pool.query(
          "INSERT INTO catalog_identity(identity_key,display_name) VALUES ($1,$2) RETURNING id",
          [`price-runners-${card}`, `Runner Card ${this.sequence}`]
        )
      ).rows[0].id;
      const printing = (
        await this.pool.query(
          "INSERT INTO catalog_printing(source,source_id,identity_id) VALUES ('tcgdex',$1,$2) RETURNING id",
          [card, identity]
        )
      ).rows[0].id;
      const group: Edition[] = [];
      for (const variant of variants.slice(0, finishes)) {
        const descriptor = { finish: variant };
        const edition = (
          await this.pool.query(
            `INSERT INTO catalog_edition(printing_id,descriptor_key,descriptor) VALUES ($1,$2,$3) RETURNING id,public_ref`,
            [printing, variant, JSON.stringify(descriptor)]
          )
        ).rows[0];
        const revision = (
          await this.pool.query(
            `UPDATE catalog_edition_metadata SET mapping_state='verified',mapping_reason=NULL,product_id=$2,quote_variant=$4,
             mapping_basis='matching_rule',matching_activation_id=$3,auto_closed=true WHERE edition_id=$1 RETURNING mapping_revision`,
            [edition.id, productId, this.activation, variant]
          )
        ).rows[0].mapping_revision;
        group.push({
          id: edition.id,
          ref: edition.public_ref,
          card,
          revision: Number(revision),
          variant,
          productId,
        });
      }
      this.source.records.set(
        card,
        group.map((e) => ({
          descriptor: { finish: e.variant },
          variant: e.variant,
          productId,
          price,
          updated: "2026-10-01T00:00:00Z",
        }))
      );
      made.push(group);
    }
    await this.python(["-m", "app.catalog_import", "--drain"], {
      ...this.store(),
      PYTHONPATH: "api",
    });
    const keys = made.flat().map((e) => `catalog:edition:${e.ref}`);
    const rows = await this.read(keys);
    for (const key of keys)
      if (rows[key].value?.marketplace?.state !== "verified")
        throw new Error(`${key} was not delivered to the record store`);
    return made;
  }

  async prices(replica: number, ids: string[], user = 0) {
    const started = performance.now();
    const response = await fetch(
      this.gateways[replica] + "/api/prices/editions",
      {
        method: "POST",
        headers: {
          origin: this.origin,
          "content-type": "application/json",
          cookie: this.users[user].cookie,
        },
        body: JSON.stringify({ edition_ids: ids }),
      }
    );
    const body = await response.json();
    const elapsed = performance.now() - started;
    const rows: Record<string, Price> = {};
    for (const row of body.prices ?? []) rows[row.edition_id] = row;
    return { status: response.status, elapsed, rows };
  }

  /** Seeds what an earlier refresh wrote: a quote checked `ageMs` ago, with the provider's own time. */
  async seedQuote(
    edition: Edition,
    amount: string,
    ageMs: number,
    updated: string
  ) {
    const keys = [
      keyOf("result", edition),
      keyOf("quote", edition),
      keyOf("fence", edition),
    ];
    await this.cas(keys, () => ({
      [keys[2]]: { v: 1, attempt: 1 }, // the fence that earlier write held
      [keys[0]]: {
        state: "quote",
        attempt: 1,
        checked_at: new Date(
          Math.floor((Date.now() - ageMs) / 1000) * 1000
        ).toISOString(),
      },
      [keys[1]]: {
        attempt: 1,
        amount,
        currency: "USD",
        source: "tcgdex",
        card: edition.card,
        variant: edition.variant,
        provider_updated_at: updated,
      },
    }));
  }

  /** What a runner that stopped renewing looks like once its 10 s lease has passed (no clock is faked). */
  async expireLease(slot: number) {
    await this.cas([LEASES[slot]], (rows) => ({
      [LEASES[slot]]: {
        ...rows[LEASES[slot]].value,
        lease_until_ms: Date.now() - 1,
      },
    }));
  }

  /** Makes every launch fail for real: the lock directory becomes a plain file, so `spawn` cannot open a lock. */
  breakLaunches() {
    renameSync(this.lockDir, this.lockDir + ".away");
    writeFileSync(this.lockDir, "not a directory");
  }
  repairLaunches() {
    rmSync(this.lockDir, { force: true });
    renameSync(this.lockDir + ".away", this.lockDir);
  }

  async stop() {
    try {
      if (existsSync(this.lockDir + ".away")) this.repairLaunches();
      await this.runners.killAll();
    } finally {
      for (const child of this.children) {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill();
          await new Promise((resolve) => child.once("exit", resolve));
        }
      }
      await this.source.close();
      await new Promise((resolve) => this.fakePg?.close(resolve));
      await this.pool?.end();
      for (let n = 0; n < 50; n++) {
        const { rows } = await this.admin.query(
          "SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=$1",
          [this.database]
        );
        if (rows[0].count === 0) break;
        await sleep(100);
      }
      await this.admin.query(
        `DROP DATABASE IF EXISTS "${this.database}" WITH (FORCE)`
      );
      await this.admin.end();
      rmSync(this.directory, { recursive: true, force: true });
    }
  }
}

export const keyOf = (
  kind: "result" | "quote" | "work" | "fence",
  edition: Edition
) => `${kind}:${edition.ref}:${edition.revision}`;
export const backoffKey = (edition: Edition) =>
  `backoff:price:edition:${edition.ref}:${edition.revision}`;
