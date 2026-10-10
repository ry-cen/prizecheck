import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer as netServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";

// Two gateways, two APIs, one PostgreSQL database and one record store (the transactional HTTP relay), with the runner
// launcher replaced by the CI recorder: admission is exercised end to end and nothing ever fetches a price. Caps are
// asserted twice: by the labels the browser would see and by the scheduler record read back from the store (plus the
// relay's log of every committed scheduler version).
const admin = new Pool({ connectionString: process.env.DATABASE_URL });
const database = "tcg_price_refresh_" + randomUUID().replaceAll("-", "");
const directory = mkdtempSync(join(tmpdir(), "tcg-price-refresh-"));
const origin = process.env.TEST_ORIGIN || "http://localhost:5173";
const secret = process.env.INTERNAL_AUTH_SECRET!;
const OWNER_EMAIL = "owner@example.test";
const TOKEN = "conformance-secret";
const SCHEDULER = "admission:price:scheduler";
const LEASES = ["lease:price:runner:0", "lease:price:runner:1"];
const SOURCE_BACKOFF = "backoff:price:source";
const MIN = 60_000;
const HOUR = 3_600_000;

let pool: Pool;
let relayUrl = "";
let user = ""; // the signed-in user id; its caller is user:<id>
let cookie = "";
const children: ChildProcess[] = [];
const gateways: string[] = [];
const apis: string[] = [];
const launchLog = join(directory, "launches.log");
const commitLog = join(directory, "scheduler-commits.log");
const faultFile = join(directory, "faults", "delay-transact");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = netServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
const hex = (bytes: number) => randomBytes(bytes).toString("hex");

async function waitFor<T>(
  probe: () => Promise<T | false | null | undefined>,
  what: string,
  limit = 4_000
): Promise<T> {
  const end = performance.now() + limit;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (performance.now() > end)
      throw new Error("Timed out waiting for " + what);
    await sleep(20);
  }
}

