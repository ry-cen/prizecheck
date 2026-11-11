// Shared harness for auth/tests/deck-cost.test.ts: one disposable PostgreSQL database, the record store behind the
// transactional HTTP relay, and two uvicorn APIs behind two gateways. Prices come from PostgreSQL (ADR 0019).
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer as netServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Pool } from "pg";
import { dropDatabase } from "./support/servers";

const run = promisify(execFile);
const TOKEN = "conformance-secret";

export const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));
export const hex = (bytes: number) => randomBytes(bytes).toString("hex");
export const HOUR = 3_600_000;

/** Timing margins for the report: stderr, plus price-stack-metrics.log in TEST_LOG_DIR when the gate sets it. */
export function metric(line: string) {
  process.stderr.write(`[price-stack] ${line}\n`);
  if (process.env.TEST_LOG_DIR)
    appendFileSync(
      join(process.env.TEST_LOG_DIR, "price-stack-metrics.log"),
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
};

export class Stack {
  admin = new Pool({ connectionString: process.env.DATABASE_URL });
  database = "tcg_price_stack_" + randomUUID().replaceAll("-", "");
  directory = mkdtempSync(join(tmpdir(), "tcg-price-stack-"));
  origin = process.env.TEST_ORIGIN || "http://localhost:5173";
  ownerEmail = "owner@example.test";
  pool!: Pool;
  relayUrl = "";
  gateways: string[] = [];
  apis: string[] = [];
  children: ChildProcess[] = [];
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
          !key.startsWith("PUBLIC_PROJECTION_") &&
          key !== "CATALOG_PROCESS_FIXTURE_DIR"
      )
    );
    this.base = {
      ...inherited,
      EMAIL_SIGN_IN: "on",
      DATABASE_URL: connection.toString(),
      MAIL_MODE: "file",
      MAIL_FILE: join(this.directory, "mail"),
      SIGNUP_MODE: "local-public",
      NODE_ENV: "test",
      OWNER_EMAIL: this.ownerEmail,
      PUBLIC_ORIGIN: this.origin,
    };
    await this.python(["scripts/migrate.py"], {});

    // The relay: the record store both APIs share. Its port arrives on stdout.
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

    const apiEnv = {
      ...this.store(),
      PYTHONPATH:
        join(process.cwd(), "api/tests/catalog_process_fixture") +
        ":" +
        join(process.cwd(), "api"),
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

  /** The record-store settings for the HTTP relay (the APIs and the catalog drain). */
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

  // ---------------------------------------------------------------- Editions
  /**
   * One Printing per card with one verified Edition per finish (`normal`, then `reverse-holofoil`), delivered to the
   * record store through the public catalog outbox.
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
          [`price-stack-${card}`, `Stack Card ${this.sequence}`]
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

  async stop() {
    for (const child of this.children) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        await new Promise((resolve) => child.once("exit", resolve));
      }
    }
    await this.pool?.end();
    await dropDatabase(this.admin, this.database);
    await this.admin.end();
    rmSync(this.directory, { recursive: true, force: true });
  }
}
