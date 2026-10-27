import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { execFileSync, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:net";
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launch, waitForServer, waitUntil } from "./support/servers";

// The gate's stacks run with email-code sign-in off. These tests cover email codes, so they get their own gateway with
// EMAIL_SIGN_IN=on, on the stack's database, API, mail file and public origin.
let base = "";
let codeGateway: ChildProcess | undefined;
beforeAll(async () => {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise((resolve) => probe.close(resolve));
  base = `http://127.0.0.1:${port}`;
  codeGateway = launch("node", ["--import", "tsx", "auth/src/server.ts"], {
    ...process.env,
    AUTH_PORT: String(port),
    EMAIL_SIGN_IN: "on",
  });
  const ready = await waitForServer(
    [codeGateway],
    base + "/auth/session",
    (r) => r.ok
  );
  if (!ready) throw new Error("Email-code gateway did not start");
  await ready.body?.cancel();
}, 30_000);
afterAll(async () => {
  if (codeGateway && codeGateway.exitCode === null) {
    codeGateway.kill();
    await new Promise((resolve) => codeGateway!.once("exit", resolve));
  }
});
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

  // The timeout covers the readiness deadline in waitForServer plus sign-in and a cold Python import on a loaded host.
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
      printing_name: "Pikachu",
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
    // Enough Listed decks that discovery returns a real next-page cursor.
    const listed = Object.fromEntries(
      Array.from({ length: 31 }, (_, index) => [
        `L${String(index).padStart(31, "0")}`,
        {
          visibility: "listed",
          snapshot: {
            ...snapshot,
            title: `Listed ${index}`,
            published_at: `2026-02-01T00:00:${String(index).padStart(2, "0")}Z`,
          },
        },
      ])
    );
    writeFileSync(
      projection,
      JSON.stringify({
        format: 1,
        revision: 0,
        decks: { [token]: { visibility: "unlisted", snapshot }, ...listed },
      })
    );
    // Discover lists only decks legal in their Target Format (#182). These snapshots have no format records, so the
    // API loads the CI-only fixture that lists them anyway (api/tests/catalog_process_fixture/publish_gate_fixture.py).
    const exempt = join(directory, "exempt");
    mkdirSync(join(exempt, "discover-exempt"), { recursive: true });
    for (const listedToken of Object.keys(listed))
      writeFileSync(join(exempt, "discover-exempt", listedToken), "");
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
          {
            // Only the publish gate fixture: none of the price or catalog fixtures the same directory carries.
            ...Object.fromEntries(
              Object.entries(environment).filter(
                ([key]) =>
                  !key.startsWith("PRICE_FIXTURE_") &&
                  key !== "PRICE_RUNNER_LOCK_DIR" &&
                  key !== "CATALOG_PROCESS_FIXTURE_DIR"
              )
            ),
            PYTHONPATH:
              join(process.cwd(), "api/tests/catalog_process_fixture") +
              ":" +
              join(process.cwd(), "api"),
            PUBLISH_GATE_EXEMPT_DIR: exempt,
          }
        ),
        launch("node", ["--import", "tsx", "auth/src/server.ts"], {
          ...environment,
          AUTH_PORT: String(gatewayPort),
          API_ORIGIN: `http://127.0.0.1:${apiPort}`,
        })
      );
      const gateway = `http://127.0.0.1:${gatewayPort}`;
      // The gateway usually listens before the API does and answers 503 until it can reach it.
      const probe = await waitForServer(
        children,
        gateway + "/api/public/discovery",
        (response) => response.status === 200
      );
      await probe?.body?.cancel();
      expect(probe?.status).toBe(200);
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
        "target_format",
        "title",
        "total",
        "version",
      ]);
      // A snapshot written before #183 reads the display facts the Published Deck page groups rows by as null.
      expect(Object.keys(shown.identities[0].editions[0]).sort()).toEqual(
        [
          ...Object.keys(edition),
          "card_kind",
          "trainer_type",
          "evolves_from",
          "evolution_root",
          "evolution_stage",
        ].sort()
      );
      expect(shown.identities[0].editions[0]).toMatchObject({
        edition_ref: edition.edition_ref,
        printing_ref: edition.printing_ref,
        printing_name: edition.printing_name,
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
      // Writing catalog, quote and result records changes no snapshot, discovery revision or cursor.
      const firstPage = await (
        await read(valid, "/api/public/discovery")
      ).json();
      expect(firstPage.decks).toHaveLength(30);
      expect(firstPage.next_cursor).toBeTruthy();
      const before = {
        projection: readFileSync(projection, "utf8"),
        deck: await (await read(valid)).text(),
      };
      execFileSync(
        ".venv/bin/python",
        [
          "-c",
          `import time
from app.public_projection import public_record_store
from app.public_records import catalog_edition_key, quote_key, result_key
store = public_record_store()
store.initialize(deadline=time.monotonic() + 5)
ref = '${edition.edition_ref}'
keys = [catalog_edition_key(ref), quote_key(ref, 1), result_key(ref, 1)]
rows = store.read_records(keys, deadline=time.monotonic() + 5).records
assert store.compare_and_swap({k: rows[k].version for k in keys}, {
  keys[0]: {'edition_ref': ref, 'printing_ref': '${edition.printing_ref}', 'descriptor': {'label': 'Unspecified Variant'}, 'revision': 1,
    'marketplace': {'state': 'unverified', 'reason': 'unspecified_variant', 'mapping_revision': 0, 'product_id': None, 'quote_lookup': None}},
  keys[1]: {'attempt': 1, 'amount': '1.00'}, keys[2]: {'state': 'quote', 'attempt': 1}}, deadline=time.monotonic() + 5)`,
        ],
        { cwd: process.cwd(), env: { ...environment, PYTHONPATH: "api" } }
      );
      expect(readFileSync(projection, "utf8")).toBe(before.projection);
      expect(await (await read(valid)).text()).toBe(before.deck);
      const afterPage = await (
        await read(valid, "/api/public/discovery")
      ).json();
      expect(afterPage.revision).toBe(firstPage.revision);
      // Equal only because the record written is `unverified`: a verified Edition's cached quote would change a
      // listed deck's cost, and Discover reads the cost from the store.
      expect(afterPage).toEqual(firstPage);
      const next = await read(
        valid,
        `/api/public/discovery?cursor=${encodeURIComponent(firstPage.next_cursor)}`
      );
      expect(next.status).toBe(200);
      expect((await next.json()).decks).toHaveLength(1);
      expect(wakeups).toBe(baseline);
      // Controls: private routes do wake the databases, so the counter is live for both processes.
      const beforeApi = wakeups;
      expect(
        (await fetch(`http://127.0.0.1:${apiPort}/api/locations`)).status
      ).toBe(401);
      // The API counts the request in the background, after the response.
      expect(await waitUntil(() => wakeups > beforeApi)).toBe(true);
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
  }, 60_000);

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

  it("issues metadata approval codes only to the owner for existing, well-formed targets, and a code spends end to end", async () => {
    const ids = {
      identity: randomUUID(),
      printing: randomUUID(),
      edition: randomUUID(),
    };
    await pool.query(
      "INSERT INTO catalog_identity(id,identity_key,display_name) VALUES ($1,$2,'Gateway Probe')",
      [ids.identity, `gateway-probe-${ids.identity}`]
    );
    await pool.query(
      "INSERT INTO catalog_printing(id,source,identity_id) VALUES ($1,'manual',$2)",
      [ids.printing, ids.identity]
    );
    await pool.query(
      "INSERT INTO catalog_edition(id,printing_id,descriptor_key,descriptor) VALUES ($1,$2,'probe',$3)",
      [ids.edition, ids.printing, JSON.stringify({ finish: "normal" })]
    );
    // Earlier tests may have saturated the send limiter; code delivery is not what this test is about.
    const reset = () => pool.query("DELETE FROM auth_send_event");
    await reset();
    await post("/auth/request-code", { email });
    const signedIn = await post("/auth/verify-code", {
      email,
      code: latestCode(),
    });
    expect(signedIn.status).toBe(200);
    const cookie = signedIn.headers.get("set-cookie")!.split(";")[0];
    const userId = (
      await pool.query('SELECT id FROM "user" WHERE email=$1', [email])
    ).rows[0].id as string;
    const previous = (await pool.query("SELECT user_id FROM owner_binding"))
      .rows[0]?.user_id as string | undefined;
    await pool.query(
      "INSERT INTO inventory_owner(user_id) VALUES ($1),('gateway-non-owner') ON CONFLICT DO NOTHING",
      [userId]
    );
    const bind = async (id?: string) => {
      await pool.query("DELETE FROM owner_binding");
      if (id)
        await pool.query(
          "INSERT INTO owner_binding(singleton,user_id) VALUES (true,$1)",
          [id]
        );
    };
    await bind(userId);
    try {
      const approval = async (body: object) => {
        await reset();
        return post("/auth/approval-code", body, cookie);
      };
      const target = `edition:${ids.edition}`;
      const forms = [
        { metadataTarget: "edition:not-a-uuid", action: "resolve_metadata" },
        { metadataTarget: `printing:${ids.printing}`, action: "activate_rule" },
        {
          metadataTarget: "rule:live_derivation:1",
          action: "resolve_metadata",
        },
        { metadataTarget: "rule:unknown_rule:1", action: "activate_rule" },
        {
          metadataTarget: "rule:live_derivation:1234567",
          action: "activate_rule",
        },
        { metadataTarget: "rule:live_derivation:-1", action: "activate_rule" },
        { metadataTarget: target, action: "approve_printing" },
        // Card attribute corrections name a Printing, never an Edition or a rule.
        { metadataTarget: target, action: "correct_attributes" },
        {
          metadataTarget: "rule:live_derivation:1",
          action: "correct_attributes",
        },
        // Reprint Group reviews and identity merges name a Card Identity, and a Card Identity takes nothing else.
        {
          metadataTarget: `card_identity:${ids.identity}`,
          action: "resolve_metadata",
        },
        {
          metadataTarget: `card_identity:${ids.identity}`,
          action: "correct_attributes",
        },
        {
          metadataTarget: `printing:${ids.printing}`,
          action: "review_reprint_groups",
        },
        { metadataTarget: target, action: "merge_card_identities" },
        { metadataTarget: target, action: "resolve_catalog" },
        {
          metadataTarget: target,
          reportId: randomUUID(),
          action: "resolve_metadata",
        },
        {
          metadataTarget: target,
          reviewId: randomUUID(),
          action: "resolve_metadata",
        },
        { metadataTarget: 123, action: "resolve_metadata" },
        { metadataTarget: `${target} `, action: "resolve_metadata" },
      ];
      const count = async () =>
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM catalog_approval_code"
          )
        ).rows[0].n as number;
      const before = await count();
      for (const form of forms)
        expect((await approval(form)).status, JSON.stringify(form)).toBe(422);
      for (const missing of [
        `edition:${randomUUID()}`,
        `printing:${randomUUID()}`,
      ])
        expect(
          (
            await approval({
              metadataTarget: missing,
              action: "resolve_metadata",
            })
          ).status
        ).toBe(404);
      expect(
        (
          await approval({
            metadataTarget: `card_identity:${randomUUID()}`,
            action: "review_reprint_groups",
          })
        ).status
      ).toBe(404);
      expect(await count()).toBe(before);

      for (const [metadataTarget, action] of [
        [`card_identity:${ids.identity}`, "review_reprint_groups"],
        [`card_identity:${ids.identity}`, "merge_card_identities"],
        [`printing:${ids.printing}`, "correct_attributes"],
        [`printing:${ids.printing}`, "resolve_metadata"],
        ["rule:live_derivation:1", "activate_rule"],
        ["rule:marketplace_matching:0", "activate_rule"],
      ])
        expect((await approval({ metadataTarget, action })).status).toBe(202);
      const issued = await approval({
        metadataTarget: `edition:${ids.edition.toUpperCase()}`,
        action: "resolve_metadata",
      });
      expect(issued.status).toBe(202);
      const rows = await pool.query(
        "SELECT metadata_target,action,report_id,review_id FROM catalog_approval_code WHERE metadata_target IS NOT NULL ORDER BY created_at DESC LIMIT 4"
      );
      expect(rows.rows.map((row) => row.metadata_target).sort()).toEqual(
        [
          target,
          `printing:${ids.printing}`,
          "rule:live_derivation:1",
          "rule:marketplace_matching:0",
        ].sort()
      );
      expect(
        rows.rows.every(
          (row) => row.report_id === null && row.review_id === null
        )
      ).toBe(true);

      // The emailed code spends on exactly the decision it was issued for, through the gateway and API.
      const spend = latestCode();
      const shown = await fetch(
        `${base}/api/admin/catalog-metadata/editions/${ids.edition}`,
        { headers: { cookie } }
      );
      expect(shown.status).toBe(200);
      const item = await shown.json();
      const decide = (code: string) =>
        post(
          "/api/admin/catalog-metadata/decisions",
          {
            target: "marketplace",
            printing_id: ids.printing,
            edition_id: ids.edition,
            decision: "unmap",
            basis_revision: item.basis_revision,
            evidence_digest: item.evidence_digest,
            evidence_url: "https://example.org/gateway",
            reason: "Gateway round trip",
            report_ids: [],
            code,
          },
          cookie
        );
      expect((await decide("000000")).status).toBe(403);
      const decided = await decide(spend);
      expect(decided.status).toBe(200);
      expect((await decided.json()).state).toBe("unverified");
      expect((await decide(spend)).status).toBeGreaterThanOrEqual(403); // spent, and the basis moved
      const history = await fetch(
        `${base}/api/admin/catalog-metadata/editions/${ids.edition}/history`,
        { headers: { cookie } }
      );
      expect(
        (await history.json()).map((row: { decision: string }) => row.decision)
      ).toEqual(["unmap"]);

      // A collector never gets a code and cannot read or decide through the admin surface.
      const denials = async () =>
        Number(
          (
            await pool.query(
              "SELECT coalesce(max(count),0) AS n FROM operations_counter WHERE name='authorization_denials'"
            )
          ).rows[0].n
        );
      const codes = await count();
      await bind("gateway-non-owner");
      try {
        const counted = await denials();
        expect(
          (
            await approval({
              metadataTarget: target,
              action: "resolve_metadata",
            })
          ).status
        ).toBe(403);
        expect(
          (
            await approval({
              metadataTarget: "rule:live_derivation:1",
              action: "activate_rule",
            })
          ).status
        ).toBe(403);
        expect(await denials()).toBe(counted + 2);
        expect(
          (
            await fetch(`${base}/api/admin/catalog-metadata/queue`, {
              headers: { cookie },
            })
          ).status
        ).toBe(403);
        expect((await decide("123456")).status).toBe(403);
        expect(
          (
            await fetch(`${base}/api/admin/catalog-rules`, {
              headers: { cookie },
            })
          ).status
        ).toBe(403);
        // Reporting stays open to every verified collector and approves nothing.
        const report = await post(
          "/api/catalog/metadata-reports",
          {
            target: "marketplace",
            issue: "incorrect",
            printing_id: ids.printing,
            edition_id: ids.edition,
            proposed: { product_id: 5 },
          },
          cookie
        );
        expect(report.status).toBe(201);
        expect((await report.json()).status).toBe("pending");
      } finally {
        await bind(userId);
      }
      expect(await count()).toBe(codes);
      await post("/auth/sign-out", {}, cookie);
    } finally {
      // Leave no open report behind for the browser suite that shares this database.
      await pool.query(
        "DELETE FROM catalog_metadata_report WHERE printing_id=$1",
        [ids.printing]
      );
      await bind(previous);
    }
  });

  // The timeout covers the readiness deadline in waitForServer plus a cold tsx start on a loaded host.
  it("fails closed when the auth database is unavailable", async () => {
    const child = launch("node", ["--import", "tsx", "auth/src/server.ts"], {
      ...process.env,
      EMAIL_SIGN_IN: "on",
      AUTH_PORT: process.env.TEST_UNAVAILABLE_AUTH_PORT || "3002",
      DATABASE_URL: "postgresql://raian@127.0.0.1:1/unavailable",
    });
    try {
      // The first answer the gateway gives, whatever its status, is the one under test.
      const response = await waitForServer(
        [child],
        `http://127.0.0.1:${process.env.TEST_UNAVAILABLE_AUTH_PORT || "3002"}/api/locations`,
        () => true,
        {
          headers: {
            cookie: "better-auth.session_token=forged",
            "x-internal-user": "victim",
          },
        }
      );
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
  }, 60_000);
});