// ---------------------------------------------------------------- the record store, over the relay
type Row = { version: string; value: any };
async function relay(action: string, body: object) {
  const response = await fetch(`${relayUrl}/records/${action}`, {
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
async function read(keys: string[]): Promise<Record<string, Row>> {
  return (await relay("read", { keys, generation: null })).records;
}
async function cas(
  keys: string[],
  change: (rows: Record<string, Row>) => Record<string, unknown>
) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const rows = await read(keys);
    const changes = change(rows);
    const expected = Object.fromEntries(
      Object.keys(changes).map((key) => [key, rows[key].version])
    );
    const done = await relay("transact", {
      expected,
      changes,
      operation_id: "test-" + hex(8),
    });
    if (done.committed) return;
  }
  throw new Error("could not commit to the record store");
}
const scheduler = async () => (await read([SCHEDULER]))[SCHEDULER].value;
const resultKey = (ref: string, revision = 1) => `result:${ref}:${revision}`;
const quoteKey = (ref: string, revision = 1) => `quote:${ref}:${revision}`;
const workKey = (ref: string, revision = 1) => `work:${ref}:${revision}`;

const emptyScheduler = () => ({
  v: 1,
  bucket: { milli: 8000, at_ms: Date.now() },
  interactive: {} as Record<string, { caller: string; until_ms: number }>,
  jobs: {} as Record<string, any>,
  fifo: {} as Record<string, string[]>,
  ring: [] as string[],
  cursor: 0,
  source: {},
  ledger: { interval: 0, count: 0 },
  stats: { admitted: 0, joined: 0, refused: {}, expired: 0, fenced: 0 },
});
function addJobs(
  sched: ReturnType<typeof emptyScheduler>,
  caller: string,
  count: number
) {
  const now = Date.now();
  for (let n = 0; n < count; n++) {
    const id = `${hex(24)}:1`;
    sched.jobs[id] = {
      caller,
      card: "foreign-card",
      admitted_ms: now,
      expires_ms: now + 60_000,
      state: "queued",
      slot: null,
      owner: null,
      attempt: null,
    };
    (sched.fifo[caller] ??= []).push(id);
  }
  if (!sched.ring.includes(caller)) sched.ring.push(caller);
}
const putScheduler = (sched: unknown) =>
  cas([SCHEDULER], () => ({ [SCHEDULER]: sched }));

/** A clean store for one test: no scheduler, leases or source backoff. A release still in flight from the previous
 * test finds its permit gone and writes nothing. */
async function reset() {
  await cas([SCHEDULER, ...LEASES, SOURCE_BACKOFF], () => ({
    [SCHEDULER]: null,
    [LEASES[0]]: null,
    [LEASES[1]]: null,
    [SOURCE_BACKOFF]: null,
  }));
  writeFileSync(launchLog, "");
}
const launches = () =>
  readFileSync(launchLog, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
const commits = () =>
  existsSync(commitLog)
    ? readFileSync(commitLog, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];

// ---------------------------------------------------------------- Editions and quotes
type Edition = { id: string; ref: string; card: string };
let sequence = 0;
let activation = "";
async function editions(count: number): Promise<Edition[]> {
  const made: Edition[] = [];
  for (let n = 0; n < count; n++) {
    sequence++;
    const card = `gw-card-${sequence}`;
    const identity = (
      await pool.query(
        "INSERT INTO catalog_identity(identity_key,display_name) VALUES ($1,$2) RETURNING id",
        [`price-refresh-${sequence}`, `Refresh Card ${sequence}`]
      )
    ).rows[0].id;
    const printing = (
      await pool.query(
        "INSERT INTO catalog_printing(source,source_id,identity_id) VALUES ('tcgdex',$1,$2) RETURNING id",
        [card, identity]
      )
    ).rows[0].id;
    const edition = (
      await pool.query(
        `INSERT INTO catalog_edition(printing_id,descriptor_key,descriptor) VALUES ($1,'normal','{"finish":"normal"}') RETURNING id,public_ref`,
        [printing]
      )
    ).rows[0];
    await pool.query(
      `UPDATE catalog_edition_metadata SET mapping_state='verified',mapping_reason=NULL,product_id=$2,quote_variant='normal',
       mapping_basis='matching_rule',matching_activation_id=$3,auto_closed=true WHERE edition_id=$1`,
      [edition.id, 900_000 + sequence, activation]
    );
    made.push({ id: edition.id, ref: edition.public_ref, card });
  }
  return made;
}
const isoAgo = (ms: number) =>
  new Date(Math.floor((Date.now() - ms) / 1000) * 1000).toISOString();

type Seed =
  | { kind: "quote"; ageMs: number; amount?: string }
  | { kind: "absent"; ageMs: number }
  | { kind: "garbled" }
  | { kind: "unknown" };
async function seed(edition: Edition, how: Seed) {
  if (how.kind === "unknown") return;
  const keys = [resultKey(edition.ref), quoteKey(edition.ref)];
  const quote = (amount: string) => ({
    attempt: 1,
    amount,
    currency: "USD",
    source: "tcgdex",
    card: edition.card,
    variant: "normal",
    provider_updated_at: isoAgo(24 * HOUR),
  });
  await cas(keys, () => {
    if (how.kind === "absent")
      return {
        [keys[0]]: {
          state: "absent",
          attempt: 1,
          checked_at: isoAgo(how.ageMs),
          expires_at: new Date(Date.now() + HOUR - how.ageMs).toISOString(),
        },
      };
    const checked = how.kind === "garbled" ? "garbage" : isoAgo(how.ageMs);
    return {
      [keys[0]]: { state: "quote", attempt: 1, checked_at: checked },
      [keys[1]]: quote(how.kind === "quote" ? (how.amount ?? "0.43") : "0.43"),
    };
  });
}

// ---------------------------------------------------------------- the gateways
type Price = {
  edition_id: string;
  status: string;
  reason: string | null;
  amount: string | null;
  checked_at: string | null;
  refresh: string | null;
};
async function prices(replica: 0 | 1, ids: string[], session = cookie) {
  const started = performance.now();
  const response = await fetch(gateways[replica] + "/api/prices/editions", {
    method: "POST",
    headers: { origin, "content-type": "application/json", cookie: session },
    body: JSON.stringify({ edition_ids: ids }),
  });
  const body = await response.json();
  const elapsed = performance.now() - started;
  const rows: Record<string, Price> = {};
  for (const row of body.prices ?? []) rows[row.edition_id] = row;
  return { status: response.status, elapsed, rows, body };
}
const label = (rows: Record<string, Price>, e: Edition) => rows[e.id].refresh;

async function api(
  replica: 0 | 1,
  method: string,
  path: string,
  body?: object
) {
  return fetch(gateways[replica] + path, {
    method,
    headers: { origin, "content-type": "application/json", cookie },
    body: body ? JSON.stringify(body) : undefined,
  });
}

/** The maintainer decision endpoint, with a fresh approval code issued the way the owner flow does. */
async function decide(
  replica: 0 | 1,
  edition: Edition,
  decision: string,
  reviewed?: object
) {
  const evidence = await (
    await api(
      replica,
      "GET",
      `/api/admin/catalog-metadata/editions/${edition.id}`
    )
  ).json();
  const target = `edition:${edition.id}`;
  const hash = createHmac("sha256", secret)
    .update(`${user}:${target}:resolve_metadata:123456`)
    .digest("hex");
  await pool.query(
    `INSERT INTO catalog_approval_code(owner_id,metadata_target,action,code_hash,expires_at)
     VALUES ($1,$2,'resolve_metadata',$3,now()+interval '5 minutes')`,
    [user, target, hash]
  );
  return api(replica, "POST", "/api/admin/catalog-metadata/decisions", {
    target: "marketplace",
    printing_id: evidence.printing_id,
    edition_id: edition.id,
    decision,
    basis_revision: evidence.basis_revision,
    evidence_digest: evidence.evidence_digest,
    evidence_url: "https://example.org/evidence",
    reason: "Mapping changed while a price was being refreshed",
    report_ids: [],
    code: "123456",
    ...(reviewed ? { reviewed_value: reviewed } : {}),
  });
}

function spawnProcess(command: string, args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(command, args, { env, stdio: "ignore" });
  children.push(child);
  return child;
}

beforeAll(async () => {
  await admin.query(`CREATE DATABASE "${database}"`);
  const connection = new URL(process.env.DATABASE_URL!);
  connection.pathname = "/" + database;
  pool = new Pool({ connectionString: connection.toString() });
  const base = {
    ...process.env,
    DATABASE_URL: connection.toString(),
    MAIL_MODE: "file",
    MAIL_FILE: join(directory, "mail"),
    SIGNUP_MODE: "local-public",
    NODE_ENV: "test",
    OWNER_EMAIL,
    PUBLIC_ORIGIN: origin,
  };
  await new Promise<void>((resolve, reject) => {
    spawn(".venv/bin/python", ["scripts/migrate.py"], {
      env: base,
      stdio: "ignore",
    }).on("exit", (status) =>
      status === 0 ? resolve() : reject(new Error("Migration failed"))
    );
  });

  // The relay: the records store every API shares. Its port arrives on stdout.
  mkdirSync(join(directory, "faults"), { recursive: true });
  const relay_ = spawn(
    ".venv/bin/python",
    [
      "-c",
      `import sys
from public_records_fixture import serve_relay
class Out:
    def send(self, port): print(port, flush=True)
    def close(self): pass
serve_relay({'adapter': 'http', 'directory': sys.argv[1]}, Out())`,
      directory,
    ],
    {
      env: { ...base, PYTHONPATH: "api:api/tests" },
      stdio: ["ignore", "pipe", "ignore"],
    }
  );
  children.push(relay_);
  const port = await new Promise<number>((resolve, reject) => {
    relay_.stdout!.once("data", (chunk) =>
      resolve(Number(String(chunk).trim()))
    );
    relay_.once("exit", () => reject(new Error("relay exited")));
  });
  relayUrl = `http://127.0.0.1:${port}`;
  await relay("initialize", {});

  const apiEnv = (index: number) => ({
    ...base,
    PYTHONPATH:
      join(process.cwd(), "api/tests/catalog_process_fixture") +
      ":" +
      join(process.cwd(), "api"),
    PUBLIC_PROJECTION_ADAPTER: "http",
    PUBLIC_PROJECTION_URL: relayUrl,
    PUBLIC_PROJECTION_TOKEN: TOKEN,
    PRICE_FIXTURE_LAUNCHER: "record",
    PRICE_FIXTURE_LAUNCH_LOG: launchLog,
    CATALOG_PROCESS_FIXTURE_DIR: "",
    PRICE_RUNNER_LOCK_DIR: "",
    API_INDEX: String(index),
  });
  for (let index = 0; index < 2; index++) {
    const apiPort = await freePort();
    const gatewayPort = await freePort();
    spawnProcess(
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
      apiEnv(index) as NodeJS.ProcessEnv
    );
    spawnProcess("node", ["--import", "tsx", "auth/src/server.ts"], {
      ...base,
      AUTH_PORT: String(gatewayPort),
      API_ORIGIN: `http://127.0.0.1:${apiPort}`,
    });
    apis.push(`http://127.0.0.1:${apiPort}`);
    gateways.push(`http://127.0.0.1:${gatewayPort}`);
  }
  for (const [index, url] of apis.entries())
    await waitFor(
      async () => {
        try {
          return (
            (await fetch(url + "/api/health")).ok &&
            (await fetch(gateways[index] + "/auth/session")).ok
          );
        } catch {
          return false;
        }
      },
      "a gateway and its API",
      30_000
    );

  // Sign in once; the session is in PostgreSQL, so both gateways accept the cookie.
  const post = (path: string, body: object) =>
    fetch(gateways[0] + path, {
      method: "POST",
      headers: { origin, "content-type": "application/json", cookie },
      body: JSON.stringify(body),
    });
  expect(
    (await post("/auth/request-code", { email: OWNER_EMAIL })).status
  ).toBe(202);
  const code = JSON.parse(
    readFileSync(join(directory, "mail"), "utf8").trim().split("\n").at(-1)!
  ).otp;
  const signin = await post("/auth/verify-code", { email: OWNER_EMAIL, code });
  expect(signin.status).toBe(200);
  cookie = signin.headers.get("set-cookie")!.split(";")[0];
  user = (
    await pool.query('SELECT id FROM "user" WHERE email=$1', [OWNER_EMAIL])
  ).rows[0].id;
  await pool.query(
    "INSERT INTO inventory_owner(user_id) VALUES ($1) ON CONFLICT DO NOTHING",
    [user]
  );
  await pool.query(
    "INSERT INTO owner_binding(singleton,user_id) VALUES (true,$1) ON CONFLICT DO NOTHING",
    [user]
  );
  activation = (
    await pool.query(
      `INSERT INTO catalog_rule_activation(kind,reviewer_id,evidence_url,reason,clock_revision)
       VALUES ('marketplace_matching',$1,'https://example.org/rule','Fixture activation',1) RETURNING id`,
      [user]
    )
  ).rows[0].id;
}, 90_000);

afterAll(async () => {
  rmSync(faultFile, { force: true });
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await new Promise((resolve) => child.once("exit", resolve));
    }
  }
  await pool?.end();
  for (let n = 0; n < 50; n++) {
    const { rows } = await admin.query(
      "SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=$1",
      [database]
    );
    if (rows[0].count === 0) break;
    await sleep(100);
  }
  await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
  await admin.end();
  rmSync(directory, { recursive: true, force: true });
});

