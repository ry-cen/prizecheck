// @module-tag slow
// slow (process): two gateways and two APIs (one pair on a disposable database, one isolated pair whose databases are
// counting listeners) and one wait through the real 3 s price budget; the Published Deck exports (tickets 13 and 14) and
// format results (Deck Lists 18) reuse the same stacks.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer as netServer, type Server as NetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Pool } from "pg";
import { dropDatabase } from "./support/servers";

// Ticket 12: the Published Deck cost through the real gateway. Two stacks share one projection directory. G0/A0 use a
// disposable database and publish. G1/A1 are the anonymous pair: their DATABASE_URL points at counting listeners, so any
// session lookup or PostgreSQL write on a public route shows up as a connection. Every elapsed time is measured outside
// the gateway. The exports are unbudgeted; they share the stacks to prove the same zero-database routing.
const run = promisify(execFile);
const ownerEmail = "owner@example.test";
const origin = process.env.TEST_ORIGIN || "http://localhost:5173";
const admin = new Pool({ connectionString: process.env.DATABASE_URL });
const database = "tcg_published_cost_" + randomUUID().replaceAll("-", "");
const directory = mkdtempSync(join(tmpdir(), "tcg-published-cost-"));
const gateExempt = join(directory, "gate");
const projection = join(directory, "projection");
const launchLog = join(directory, "launches.log");
const currentJson = join(projection, "current.json");
const children: ChildProcess[] = [];
const listeners: NetServer[] = [];
const wakeups = { gateway: 0, api: 0 };
let pool: Pool;
let env: NodeJS.ProcessEnv = {};
let G0 = "";
let G1 = "";
let A1 = "";
let owner = { id: "", cookie: "" };
let activation = "";
let liveActivation = "";
let sequence = 0;
let attempt = 0;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = netServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });

async function waitFor<T>(
  probe: () => Promise<T | false | null | undefined> | T | false | null,
  what: string,
  limit = 10_000,
  step = 50
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

/** Timing margins for the report: stderr, plus published-cost-metrics.log in TEST_LOG_DIR when the gate sets it. */
function metric(line: string) {
  process.stderr.write(`[published-cost] ${line}\n`);
  if (process.env.TEST_LOG_DIR)
    appendFileSync(
      join(process.env.TEST_LOG_DIR, "published-cost-metrics.log"),
      `${new Date().toISOString()} ${line}\n`
    );
}

const iso = (msAgo: number) =>
  new Date(Math.floor((Date.now() - msAgo) / 1000) * 1000).toISOString();

async function python(code: string, argument: unknown = null) {
  const file = join(directory, `argument-${randomUUID()}.json`);
  writeFileSync(file, JSON.stringify(argument));
  const { stdout } = await run(".venv/bin/python", ["-c", code, file], {
    env: { ...env, PYTHONPATH: "api" },
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

type Edition = {
  id: string;
  ref: string;
  card: string;
  finish: string;
  revision: number;
};

/** One Printing per call with one Edition per finish; verified ones get a quote variant and a product. */
async function printing(
  prefix: string,
  finishes: string[],
  verified: boolean
): Promise<Edition[]> {
  sequence++;
  const card = `${prefix}-${randomUUID().slice(0, 8)}-${sequence}`;
  const productId = 800_000 + sequence;
  const identity = (
    await pool.query(
      "INSERT INTO catalog_identity(identity_key,display_name) VALUES ($1,$2) RETURNING id",
      [`published-cost-${card}`, `Published Card ${sequence}`]
    )
  ).rows[0].id;
  const made = (
    await pool.query(
      "INSERT INTO catalog_printing(source,source_id,identity_id) VALUES ('tcgdex',$1,$2) RETURNING id",
      [card, identity]
    )
  ).rows[0].id;
  const group: Edition[] = [];
  for (const finish of finishes) {
    const edition = (
      await pool.query(
        "INSERT INTO catalog_edition(printing_id,descriptor_key,descriptor) VALUES ($1,$2,$3) RETURNING id,public_ref",
        [made, finish, JSON.stringify({ finish })]
      )
    ).rows[0];
    let revision = 0;
    if (verified)
      revision = Number(
        (
          await pool.query(
            `UPDATE catalog_edition_metadata SET mapping_state='verified',mapping_reason=NULL,product_id=$2,quote_variant=$4,
             mapping_basis='matching_rule',matching_activation_id=$3,auto_closed=true WHERE edition_id=$1 RETURNING mapping_revision`,
            [edition.id, productId, activation, finish]
          )
        ).rows[0].mapping_revision
      );
    group.push({
      id: edition.id,
      ref: edition.public_ref,
      card,
      finish,
      revision,
    });
  }
  return group;
}

/** Delivers the catalog outbox to the record store, so the public path sees the Editions. */
async function deliver() {
  await run(".venv/bin/python", ["-m", "app.catalog_import", "--drain"], {
    env: { ...env, PYTHONPATH: "api" },
    maxBuffer: 16 * 1024 * 1024,
  });
}

const STORE = `import json, sys, time
from app import quote_contract as qc
from app.public_records import public_record_store, quote_key, result_key
argument = json.load(open(sys.argv[1]))
store = public_record_store()
deadline = lambda: time.monotonic() + 5
`;

/** Seeds what an earlier refresh wrote: a quote checked `checkedAgoMs` ago, with the provider's own time. */
async function seedQuote(
  edition: Edition,
  amount: string,
  checkedAgoMs: number,
  updated: string
) {
  attempt++;
  await python(
    STORE +
      `keys = [quote_key(argument['ref'], argument['revision']), result_key(argument['ref'], argument['revision'])]
snapshot = store.read_records(keys, deadline=deadline())
changes = {
    keys[1]: {'state': 'quote', 'attempt': argument['attempt'], 'checked_at': argument['checked']},
    keys[0]: {'attempt': argument['attempt'], 'amount': argument['amount'], 'currency': 'USD', 'source': 'tcgdex',
              'card': argument['card'], 'variant': argument['finish'], 'provider_updated_at': argument['updated']},
}
assert store.compare_and_swap({key: snapshot.records[key].version for key in changes}, changes, deadline=deadline())
`,
    {
      ref: edition.ref,
      revision: edition.revision,
      attempt,
      amount,
      checked: iso(checkedAgoMs),
      card: edition.card,
      finish: edition.finish,
      updated,
    }
  );
}

const scheduler = async () =>
  JSON.parse(
    await python(
      STORE +
        "print(json.dumps(store.read_records([qc.scheduler_key()], deadline=deadline()).records[qc.scheduler_key()].value))"
    )
  );
const readRecord = async (key: string) =>
  JSON.parse(
    await python(
      STORE +
        "key = argument\nprint(json.dumps(store.read_records([key], deadline=deadline()).records[key].value))",
      key
    )
  );

/** A new scheduler whose anonymous ledger already counts `count` callers this hour; leases and ledger shards cleared. */
async function resetScheduler(count: number) {
  await python(
    STORE +
      `now = int(time.time() * 1000)
scheduler = qc.new_scheduler(now)
scheduler['ledger'] = {'interval': now // qc.FRESH_MS, 'count': argument}
keys = [qc.scheduler_key()] + [qc.runner_lease_key(n) for n in qc.RUNNER_SLOTS] + [qc.ledger_key(n) for n in range(qc.LEDGER_SHARDS)]
snapshot = store.read_records(keys, deadline=deadline())
changes = {qc.scheduler_key(): scheduler}
for key in keys[1:]:
    if snapshot.records[key].value is not None:
        changes[key] = None
assert store.compare_and_swap({key: snapshot.records[key].version for key in changes}, changes, deadline=deadline())
`,
    count
  );
}

async function deckWith(quantities: Array<[Edition, number]>) {
  const deck = randomUUID();
  await pool.query(
    "INSERT INTO location(id,owner_id,name,kind) VALUES ($1,$2,$3,'deck')",
    [deck, owner.id, `Deck ${deck}`]
  );
  for (const [edition, quantity] of quantities)
    await pool.query(
      "INSERT INTO deck_list_line(owner_id,deck_id,edition_id,quantity) VALUES ($1,$2,$3,$4)",
      [owner.id, deck, edition.id, quantity]
    );
  await bumpList(deck);
  await bump();
  return deck;
}
const bumpList = (deck: string) =>
  pool.query("UPDATE deck_list SET revision=revision+1 WHERE deck_id=$1", [
    deck,
  ]);
const bump = () =>
  pool.query(
    "UPDATE inventory_owner SET revision=revision+1 WHERE user_id=$1",
    [owner.id]
  );
async function addCopies(deck: string, edition: Edition, count: number) {
  await pool.query(
    "UPDATE deck_list_line SET quantity=quantity+$3 WHERE deck_id=$1 AND edition_id=$2",
    [deck, edition.id, count]
  );
  await bumpList(deck);
  await bump();
}

async function publication(
  method: "POST" | "PUT" | "DELETE",
  deck: string
): Promise<{ token: string; version: number; revoked: boolean }> {
  // These Decks are small and not legal in any Format; the CI-only fixture lets them past the publish gate.
  if (method !== "DELETE") {
    mkdirSync(join(gateExempt, "publish-gate-exempt"), { recursive: true });
    writeFileSync(join(gateExempt, "publish-gate-exempt", deck), "");
  }
  const response = await fetch(`${G0}/api/decks/${deck}/publication`, {
    method,
    headers: {
      origin,
      "content-type": "application/json",
      cookie: owner.cookie,
    },
    body: JSON.stringify(
      method === "DELETE"
        ? { idempotency_key: randomUUID() }
        : { title: "Priced public deck", idempotency_key: randomUUID() }
    ),
  });
  expect(response.status).toBe(200);
  return response.json();
}

async function anonymous(path: string, headers: Record<string, string> = {}) {
  const started = performance.now();
  const response = await fetch(G1 + path, { headers });
  const text = await response.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return {
    status: response.status,
    elapsed: performance.now() - started,
    text,
    json,
    headers: response.headers,
  };
}
/** Fixture Live eligibility for the Printing of `edition` (rule basis under the fixture activation). Call before deliver(). */
async function liveEligible(
  edition: Edition,
  identity: { category: string; name: string; set_code: string; number: string }
) {
  await pool.query(
    `UPDATE catalog_printing_metadata SET live_state='eligible',live_reason=NULL,live_identity=$2,live_basis='rule',
     live_activation_id=$3,live_auto_closed=true WHERE printing_id=(SELECT printing_id FROM catalog_edition WHERE id=$1)`,
    [edition.id, JSON.stringify(identity), liveActivation]
  );
}
const exportPath = (token: string, version: number, kind: string) =>
  `/api/public/decks/${token}/versions/${version}/exports/${kind}`;
const KINDS = ["live", "live.txt", "tcgplayer", "tcgplayer.txt"];
const costPath = (token: string, version: number) =>
  `/api/public/decks/${token}/versions/${version}/cost`;

/** Seeds many quotes in one process: [edition, amount, checkedAgoMs, providerUpdated], 64 Editions per commit. */
async function seedQuotes(entries: Array<[Edition, string, number, string]>) {
  await python(
    STORE +
      `for offset in range(0, len(argument), 64):
    changes = {}
    for row in argument[offset:offset + 64]:
        changes[result_key(row['ref'], row['revision'])] = {'state': 'quote', 'attempt': row['attempt'], 'checked_at': row['checked']}
        changes[quote_key(row['ref'], row['revision'])] = {'attempt': row['attempt'], 'amount': row['amount'], 'currency': 'USD',
            'source': 'tcgdex', 'card': row['card'], 'variant': row['finish'], 'provider_updated_at': row['updated']}
    snapshot = store.read_records(list(changes), deadline=deadline())
    assert store.compare_and_swap({key: snapshot.records[key].version for key in changes}, changes, deadline=deadline())
`,
    entries.map(([edition, amount, checkedAgoMs, updated]) => ({
      ref: edition.ref,
      revision: edition.revision,
      attempt: ++attempt,
      amount,
      checked: iso(checkedAgoMs),
      card: edition.card,
      finish: edition.finish,
      updated,
    }))
  );
}

/** An anonymous call through gateway `gateway` (G0 or G1) from client address `ip` (the gateways trust 127.0.0.1's x-real-ip). */
async function anonymousFrom(gateway: string, path: string, ip: string) {
  const started = performance.now();
  const response = await fetch(gateway + path, {
    headers: { "x-real-ip": ip },
  });
  const text = await response.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return {
    status: response.status,
    elapsed: performance.now() - started,
    json,
  };
}

const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * p) - 1];
};

const launches = () =>
  existsSync(launchLog)
    ? readFileSync(launchLog, "utf8").split("\n").filter(Boolean).length
    : 0;

function spawnProcess(command: string, args: string[], at: NodeJS.ProcessEnv) {
  const child = spawn(command, args, { env: at, stdio: "ignore" });
  children.push(child);
  return child;
}
const uvicorn = (port: number, at: NodeJS.ProcessEnv) =>
  spawnProcess(
    ".venv/bin/uvicorn",
    [
      "app.main:app",
      "--app-dir",
      "api",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--no-access-log",
    ],
    at
  );
const countingListener = async (key: "gateway" | "api") => {
  const server = netServer((socket) => {
    wakeups[key]++;
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  listeners.push(server);
  return (server.address() as { port: number }).port;
};

beforeAll(async () => {
  await admin.query(`CREATE DATABASE "${database}"`);
  const connection = new URL(process.env.DATABASE_URL!);
  connection.pathname = "/" + database;
  pool = new Pool({ connectionString: connection.toString() });
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !key.startsWith("PRICE_FIXTURE_") &&
        !key.startsWith("PUBLIC_PROJECTION_") &&
        key !== "PRICE_RUNNER_LOCK_DIR" &&
        key !== "CATALOG_PROCESS_FIXTURE_DIR"
    )
  );
  env = {
    ...inherited,
    EMAIL_SIGN_IN: "on",
    DATABASE_URL: connection.toString(),
    MAIL_MODE: "file",
    MAIL_FILE: join(directory, "mail"),
    SIGNUP_MODE: "local-public",
    NODE_ENV: "test",
    OWNER_EMAIL: ownerEmail,
    PUBLIC_ORIGIN: origin,
    PUBLIC_PROJECTION_ADAPTER: "filesystem",
    PUBLIC_PROJECTION_DIR: projection,
    PRICE_RUNNER_LOCK_DIR: join(directory, "locks"),
    PRICE_FIXTURE_LAUNCHER: "record",
    PRICE_FIXTURE_LAUNCH_LOG: launchLog,
    PUBLISH_GATE_EXEMPT_DIR: gateExempt,
  };
  mkdirSync(projection, { recursive: true });
  mkdirSync(join(directory, "locks"), { recursive: true, mode: 0o700 });
  await run(".venv/bin/python", ["scripts/migrate.py"], { env });
  await run(".venv/bin/python", ["scripts/init_public_projection.py"], {
    env,
  });

  const gatewayWakeups = await countingListener("gateway");
  const apiWakeups = await countingListener("api");
  const apiEnv = (at: NodeJS.ProcessEnv) => ({
    ...at,
    PYTHONPATH:
      join(process.cwd(), "api/tests/catalog_process_fixture") +
      ":" +
      join(process.cwd(), "api"),
  });
  const [a0, g0, a1, g1] = await Promise.all([
    freePort(),
    freePort(),
    freePort(),
    freePort(),
  ]);
  const isolated = (port: number) =>
    `postgresql://nobody:nobody@127.0.0.1:${port}/none`;
  uvicorn(a0, apiEnv(env));
  spawnProcess("node", ["--import", "tsx", "auth/src/server.ts"], {
    ...env,
    AUTH_PORT: String(g0),
    TRUSTED_PROXY_IPS: "127.0.0.1",
    API_ORIGIN: `http://127.0.0.1:${a0}`,
  });
  uvicorn(a1, apiEnv({ ...env, DATABASE_URL: isolated(apiWakeups) }));
  spawnProcess("node", ["--import", "tsx", "auth/src/server.ts"], {
    ...env,
    DATABASE_URL: isolated(gatewayWakeups),
    AUTH_PORT: String(g1),
    TRUSTED_PROXY_IPS: "127.0.0.1",
    API_ORIGIN: `http://127.0.0.1:${a1}`,
  });
  G0 = `http://127.0.0.1:${g0}`;
  G1 = `http://127.0.0.1:${g1}`;
  A1 = `http://127.0.0.1:${a1}`;
  const ready = (url: string) => async () => {
    try {
      return (await fetch(url)).ok;
    } catch {
      return false;
    }
  };
  await waitFor(ready(G0 + "/auth/session"), "the disposable gateway", 30_000);
  await waitFor(ready(`http://127.0.0.1:${a0}/api/health`), "API 0", 30_000);
  await waitFor(ready(A1 + "/api/health"), "API 1", 30_000);
  // Never /auth/session on G1: that is a session lookup against the counting listener.
  await waitFor(
    ready(G1 + "/api/public/discovery"),
    "the isolated gateway",
    30_000
  );

  const post = (path: string, body: object) =>
    fetch(G0 + path, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  expect((await post("/auth/request-code", { email: ownerEmail })).status).toBe(
    202
  );
  const code = JSON.parse(
    readFileSync(join(directory, "mail"), "utf8").trim().split("\n").at(-1)!
  ).otp;
  const signin = await post("/auth/verify-code", { email: ownerEmail, code });
  expect(signin.status).toBe(200);
  const id = (
    await pool.query('SELECT id FROM "user" WHERE email=$1', [ownerEmail])
  ).rows[0].id;
  owner = { id, cookie: signin.headers.get("set-cookie")!.split(";")[0] };
  await pool.query(
    "INSERT INTO inventory_owner(user_id) VALUES ($1) ON CONFLICT DO NOTHING",
    [id]
  );
  await pool.query(
    "INSERT INTO owner_binding(singleton,user_id) VALUES (true,$1) ON CONFLICT DO NOTHING",
    [id]
  );
  activation = (
    await pool.query(
      `INSERT INTO catalog_rule_activation(kind,reviewer_id,evidence_url,reason,clock_revision)
       VALUES ('marketplace_matching',$1,'https://example.org/rule','Fixture activation',1) RETURNING id`,
      [id]
    )
  ).rows[0].id;
  liveActivation = (
    await pool.query(
      `INSERT INTO catalog_rule_activation(kind,reviewer_id,evidence_url,reason,clock_revision)
       VALUES ('live_derivation',$1,'https://example.org/rule','Fixture activation',1) RETURNING id`,
      [id]
    )
  ).rows[0].id;
}, 90_000);

afterAll(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await new Promise((resolve) => child.once("exit", resolve));
    }
  }
  for (const server of listeners)
    await new Promise((resolve) => server.close(resolve));
  await pool?.end();
  await dropDatabase(admin, database);
  await admin.end();
  rmSync(directory, { recursive: true, force: true });
}, 60_000);