const caller = () => `user:${user}`;
const permits = (sched: any, who = caller()) =>
  Object.values<any>(sched?.interactive ?? {}).filter((p) => p.caller === who)
    .length;
const refsOf = (sched: any) =>
  Object.keys(sched?.jobs ?? {}).map((id) => id.split(":")[0]);

// ================================================================ AC2: bands through the gateway
describe("seeded eligibility times", () => {
  it("writes and contacts nothing for fresh rows, queues soft rows in the background and waits for hard ones, within three seconds", async () => {
    await reset();
    const fresh = await editions(2);
    await seed(fresh[0], { kind: "quote", ageMs: 59 * MIN });
    await seed(fresh[1], { kind: "absent", ageMs: 30 * MIN });
    const before = await read([SCHEDULER, ...LEASES]);
    const commitsBefore = commits().length;
    const quiet = await prices(
      0,
      fresh.map((e) => e.id)
    );
    expect(quiet.status).toBe(200);
    expect(fresh.map((e) => label(quiet.rows, e))).toEqual([null, null]);
    expect(quiet.rows[fresh[0].id].amount).toBe("0.43");
    expect(quiet.rows[fresh[1].id].reason).toBe("confirmed_absent");
    expect(quiet.elapsed).toBeLessThan(1_500);
    expect(await read([SCHEDULER, ...LEASES])).toEqual(before);
    expect(commits().length).toBe(commitsBefore);
    expect(launches()).toEqual([]);

    const [soft61, soft2359, softAbsent, hard2401, garbled, unknown] =
      await editions(6);
    await seed(soft61, { kind: "quote", ageMs: 61 * MIN });
    await seed(soft2359, { kind: "quote", ageMs: 23 * HOUR + 59 * MIN });
    await seed(softAbsent, { kind: "absent", ageMs: 61 * MIN });
    await seed(hard2401, {
      kind: "quote",
      ageMs: 24 * HOUR + MIN,
      amount: "1.25",
    });
    await seed(garbled, { kind: "garbled" });
    await seed(unknown, { kind: "unknown" });
    const all = [
      ...fresh,
      soft61,
      soft2359,
      softAbsent,
      hard2401,
      garbled,
      unknown,
    ];
    const response = await prices(
      1,
      all.map((e) => e.id)
    );
    expect(response.status).toBe(200);
    expect(response.elapsed).toBeLessThanOrEqual(3_000);
    expect(response.elapsed).toBeGreaterThan(2_000); // the hard rows used the wait window
    const rows = response.rows;
    expect(label(rows, fresh[0])).toBeNull();
    expect(label(rows, fresh[1])).toBeNull();
    for (const edition of [soft61, soft2359, softAbsent])
      expect(label(rows, edition)).toBe("background");
    for (const edition of [hard2401, garbled, unknown])
      expect(label(rows, edition)).toBe("timeout");
    // A timeout keeps the cached quote and its checked_at; nothing here fetched anything.
    expect(rows[hard2401.id].amount).toBe("1.25");
    expect(Date.parse(rows[hard2401.id].checked_at!)).toBeLessThan(
      Date.now() - 24 * HOUR
    );
    expect(rows[softAbsent.id].reason).toBe("confirmed_absent");
    expect(rows[unknown.id].reason).toBe("not_cached");
    // The scheduler agrees with the labels: exactly the six open rows were queued, none of the fresh ones.
    const sched = await scheduler();
    expect(refsOf(sched).sort()).toEqual(
      [soft61, soft2359, softAbsent, hard2401, garbled, unknown]
        .map((e) => e.ref)
        .sort()
    );
    expect(sched.stats.admitted).toBe(6);
    expect(
      Object.values<any>(sched.jobs).every((job) => job.state === "queued")
    ).toBe(true);
    expect(launches()).toHaveLength(2); // six queued jobs: a second slot is reserved too
  }, 20_000);

  it("answers refreshed, quickly, when a runner-like writer lands a quote mid-wait", async () => {
    await reset();
    const [target] = await editions(1);
    await seed(target, { kind: "quote", ageMs: 25 * HOUR, amount: "0.10" });
    const pending = prices(0, [target.id]);
    await waitFor(
      async () => refsOf(await scheduler()).includes(target.ref),
      "the admitted job"
    );
    await cas([resultKey(target.ref), quoteKey(target.ref)], () => ({
      [resultKey(target.ref)]: {
        state: "quote",
        attempt: 2,
        checked_at: new Date().toISOString(),
      },
      [quoteKey(target.ref)]: {
        attempt: 2,
        amount: "0.77",
        currency: "USD",
        source: "tcgdex",
        card: target.card,
        variant: "normal",
        provider_updated_at: isoAgo(HOUR),
      },
    }));
    const response = await pending;
    expect(label(response.rows, target)).toBe("refreshed");
    expect(response.rows[target.id].amount).toBe("0.77");
    expect(response.elapsed).toBeLessThan(2_400); // it did not sit out the whole window
  }, 20_000);
});

// ================================================================ AC3: the interactive caps across replicas
describe("interactive permits across two gateways and two APIs", () => {
  it("admits exactly two of four concurrent hard requests from one user alternating between replicas, even when commits are slow", async () => {
    await reset();
    const batch = await editions(4);
    mkdirSync(join(directory, "faults"), { recursive: true });
    writeFileSync(faultFile, "0.15"); // each store commit takes 150 ms, so the four admissions really overlap
    try {
      const fast: Awaited<ReturnType<typeof prices>>[] = [];
      const requests = batch.map((edition, n) =>
        prices(n % 2 === 0 ? 0 : 1, [edition.id]).then((r) => (fast.push(r), r))
      );
      // The two refused requests answer at once; the admitted two are still holding their permits in the wait.
      await waitFor(async () => fast.length >= 2, "the two refused requests");
      expect(fast.map((r) => r.elapsed).every((ms) => ms < 2_000)).toBe(true);
      for (const response of fast)
        expect(Object.values(response.rows).map((row) => row.refresh)).toEqual([
          "busy",
        ]);
      const midway = await scheduler();
      expect(permits(midway)).toBe(2);
      expect(Object.keys(midway.jobs)).toHaveLength(2);
      const results = await Promise.all(requests);
      const labels = results
        .map((r) => Object.values(r.rows)[0].refresh)
        .sort();
      expect(labels).toEqual(["busy", "busy", "timeout", "timeout"]);
      for (const response of results)
        expect(response.elapsed).toBeLessThanOrEqual(3_000);
    } finally {
      rmSync(faultFile, { force: true });
    }
    const after = await scheduler();
    expect(Object.keys(after.jobs)).toHaveLength(2);
    // Whatever order the commits landed in, no committed version ever held a third permit for the user.
    for (const line of commits())
      if (line) expect(permits(line)).toBeLessThanOrEqual(2);
    expect(launches()).toHaveLength(1); // two jobs, one slot, one launch
  }, 30_000);

  it("refuses further requests while two are held, adds no commit for them, and admits again once the permits are released", async () => {
    await reset();
    const batch = await editions(5);
    const first = prices(0, [batch[0].id]);
    await waitFor(
      async () => permits(await scheduler()) === 1,
      "the first permit"
    );
    const second = prices(1, [batch[1].id]);
    await waitFor(
      async () => permits(await scheduler()) === 2,
      "the second permit"
    );
    const held = commits().length;
    const refused = await Promise.all([
      prices(0, [batch[2].id]),
      prices(1, [batch[3].id]),
    ]);
    for (const response of refused) {
      expect(response.elapsed).toBeLessThan(2_000);
      expect(Object.values(response.rows)[0].refresh).toBe("busy");
    }
    expect(commits().length).toBe(held);
    const sched = await scheduler();
    expect(permits(sched)).toBe(2);
    expect(refsOf(sched).sort()).toEqual([batch[0].ref, batch[1].ref].sort());
    expect((await first).rows[batch[0].id].refresh).toBe("timeout");
    expect((await second).rows[batch[1].id].refresh).toBe("timeout");
    // The permits are released after the responses; then a third request is admitted.
    await waitFor(
      async () => permits(await scheduler()) === 0,
      "the permits' release"
    );
    const again = await prices(1, [batch[4].id]);
    expect(again.rows[batch[4].id].refresh).toBe("timeout");
    expect(refsOf(await scheduler())).toContain(batch[4].ref);
  }, 30_000);

  it("refuses the 33rd global permit: with 31 foreign permits two sends admit one and refuse one", async () => {
    await reset();
    const [one, two] = await editions(2);
    const sched = emptyScheduler();
    const until = Date.now() + 60_000;
    for (let n = 0; n < 31; n++)
      sched.interactive[`foreign-${n}`] = {
        caller: `user:foreign-${Math.floor(n / 2)}`,
        until_ms: until,
      };
    await putScheduler(sched);
    const results: Awaited<ReturnType<typeof prices>>[] = [];
    const sends = [prices(0, [one.id]), prices(1, [two.id])].map((p) =>
      p.then((r) => (results.push(r), r))
    );
    await waitFor(async () => results.length >= 1, "the refused send");
    expect(Object.values(results[0].rows)[0].refresh).toBe("busy");
    const midway = await scheduler();
    expect(Object.keys(midway.interactive)).toHaveLength(32); // 31 foreign + the one admitted send
    expect(permits(midway)).toBe(1);
    expect(Object.keys(midway.jobs)).toHaveLength(1);
    const done = await Promise.all(sends);
    expect(done.map((r) => Object.values(r.rows)[0].refresh).sort()).toEqual([
      "busy",
      "timeout",
    ]);
    // At 32 foreign permits both sends are refused and neither takes a job.
    await reset();
    sched.interactive["foreign-31"] = {
      caller: "user:foreign-16",
      until_ms: Date.now() + 60_000,
    };
    await putScheduler(sched);
    const full = await Promise.all([prices(0, [one.id]), prices(1, [two.id])]);
    for (const response of full) {
      expect(Object.values(response.rows)[0].refresh).toBe("busy");
      expect(response.elapsed).toBeLessThan(2_000);
    }
    expect(Object.keys((await scheduler()).jobs)).toHaveLength(0);
  }, 30_000);
});