const KEYS = [
  "amount",
  "currency",
  "digest",
  "display_amount",
  "fallback_copies",
  "priced_copies",
  "reason",
  "stale_copies",
  "status",
  "total_copies",
  "unknown_age_copies",
  "version",
];

describe("the Published Deck cost through the real gateway", () => {
  it(
    "wakes neither database for absent, forged or valid cookies, prices every frozen copy, and ignores client internal headers",
    { timeout: 45_000 },
    async () => {
      const [normal, reverse] = await printing(
        "pc-priced",
        ["normal", "reverse-holofoil"],
        true
      );
      const [plain] = await printing("pc-plain", ["normal"], false);
      await deliver();
      await seedQuote(normal, "0.25", 10 * 60_000, iso(3_600_000));
      await seedQuote(reverse, "0.43", 10 * 60_000, iso(72 * 3_600_000));
      const deck = await deckWith([
        [normal, 3],
        [reverse, 2],
        [plain, 1],
      ]);
      const { token, version } = await publication("POST", deck);
      expect(version).toBe(1);
      // A private edit after publishing changes nothing in the frozen snapshot.
      await addCopies(deck, normal, 10);

      const baseline = { ...wakeups };
      const texts: string[] = [];
      for (const cookie of [
        undefined,
        "better-auth.session_token=forged",
        owner.cookie,
      ]) {
        const headers: Record<string, string> = cookie ? { cookie } : {};
        expect(
          (await anonymous(`/api/public/decks/${token}`, headers)).status
        ).toBe(200);
        const priced = await anonymous(costPath(token, 1), headers);
        expect(priced.status).toBe(200);
        texts.push(priced.text);
      }
      const forged = await anonymous(costPath(token, 1), {
        cookie: owner.cookie,
        "x-internal-user": owner.id,
        "x-internal-caller": `user:${owner.id}`,
        "x-internal-budget-ms": "30000",
        "x-internal-budget-time": String(Math.floor(Date.now() / 1000)),
        "x-internal-budget-signature": "0".repeat(64),
        "x-internal-signature": "0".repeat(64),
      });
      expect(forged.status).toBe(200);
      texts.push(forged.text);
      expect(new Set(texts).size).toBe(1);
      const body = JSON.parse(texts[0]);
      expect(Object.keys(body).sort()).toEqual(KEYS);
      expect(body).toMatchObject({
        version: 1,
        status: "priced",
        reason: null,
        amount: "1.61",
        display_amount: "$1.61",
        priced_copies: "5",
        total_copies: "6",
        stale_copies: "2",
        unknown_age_copies: "0",
        fallback_copies: "0",
        currency: "USD",
      });
      expect(body.digest).toMatch(/^[0-9a-f]{64}$/);
      for (const secret of [owner.id, deck, normal.id, reverse.id, plain.id])
        expect(texts[0]).not.toContain(secret);
      expect(wakeups).toEqual(baseline);

      // Legacy snapshot through the gateway: the same version without references is readable and unpriced.
      const state = JSON.parse(readFileSync(currentJson, "utf8"));
      for (const identity of state.decks[token].snapshot.identities)
        for (const edition of identity.editions) {
          delete edition.edition_ref;
          delete edition.printing_ref;
        }
      const temporary = join(projection, ".legacy-" + randomUUID());
      writeFileSync(temporary, JSON.stringify(state));
      renameSync(temporary, currentJson);
      expect((await anonymous(`/api/public/decks/${token}`)).status).toBe(200);
      const legacy = await anonymous(costPath(token, 1));
      expect(legacy.status).toBe(200);
      expect(legacy.json).toMatchObject({
        status: "no_quotes",
        priced_copies: "0",
        total_copies: "6",
      });
      expect(wakeups).toEqual(baseline);

      // Controls, last: each counter is live.
      await fetch(G1 + "/api/locations", { headers: { cookie: owner.cookie } });
      await waitFor(
        () => wakeups.gateway > baseline.gateway,
        "the gateway's session lookup"
      );
      await fetch(A1 + "/api/locations");
      await waitFor(
        () => wakeups.api > baseline.api,
        "the API's operations write"
      );
      // The isolated gateway survives its own control.
      expect((await anonymous("/api/public/discovery")).status).toBe(200);
    }
  );

  it(
    "answers a republished version with 409 and a revoked token with 404, even when the refresh lands after the revoke, and moves no manifest or discovery revision",
    { timeout: 45_000 },
    async () => {
      const [edition] = await printing("pc-wait", ["normal"], true);
      await deliver();
      await seedQuote(edition, "0.25", 10 * 60_000, iso(3_600_000));
      const deck = await deckWith([[edition, 2]]);
      const { token } = await publication("POST", deck);
      const baseline = { ...wakeups };

      const first = await anonymous(costPath(token, 1));
      expect(first.json).toMatchObject({
        display_amount: "$0.50",
        priced_copies: "2",
        total_copies: "2",
      });
      const manifest = readFileSync(currentJson);
      const revision = (await anonymous("/api/public/discovery")).json.revision;
      await seedQuote(edition, "0.30", 5 * 60_000, iso(3_600_000));
      expect((await anonymous(costPath(token, 1))).json).toMatchObject({
        display_amount: "$0.60",
      });
      expect(readFileSync(currentJson).equals(manifest)).toBe(true);
      expect((await anonymous("/api/public/discovery")).json.revision).toBe(
        revision
      );

      await addCopies(deck, edition, 1);
      expect((await publication("PUT", deck)).version).toBe(2);
      const old = await anonymous(costPath(token, 1));
      expect(old.status).toBe(409);
      expect(old.json.detail.code).toBe("PUBLISHED_DECK_CHANGED");
      expect((await anonymous(costPath(token, 2))).json).toMatchObject({
        version: 2,
        display_amount: "$0.90",
        priced_copies: "3",
        total_copies: "3",
      });

      // A hard row: the access admits it and waits. The launch line is appended in A1 right after the admission commit,
      // so the request is inside its wait window. Never more than one waiting request per caller is in flight.
      await seedQuote(edition, "0.30", 25 * 3_600_000, iso(3_600_000));
      const lines = launches();
      const pending = anonymous(costPath(token, 2));
      await waitFor(() => launches() > lines, "the admission", 10_000, 20);
      expect((await publication("DELETE", deck)).revoked).toBe(true);
      const revoked = readFileSync(currentJson);
      // The late refresh ends the wait.
      await seedQuote(edition, "0.35", 0, iso(0));
      const answer = await pending;
      expect(answer.status).toBe(404);
      expect(answer.json.detail.code).toBe("PUBLISHED_DECK_NOT_FOUND");
      expect((await anonymous(`/api/public/decks/${token}`)).status).toBe(404);
      expect((await anonymous(costPath(token, 2))).status).toBe(404);
      expect(readFileSync(currentJson).equals(revoked)).toBe(true);
      expect(revoked.toString()).not.toContain(token);
      expect(wakeups).toEqual(baseline);
    }
  );

  it(
    "answers a hard row inside the 3 s budget measured outside the gateway while the snapshot stays fast, and a full anonymous ledger refuses a new caller without waiting",
    { timeout: 45_000 },
    async () => {
      const [edition] = await printing("pc-hard", ["normal"], true);
      await deliver();
      const deck = await deckWith([[edition, 2]]);
      const { token } = await publication("POST", deck);
      const baseline = { ...wakeups };
      await resetScheduler(0);

      await seedQuote(edition, "1.00", 25 * 3_600_000, iso(3_600_000));
      const [cost, snapshot] = await Promise.all([
        anonymous(costPath(token, 1)),
        sleep(200).then(() => anonymous(`/api/public/decks/${token}`)),
      ]);
      metric(
        `published cost hard row: ${cost.elapsed.toFixed(0)} ms (gate abort 3000); snapshot meanwhile: ${snapshot.elapsed.toFixed(0)} ms (bound 1500)`
      );
      expect(cost.status).toBe(200);
      expect(cost.json).toMatchObject({
        status: "priced",
        display_amount: "$2.00",
        priced_copies: "2",
        fallback_copies: "2",
      });
      // The bound is generous because vitest has no serial pass (#68) and a loaded host stretches it; the strict 3.0 s
      // gate is the gateway's abort, which turns an overrun into a 504 and so fails the status check above.
      expect(cost.elapsed).toBeGreaterThan(2_000);
      expect(cost.elapsed).toBeLessThanOrEqual(3_500);
      expect(snapshot.status).toBe(200);
      expect(snapshot.elapsed).toBeLessThan(1_500);

      // Ledger: the hourly interval must not roll over while this runs.
      if (Date.now() % 3_600_000 > 3_600_000 - 15_000) await sleep(15_500);
      await resetScheduler(10_000);
      await seedQuote(edition, "1.00", 2 * 3_600_000, iso(3_600_000));
      const refused = await anonymous(costPath(token, 1));
      expect(refused.elapsed).toBeLessThan(2_000);
      expect(refused.json).toMatchObject({
        status: "priced",
        priced_copies: "2",
        fallback_copies: "2",
      });
      const full = await scheduler();
      expect(Object.keys(full.jobs)).toEqual([]);
      expect(full.ledger.count).toBe(10_000);

      await resetScheduler(0);
      const admitted = await anonymous(costPath(token, 1));
      expect(admitted.json).toMatchObject({ fallback_copies: "0" });
      const jobs = (await scheduler()).jobs;
      const job = `${edition.ref}:${edition.revision}`;
      expect(jobs[job].caller).toMatch(/^anon:[0-9a-f]{32}$/);
      const work = await readRecord(`work:${job}`);
      expect(Object.keys(work).sort()).toEqual([
        "admitted_ms",
        "attempt",
        "caller",
        "card",
        "edition_ref",
        "expires_ms",
        "mapping_revision",
        "owner",
        "product_id",
        "slot",
        "state",
        "v",
        "variant",
      ]);
      const text = JSON.stringify(work);
      expect(text).not.toContain(owner.id);
      expect(text).not.toContain(deck);
      expect(wakeups).toEqual(baseline);
    }
  );

  it(
    "serves both exports of every frozen copy without waking either database for absent, forged or valid cookies, and follows republish and revoke without moving the manifest or discovery",
    { timeout: 45_000 },
    async () => {
      const [normal, reverse] = await printing(
        "pe-mapped",
        ["normal", "reverse-holofoil"],
        true
      );
      const [plain] = await printing("pe-plain", ["normal"], false);
      await liveEligible(normal, {
        category: "Pokemon",
        name: "Gateway Mon",
        set_code: "GWY",
        number: "1",
      });
      await liveEligible(plain, {
        category: "Trainer",
        name: "Gateway Ball",
        set_code: "GWY",
        number: "2",
      });
      await deliver();
      const deck = await deckWith([
        [normal, 3],
        [reverse, 2],
        [plain, 1],
      ]);
      const { token } = await publication("POST", deck);
      await addCopies(deck, normal, 10);

      const manifest = readFileSync(currentJson);
      const revision = (await anonymous("/api/public/discovery")).json.revision;
      const baseline = { ...wakeups };

      const texts: Record<string, string[]> = {};
      const answers: Record<string, any> = {};
      for (const cookie of [
        undefined,
        "better-auth.session_token=forged",
        owner.cookie,
      ])
        for (const kind of KINDS) {
          const answer = await anonymous(
            exportPath(token, 1, kind),
            cookie ? { cookie } : {}
          );
          expect(answer.status, `${kind} ${cookie}`).toBe(200);
          (texts[kind] ??= []).push(answer.text);
          answers[kind] = answer;
        }
      for (const kind of KINDS) expect(new Set(texts[kind]).size).toBe(1);

      const live = answers["live"].json;
      const liveText =
        "Pokémon: 5\n5 Gateway Mon GWY 1\n\nTrainer: 1\n1 Gateway Ball GWY 2";
      expect(live).toMatchObject({ status: "ok", version: 1, text: liveText });
      expect(live.digest).toMatch(/^[0-9a-f]{64}$/);
      expect(answers["live.txt"].text).toBe(liveText);

      const mass = answers["tcgplayer"].json;
      expect(mass).toMatchObject({
        status: "text",
        fallback_reason: "missing_mapping",
        total_copies: "6",
      });
      expect(mass.lines.map((line: any) => line.quantity).sort()).toEqual([
        "1",
        "5",
      ]);
      for (const line of mass.lines)
        expect(line.text).toMatch(/^\d+ Published Card \d+$/);
      expect(answers["tcgplayer.txt"].text).toBe(mass.text);

      for (const kind of ["live", "tcgplayer"]) {
        expect(answers[kind].headers.get("cache-control")).toBe("no-store");
        expect(answers[kind].headers.get("x-robots-tag")).toBe(
          "noindex, nofollow"
        );
      }
      for (const kind of ["live.txt", "tcgplayer.txt"]) {
        expect(answers[kind].headers.get("content-disposition")).toMatch(
          /^attachment/
        );
        expect(answers[kind].headers.get("cache-control")).toBe("no-store");
        expect(answers[kind].headers.get("x-robots-tag")).toBe(
          "noindex, nofollow"
        );
      }

      for (const kind of KINDS)
        for (const secret of [owner.id, deck, normal.id, reverse.id, plain.id])
          expect(texts[kind][0]).not.toContain(secret);
      expect(wakeups).toEqual(baseline);
      expect(readFileSync(currentJson).equals(manifest)).toBe(true);
      expect((await anonymous("/api/public/discovery")).json.revision).toBe(
        revision
      );

      const deck2 = await deckWith([
        [normal, 3],
        [reverse, 2],
      ]);
      const second = await publication("POST", deck2);
      const linked = await anonymous(exportPath(second.token, 1, "tcgplayer"));
      expect(linked.json.status).toBe("link");
      expect(linked.json.url).toMatch(
        /^https:\/\/www\.tcgplayer\.com\/massentry\?productline=Pokemon&c=5-\d+$/
      );

      expect((await publication("PUT", deck)).version).toBe(2);
      for (const kind of KINDS) {
        const old = await anonymous(exportPath(token, 1, kind));
        expect(old.status, kind).toBe(409);
        expect(old.json.detail.code).toBe("PUBLISHED_DECK_CHANGED");
      }
      expect((await anonymous(exportPath(token, 2, "live"))).json.text).toBe(
        "Pokémon: 15\n15 Gateway Mon GWY 1\n\nTrainer: 1\n1 Gateway Ball GWY 2"
      );

      expect((await publication("DELETE", deck)).revoked).toBe(true);
      for (const kind of KINDS) {
        const gone = await anonymous(exportPath(token, 2, kind));
        expect(gone.status, kind).toBe(404);
        expect(gone.json.detail.code).toBe("PUBLISHED_DECK_NOT_FOUND");
      }
      expect(wakeups).toEqual(baseline);
    }
  );
  it(
    "serves Published Deck format results without waking either database for absent, forged or valid cookies, and follows republish and revoke",
    { timeout: 45_000 },
    async () => {
      const [card] = await printing("pf-format", ["normal"], false);
      await deliver();
      const deck = await deckWith([[card, 4]]);
      const { token } = await publication("POST", deck);
      const manifest = readFileSync(currentJson);
      const baseline = { ...wakeups };
      const path = (version: number) =>
        `/api/public/decks/${token}/versions/${version}/format-checks?as_of=2026-10-11`;

      const texts: string[] = [];
      let answer: Awaited<ReturnType<typeof anonymous>> | undefined;
      for (const cookie of [
        undefined,
        "better-auth.session_token=forged",
        owner.cookie,
      ]) {
        answer = await anonymous(path(1), cookie ? { cookie } : {});
        expect(answer.status, `${cookie}`).toBe(200);
        texts.push(answer.text);
      }
      // Each answer computes its results when asked (computed_at); everything else is identical.
      const timeless = (text: string) => {
        const parsed = JSON.parse(text);
        return JSON.stringify({
          ...parsed,
          results: parsed.results.map(
            ({ computed_at, ...result }: any) => result
          ),
        });
      };
      expect(new Set(texts.map(timeless)).size).toBe(1);
      const body = answer!.json;
      expect(body.version).toBe(1);
      expect(body.digest).toMatch(/^[0-9a-f]{64}$/);
      expect(body.results.map((result: any) => result.format)).toEqual([
        "standard",
        "expanded",
        "glc",
      ]);
      // Four copies of a card with no set or attributes: not legal on size, never legal.
      for (const result of body.results)
        expect(result.status).toBe("not_legal");
      expect(answer!.headers.get("cache-control")).toBe("no-store");
      expect(answer!.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      for (const text of texts)
        for (const secret of [owner.id, deck, card.id])
          expect(text).not.toContain(secret);
      expect(wakeups).toEqual(baseline);
      expect(readFileSync(currentJson).equals(manifest)).toBe(true);

      expect((await publication("PUT", deck)).version).toBe(2);
      const old = await anonymous(path(1));
      expect(old.status).toBe(409);
      expect(old.json.detail.code).toBe("PUBLISHED_DECK_CHANGED");
      expect((await anonymous(path(2))).status).toBe(200);
      expect((await publication("DELETE", deck)).revoked).toBe(true);
      const gone = await anonymous(path(2));
      expect(gone.status).toBe(404);
      expect(gone.json.detail.code).toBe("PUBLISHED_DECK_NOT_FOUND");
      expect(wakeups).toEqual(baseline);
    }
  );
  it(
    "keeps cached prices under 500 ms p95 through the gateway, and answers 100 simultaneous callers on both gateways over overlapping and disjoint Published Decks with every frozen copy counted, shared work deduplicated and the interactive cap held",
    { timeout: 90_000 },
    async () => {
      const made: Edition[] = [];
      for (let n = 0; n < 30; n++)
        made.push(...(await printing(`pc-cap-${n}`, ["normal"], true)));
      const [plain] = await printing("pc-cap-plain", ["normal"], false);
      await deliver();
      await seedQuotes(
        made.map((e) => [e, "0.25", 10 * 60_000, iso(3_600_000)])
      );
      // A: 60 copies. B overlaps A on five Editions. C is disjoint, with one unverified copy.
      const decks = {
        A: await deckWith(
          made.slice(0, 15).map((e) => [e, 4] as [Edition, number])
        ),
        B: await deckWith(
          made.slice(10, 25).map((e) => [e, 2] as [Edition, number])
        ),
        C: await deckWith([
          ...made.slice(25, 30).map((e) => [e, 1] as [Edition, number]),
          [plain, 1],
        ]),
      };
      const expected = {
        A: { total: "60", priced: "60", amount: "15", fallback: "20" },
        B: { total: "30", priced: "30", amount: "7.5", fallback: "10" },
        C: { total: "6", priced: "5", amount: "1.25", fallback: "0" },
      };
      const tokens: Record<string, string> = {};
      for (const [name, deck] of Object.entries(decks))
        tokens[name] = (await publication("POST", deck)).token;
      await resetScheduler(0);
      const baseline = { ...wakeups };

      // Cached ordinary prices, one at a time: the card price route (signed in, G0) and the Published Deck cost (G1).
      const editionTimes: number[] = [];
      const costTimes: number[] = [];
      for (let n = 0; n <= 20; n++) {
        const started = performance.now();
        const response = await fetch(G0 + "/api/prices/editions", {
          method: "POST",
          headers: {
            origin,
            "content-type": "application/json",
            cookie: owner.cookie,
          },
          body: JSON.stringify({
            edition_ids: made.slice(0, 4).map((e) => e.id),
          }),
        });
        const body = await response.json();
        const elapsed = performance.now() - started;
        expect(response.status).toBe(200);
        expect(body.prices.map((row: any) => row.status)).toEqual([
          "quote",
          "quote",
          "quote",
          "quote",
        ]);
        const cost = await anonymousFrom(
          G1,
          costPath(tokens.C, 1),
          "198.51.100.250"
        );
        expect(cost.status).toBe(200);
        if (n === 0) continue; // warm-up
        editionTimes.push(elapsed);
        costTimes.push(cost.elapsed);
      }
      const editionP95 = percentile(editionTimes, 0.95);
      const costP95 = percentile(costTimes, 0.95);
      metric(
        `cached prices one at a time: edition route p95 ${editionP95.toFixed(0)} ms (bound 500); published cost p95 ${costP95.toFixed(0)} ms`
      );
      expect(editionP95).toBeLessThan(500);

      const names = ["A", "B", "C"] as const;
      const burst = async (prefix: string) =>
        Promise.all(
          Array.from({ length: 100 }, async (_, i) => {
            const name = names[i % 3];
            const answer = await anonymousFrom(
              i % 2 ? G1 : G0,
              costPath(tokens[name], 1),
              `${prefix}.${i + 1}`
            );
            return { name, ...answer };
          })
        );
      const check = (
        answers: Awaited<ReturnType<typeof burst>>,
        hard: boolean
      ) => {
        for (const answer of answers) {
          expect(answer.status, JSON.stringify(answer.json)).toBe(200);
          const want = expected[answer.name];
          expect(answer.json).toMatchObject({
            status: "priced",
            total_copies: want.total,
            priced_copies: want.priced,
            amount: want.amount,
            fallback_copies: hard ? want.fallback : "0",
          });
          expect(answer.elapsed).toBeLessThanOrEqual(3_500);
        }
      };
      const launchesBefore = launches();

      // 100 callers, every row cached: no work, no launch.
      const cached = await burst("198.51.100");
      check(cached, false);
      const times = cached.map((a) => a.elapsed);
      expect(Object.keys((await scheduler()).jobs)).toEqual([]);
      metric(
        `100 simultaneous callers, cached: p50 ${percentile(times, 0.5).toFixed(0)} ms, p95 ${percentile(times, 0.95).toFixed(0)} ms, max ${Math.max(...times).toFixed(0)} ms (bound 3500)`
      );

      // 100 callers again (new addresses), the five Editions A and B share now a day old: one job each, whoever asks.
      await seedQuotes(
        made
          .slice(10, 15)
          .map((e) => [e, "0.25", 25 * 3_600_000, iso(3_600_000)])
      );
      await resetScheduler(0);
      const hard = await burst("203.0.113");
      check(hard, true);
      const waited = hard.filter(
        (a) => a.name !== "C" && a.elapsed >= 2_000
      ).length;
      const after = await scheduler();
      const jobs = Object.entries(after.jobs) as Array<[string, any]>;
      expect(jobs.map(([key]) => key).sort()).toEqual(
        made
          .slice(10, 15)
          .map((e) => `${e.ref}:${e.revision}`)
          .sort()
      );
      for (const [, job] of jobs)
        expect(job.caller).toMatch(/^anon:[0-9a-f]{32}$/);
      expect(waited).toBeGreaterThanOrEqual(1);
      expect(waited).toBeLessThanOrEqual(32);
      expect(launches() - launchesBefore).toBeLessThanOrEqual(2);
      const queueAge = Math.max(
        ...jobs.map(([, job]) => Date.now() - job.admitted_ms)
      );
      const hardTimes = hard.map((a) => a.elapsed);
      metric(
        `100 simultaneous callers, 5 shared day-old Editions: jobs ${jobs.length} for ${hard.filter((a) => a.name !== "C").length} accesses; waited ${waited} (cap 32); launches ${launches() - launchesBefore} (cap 2); oldest queued job ${queueAge} ms; p50 ${percentile(hardTimes, 0.5).toFixed(0)} ms, p95 ${percentile(hardTimes, 0.95).toFixed(0)} ms, max ${Math.max(...hardTimes).toFixed(0)} ms; stats ${JSON.stringify(after.stats)}`
      );
      expect(wakeups).toEqual(baseline);
    }
  );
});