// ================================================================ AC10: replicas, duplicates, full queue
describe("replicas, duplicates and a full queue", () => {
  it("coalesces the same Edition across replicas and duplicates in a body into one job with an unchanged lifetime, and counts the permits per user across replicas", async () => {
    await reset();
    const [shared, other] = await editions(2);
    await seed(shared, { kind: "quote", ageMs: 30 * HOUR });
    const first = prices(0, [shared.id, shared.id]);
    const job = await waitFor(
      async () => (await scheduler())?.jobs?.[`${shared.ref}:1`],
      "the first job"
    );
    const second = prices(1, [shared.id]);
    await waitFor(
      async () => permits(await scheduler()) === 2,
      "the joined request's permit"
    );
    const sched = await scheduler();
    expect(Object.keys(sched.jobs)).toEqual([`${shared.ref}:1`]); // one job, not two
    expect(sched.jobs[`${shared.ref}:1`].expires_ms).toBe(job.expires_ms);
    expect(sched.jobs[`${shared.ref}:1`].admitted_ms).toBe(job.admitted_ms);
    expect(sched.stats.admitted).toBe(1);
    expect(sched.stats.joined).toBe(1);
    // The user's third request, on whichever replica, finds both permits taken.
    const third = await prices(0, [other.id]);
    expect(Object.values(third.rows)[0].refresh).toBe("busy");
    const [a, b] = await Promise.all([first, second]);
    expect(Object.keys(a.rows)).toEqual([shared.id]); // the duplicate id is one row
    expect(a.rows[shared.id].refresh).toBe("timeout");
    expect(b.rows[shared.id].refresh).toBe("timeout");
    expect(a.rows[shared.id].amount).toBe("0.43");
    const finished = await scheduler();
    expect(finished.jobs[`${shared.ref}:1`].expires_ms).toBe(job.expires_ms);
    expect(launches()).toHaveLength(1);
  }, 30_000);

  it("refuses everything when the global queue holds 256 jobs and writes no job; at 255 it admits one of two", async () => {
    await reset();
    const [one, two] = await editions(2);
    const full = emptyScheduler();
    for (let n = 0; n < 8; n++) addJobs(full, `user:queue-${n}`, 32);
    expect(Object.keys(full.jobs)).toHaveLength(256);
    await putScheduler(full);
    const refused = await prices(0, [one.id, two.id]);
    expect(Object.values(refused.rows).map((r) => r.refresh)).toEqual([
      "busy",
      "busy",
    ]);
    expect(refused.elapsed).toBeLessThan(2_000);
    const stored = await scheduler();
    expect(Object.keys(stored.jobs).sort()).toEqual(
      Object.keys(full.jobs).sort()
    );
    expect(
      (await read([workKey(one.ref), workKey(two.ref)]))[workKey(one.ref)].value
    ).toBeNull();

    await reset();
    const almost = emptyScheduler();
    for (let n = 0; n < 7; n++) addJobs(almost, `user:queue-${n}`, 32);
    addJobs(almost, "user:queue-7", 31);
    expect(Object.keys(almost.jobs)).toHaveLength(255);
    await putScheduler(almost);
    const response = await prices(1, [one.id, two.id]);
    const labels = [one, two].map((e) => label(response.rows, e));
    expect(labels.filter((l) => l === "timeout")).toHaveLength(1);
    expect(labels.filter((l) => l === "busy")).toHaveLength(1);
    const admitted = [one, two].find(
      (e) => label(response.rows, e) === "timeout"
    )!;
    const after = await scheduler();
    expect(Object.keys(after.jobs)).toHaveLength(256);
    expect(refsOf(after)).toContain(admitted.ref);
    expect(after.jobs[`${admitted.ref}:1`].caller).toBe(caller());
    expect(response.elapsed).toBeLessThanOrEqual(3_000);
  }, 30_000);

  it("holds the per-user 32 job cap whichever replica asks", async () => {
    await reset();
    const [one] = await editions(1);
    const mine = emptyScheduler();
    addJobs(mine, caller(), 32);
    await putScheduler(mine);
    const response = await prices(1, [one.id]);
    expect(label(response.rows, one)).toBe("busy");
    const sched = await scheduler();
    expect(Object.keys(sched.jobs)).toHaveLength(32);
    expect(refsOf(sched)).not.toContain(one.ref);
    // Another user's cap is separate: a foreign job set does not block this user (positive control).
    await reset();
    const foreign = emptyScheduler();
    addJobs(foreign, "user:someone-else", 32);
    await putScheduler(foreign);
    const open = await prices(0, [one.id]);
    expect(label(open.rows, one)).toBe("timeout");
  }, 30_000);

  it("labels everything busy while the source is in backoff, and writes no job", async () => {
    await reset();
    const [one] = await editions(1);
    const now = Date.now();
    await cas([SOURCE_BACKOFF], () => ({
      [SOURCE_BACKOFF]: {
        v: 1,
        retry_ms: now + 600_000,
        reason: "rate_limited",
        set_ms: now,
      },
    }));
    const response = await prices(0, [one.id]);
    expect(label(response.rows, one)).toBe("backoff");
    expect(response.elapsed).toBeLessThan(2_000);
    expect(refsOf(await scheduler())).toEqual([]);
    expect(launches()).toEqual([]);
  }, 20_000);
});

// ================================================================ AC10: the mapping changes while a request waits
describe("mapping invalidation mid-wait", () => {
  async function midWait(
    replica: 0 | 1,
    edition: Edition,
    change: () => Promise<void>
  ) {
    const before = await read([resultKey(edition.ref), quoteKey(edition.ref)]);
    const pending = prices(replica, [edition.id]);
    await waitFor(
      async () => refsOf(await scheduler()).includes(edition.ref),
      "the admitted job"
    );
    await change();
    const response = await pending;
    // Nothing was written under the old revision's result or quote, whatever the answer says.
    expect(await read([resultKey(edition.ref), quoteKey(edition.ref)])).toEqual(
      before
    );
    return response;
  }

  it("answers unverified, with no old-revision quote, when the maintainer unmaps the Edition on the other replica", async () => {
    await reset();
    const [target] = await editions(1);
    const response = await midWait(0, target, async () => {
      const decision = await decide(1, target, "unmap");
      expect(decision.status, await decision.clone().text()).toBe(200);
    });
    const row = response.rows[target.id];
    expect([row.status, row.reason, row.amount]).toEqual([
      "unavailable",
      "unverified",
      null,
    ]);
    expect(response.elapsed).toBeLessThanOrEqual(3_000);
    const next = (
      await pool.query(
        "SELECT mapping_revision FROM catalog_edition_metadata WHERE edition_id=$1",
        [target.id]
      )
    ).rows[0];
    expect(Number(next.mapping_revision)).toBe(2);
  }, 30_000);

  it("answers not_cached when a correction moves the revision, and a follow-up admits only the new revision", async () => {
    await reset();
    const [target] = await editions(1);
    await pool.query(
      `UPDATE catalog_edition_metadata SET mapping_candidate=$2 WHERE edition_id=$1`,
      [
        target.id,
        JSON.stringify({
          correspondence: "source_candidate",
          candidate: {
            pricing: {
              tcgplayer: { normal: { productId: 900_000 + sequence } },
            },
          },
        }),
      ]
    );
    const response = await midWait(1, target, async () => {
      const decision = await decide(0, target, "correct", {
        product_id: 900_000 + sequence,
        quote_variant: "normal",
      });
      expect(decision.status, await decision.clone().text()).toBe(200);
    });
    expect(response.rows[target.id].reason).toBe("not_cached");
    expect(response.rows[target.id].amount).toBeNull();
    const revision = (
      await pool.query(
        "SELECT mapping_revision FROM catalog_edition_metadata WHERE edition_id=$1",
        [target.id]
      )
    ).rows[0].mapping_revision;
    expect(Number(revision)).toBe(2);
    await waitFor(
      async () => permits(await scheduler()) === 0,
      "the permit's release"
    );
    const admittedBefore = (await scheduler()).stats.admitted;
    const follow = await prices(0, [target.id]);
    expect(label(follow.rows, target)).toBe("timeout");
    const sched = await scheduler();
    expect(sched.stats.admitted).toBe(admittedBefore + 1);
    expect(Object.keys(sched.jobs).sort()).toEqual([
      `${target.ref}:1`,
      `${target.ref}:2`,
    ]);
    expect(
      (await read([workKey(target.ref, 2)]))[workKey(target.ref, 2)].value
    ).not.toBeNull();
    // Nothing is ever written under revision 1 or 2 by admission: no result, no quote.
    const records = await read([
      resultKey(target.ref, 1),
      quoteKey(target.ref, 1),
      resultKey(target.ref, 2),
      quoteKey(target.ref, 2),
    ]);
    expect(Object.values(records).map((r) => r.value)).toEqual([
      null,
      null,
      null,
      null,
    ]);
  }, 40_000);

  it("answers quarantined when the catalog quarantines the Edition mid-wait (the transition an import makes; no HTTP route does)", async () => {
    await reset();
    const [target] = await editions(1);
    const response = await midWait(1, target, async () => {
      await pool.query(
        "UPDATE catalog_edition_metadata SET mapping_state='quarantined',mapping_reason='candidate_changed' WHERE edition_id=$1",
        [target.id]
      );
    });
    const row = response.rows[target.id];
    expect([row.status, row.reason, row.amount]).toEqual([
      "unavailable",
      "quarantined",
      null,
    ]);
    expect(response.elapsed).toBeLessThanOrEqual(3_000);
  }, 30_000);
});

// ================================================================ invariant 9, over everything above
describe("every committed scheduler version", () => {
  it("respected every cap, and every launch named a real slot with an owner", async () => {
    const lines = commits().filter((line) => line !== null);
    expect(lines.length).toBeGreaterThan(10);
    for (const sched of lines) {
      expect(Object.keys(sched.interactive).length).toBeLessThanOrEqual(32);
      expect(Object.keys(sched.jobs).length).toBeLessThanOrEqual(256);
      const perPermit: Record<string, number> = {};
      for (const permit of Object.values<any>(sched.interactive))
        perPermit[permit.caller] = (perPermit[permit.caller] ?? 0) + 1;
      expect(Math.max(0, ...Object.values(perPermit))).toBeLessThanOrEqual(2);
      const perJob: Record<string, number> = {};
      for (const job of Object.values<any>(sched.jobs))
        perJob[job.caller] = (perJob[job.caller] ?? 0) + 1;
      expect(Math.max(0, ...Object.values(perJob))).toBeLessThanOrEqual(32);
    }
  });
});
