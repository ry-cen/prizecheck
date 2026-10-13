import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { Pool } from "pg";

const OWNER_EMAIL = process.env.OWNER_EMAIL || "owner@example.test";
const ORIGIN = process.env.TEST_ORIGIN || "http://localhost:5173";
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const EVIDENCE = "https://example.org/metadata-evidence";

const lastOtp = () =>
  JSON.parse(
    readFileSync(process.env.MAIL_FILE!, "utf8").trim().split("\n").at(-1)!
  ).otp as string;

/** Furret under the shipped matching rule v1: `quarantine` leaves the normal Edition quarantined. */
function seed(quarantine: boolean) {
  execFileSync(
    ".venv/bin/python",
    [
      "-c",
      `from test_catalog import reset_catalog
from test_catalog_metadata import Records
from test_catalog_reconciliation import run
from test_catalog_targets import card
from app.main import connect
from app.catalog_targets import MATCHING, activate_rule
reset_catalog()
run(Records(card(1)))
if ${quarantine ? "True" : "False"}:
    with connect() as conn, conn.transaction():
        conn.execute("INSERT INTO inventory_owner(user_id) VALUES ('seed-maintainer') ON CONFLICT DO NOTHING")
        activate_rule(conn, MATCHING, 1, 'seed-maintainer', 'https://example.org/rule', 'Reviewed against the target')
    changed = card(1)
    changed['variants_detailed'][0]['pricing']['tcgplayer']['normal']['productId'] = 999
    run(Records(changed))`,
    ],
    { env: { ...process.env, PYTHONPATH: "api:api/tests" } }
  );
}

async function signIn(page: Page) {
  await pool.query("DELETE FROM auth_send_event");
  await page.goto(`${ORIGIN}/locations`);
  await expect(page).toHaveURL(/\/collection(\?|$)/);
  await page.getByLabel("Email", { exact: true }).fill(OWNER_EMAIL);
  await page.getByRole("button", { name: "Send code", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("code has been sent");
  await page.getByLabel("Six-digit code").fill(lastOtp());
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("navigation", { name: "Main views" })
  ).toBeVisible();
}

const userId = async () =>
  (await pool.query('SELECT id FROM "user" WHERE email=$1', [OWNER_EMAIL]))
    .rows[0].id as string;

/** The one verified account is the maintainer when bound, an ordinary collector otherwise. */
async function setMaintainer(isMaintainer: boolean) {
  await pool.query("DELETE FROM owner_binding");
  const id = await userId();
  await pool.query(
    "INSERT INTO inventory_owner(user_id) VALUES($1) ON CONFLICT DO NOTHING",
    [id]
  );
  if (isMaintainer)
    await pool.query(
      "INSERT INTO owner_binding(singleton,user_id) VALUES(true,$1)",
      [id]
    );
}

const normal = async () =>
  (
    await pool.query(
      `SELECT e.id,e.printing_id,m.mapping_state,m.mapping_reason,m.product_id,m.quote_variant,m.public_revision
       FROM catalog_edition e JOIN catalog_printing p ON p.id=e.printing_id
       JOIN catalog_edition_metadata m ON m.edition_id=e.id
       WHERE p.source_id='meta-1' AND e.descriptor::text LIKE '%normal%'`
    )
  ).rows[0];

async function sendCode(page: Page, scope: ReturnType<Page["locator"]>) {
  await pool.query(
    "UPDATE auth_send_event SET sent_at=now()-interval '61 seconds'"
  );
  await scope.getByRole("button", { name: "Send code" }).click();
  await expect(scope.getByRole("status").first()).toContainText(
    "Fresh approval code sent"
  );
  await scope.getByLabel("Fresh six-digit code").fill(lastOtp());
}

async function openOwnerReview(page: Page) {
  await page.reload();
  await page.getByRole("button", { name: "Account" }).click();
  await page.getByRole("menuitem", { name: "Owner controls" }).click();
  return page.getByRole("region", { name: "Catalog metadata review" });
}

test.beforeEach(async () => {
  await pool.query("DELETE FROM catalog_metadata_report");
});
test.afterEach(async () => {
  await pool.query("DELETE FROM catalog_metadata_report");
  await pool.query("UPDATE catalog_rule_state SET activation_id=NULL");
});
test.afterAll(async () => {
  await pool.end();
});

test("collector reports an Edition mapping, nothing changes until the maintainer approves it", async ({
  page,
}) => {
  seed(false);
  await signIn(page);
  await setMaintainer(false);
  const before = await normal();
  const outboxBefore = (
    await pool.query("SELECT count(*)::int AS n FROM catalog_public_outbox")
  ).rows[0].n;

  await page.reload();
  await page.getByRole("button", { name: "Catalog", exact: true }).click();
  await page.getByLabel("English name").fill("Furret");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByRole("button", { name: "View Editions" }).click();
  await page
    .getByRole("listitem")
    .filter({ hasText: "normal" })
    .getByRole("button", { name: "Report metadata" })
    .click();
  const form = page.getByRole("region", { name: "Report card metadata" });
  await form.getByLabel("Metadata target").selectOption("marketplace");
  await form.getByLabel("Proposed product ID").fill("4321");
  await form.getByLabel("Proposed quote variant").fill("normal");
  await form.getByLabel("Evidence URL").fill(EVIDENCE);
  await form.getByLabel("Note").fill("Wrong product listed");
  await form.getByRole("button", { name: "Submit metadata report" }).click();
  await expect(form.getByRole("status")).toContainText(
    "Submitted for maintainer review; nothing changes until approved."
  );
  const mine = page.getByRole("region", { name: "My metadata reports" });
  await expect(mine).toContainText("pending");
  await expect(mine).toContainText("product id 4321");

  // The report is unapproved input: no state, revision or delivery changed.
  expect(await normal()).toEqual(before);
  expect(
    (await pool.query("SELECT count(*)::int AS n FROM catalog_public_outbox"))
      .rows[0].n
  ).toBe(outboxBefore);

  // A collector can neither see nor call the review surface.
  await page.getByRole("button", { name: "Account" }).click();
  await expect(
    page.getByRole("menuitem", { name: "Owner controls" })
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.goto(`${ORIGIN}/owner`);
  await expect(
    page.getByRole("navigation", { name: "Main views" })
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Catalog metadata review" })
  ).toHaveCount(0);
  expect(
    (
      await page.request.get(`${ORIGIN}/api/admin/catalog-metadata/queue`)
    ).status()
  ).toBe(403);

  // The maintainer reviews it and approves a mapping with a fresh code.
  await setMaintainer(true);
  const review = await openOwnerReview(page);
  const item = review
    .getByRole("article")
    .filter({ hasText: "Furret" })
    .filter({ hasText: "normal" });
  await expect(item).toContainText("unverified");
  await expect(item).toContainText("1 linked report");
  await item.getByLabel("Decision", { exact: true }).selectOption("correct");
  await item.getByLabel("Product ID", { exact: true }).fill("4321");
  await item.getByLabel("Quote variant", { exact: true }).fill("normal");
  await item.getByLabel("Decision evidence URL").fill(EVIDENCE);
  await item
    .getByLabel("Decision reason")
    .fill("Product page matches the card");
  await sendCode(page, item);
  await item.getByRole("button", { name: "Record decision" }).click();
  await expect(item.getByRole("status").last()).toContainText(
    "Decision recorded"
  );
  await expect(item).toContainText("Public delivery: delivered");
  await expect(item).toContainText("verified");

  const after = await normal();
  expect(after).toMatchObject({
    mapping_state: "verified",
    product_id: "4321",
    quote_variant: null, // the source's "normal" block holds another product, so the correction is unpriced
  });
  expect(
    (await pool.query("SELECT status FROM catalog_metadata_report")).rows
  ).toEqual([{ status: "approved" }]);

  // The history panel carries the provenance of the decision.
  await item.getByRole("button", { name: "Show history" }).click();
  const history = item.getByRole("region", { name: "Decision history" });
  await expect(history).toContainText("correct");
  await expect(history).toContainText(await userId());
  await expect(history).toContainText(EVIDENCE);
  await expect(history).toContainText("Product page matches the card");
  await expect(history).toContainText("product id 4321");
  // No matching rule was active, so the decision retains none.
  await expect(history).toContainText("No rule");

  // The collector now sees the outcome on their report.
  await setMaintainer(false);
  await page.reload();
  await page.getByRole("button", { name: "Catalog", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "My metadata reports" })
  ).toContainText("approved");
});

test("a stale evidence digest is refused, then succeeds after reloading the evidence", async ({
  page,
}) => {
  seed(false);
  await signIn(page);
  await setMaintainer(true);
  const target = await normal();
  const review = await openOwnerReview(page);
  // Open a queue entry through a report, then change the evidence underneath the maintainer.
  const first = await page.request.post(
    `${ORIGIN}/api/catalog/metadata-reports`,
    {
      headers: { origin: ORIGIN },
      data: {
        target: "marketplace",
        issue: "missing",
        printing_id: target.printing_id,
        edition_id: target.id,
        proposed: { product_id: 777 },
        note: "first",
      },
    }
  );
  expect(first.status()).toBe(201);
  await review.getByRole("button", { name: "Refresh queue" }).click();
  const item = review.getByRole("article").filter({ hasText: "normal" });
  await expect(item).toContainText("1 linked report");
  const second = await page.request.post(
    `${ORIGIN}/api/catalog/metadata-reports`,
    {
      headers: { origin: ORIGIN },
      data: {
        target: "marketplace",
        issue: "incorrect",
        printing_id: target.printing_id,
        edition_id: target.id,
        proposed: { product_id: 778 },
        note: "second",
      },
    }
  );
  expect(second.status()).toBe(201);

  await item.getByLabel("Decision", { exact: true }).selectOption("correct");
  await item.getByLabel("Product ID", { exact: true }).fill("777");
  await item.getByLabel("Decision evidence URL").fill(EVIDENCE);
  await item.getByLabel("Decision reason").fill("Reviewed the first report");
  await sendCode(page, item);
  await item.getByRole("button", { name: "Record decision" }).click();
  await expect(item.getByRole("alert")).toContainText("Evidence changed");
  await expect((await normal()).mapping_state).toBe("unverified");

  await item.getByRole("button", { name: "Reload evidence" }).click();
  await expect(item).toContainText("2 linked reports");
  await expect(item.getByRole("alert")).toHaveCount(0);
  // The unspent code still works; the form keeps the maintainer's entries.
  await item.getByRole("button", { name: "Record decision" }).click();
  await expect(item).toContainText("Decision recorded");
  expect((await normal()).mapping_state).toBe("verified");
  expect(
    (await pool.query("SELECT status FROM catalog_metadata_report")).rows.map(
      (row) => row.status
    )
  ).toEqual(["approved", "approved"]);
});

test("a maintainer-cleared quarantine is visible in the public record after delivery", async ({
  page,
}) => {
  seed(true);
  await signIn(page);
  await setMaintainer(true);
  const quarantined = await normal();
  expect(quarantined).toMatchObject({
    mapping_state: "quarantined",
    mapping_reason: "candidate_changed",
  });
  const review = await openOwnerReview(page);
  const item = review
    .getByRole("article")
    .filter({ hasText: "Furret" })
    .filter({ hasText: "normal" });
  await expect(item).toContainText("quarantined");
  await expect(item).toContainText("candidate_changed");
  await expect(item).toContainText("Source value");
  await expect(item).toContainText("999");
  await item.getByLabel("Decision", { exact: true }).selectOption("correct");
  await item.getByLabel("Product ID", { exact: true }).fill("4321");
  await item.getByLabel("Quote variant", { exact: true }).fill("normal");
  await item.getByLabel("Decision evidence URL").fill(EVIDENCE);
  await item
    .getByLabel("Decision reason")
    .fill("Source change checked by hand");
  await sendCode(page, item);
  await item.getByRole("button", { name: "Record decision" }).click();
  await expect(item).toContainText("Public delivery: delivered");
  await expect(item).toContainText("verified");
  await item.getByRole("button", { name: "Show history" }).click();
  await expect(
    item.getByRole("region", { name: "Decision history" })
  ).toContainText("Rule: marketplace_matching v1");

  const published = JSON.parse(
    execFileSync(
      ".venv/bin/python",
      [
        "-c",
        `import json,time
from app.main import connect
from app.public_projection import public_record_store
from app.public_records import catalog_edition_key
with connect() as conn:
    ref=conn.execute("SELECT public_ref FROM catalog_edition WHERE id=%s",('${quarantined.id}',)).fetchone()['public_ref']
key=catalog_edition_key(ref)
print(json.dumps(public_record_store().read_records([key],deadline=time.monotonic()+5).records[key].value['marketplace']))`,
      ],
      { env: { ...process.env, PYTHONPATH: "api:api/tests" } }
    ).toString()
  );
  expect(JSON.stringify(published)).toContain("verified");
  expect(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM catalog_public_outbox WHERE target_id=$1 AND delivered_at IS NULL",
        [quarantined.id]
      )
    ).rows[0].n
  ).toBe(0);
});

test("the maintainer lists rule versions and activates a rule with a fresh code", async ({
  page,
}) => {
  seed(false);
  await signIn(page);
  await setMaintainer(true);
  await pool.query("UPDATE catalog_rule_state SET activation_id=NULL");
  const review = await openOwnerReview(page);
  const rules = review.getByRole("region", { name: "Metadata rules" });
  const matching = rules
    .getByRole("article")
    .filter({ hasText: "marketplace_matching" });
  await expect(matching).toContainText("Version 1");
  await expect(matching).toContainText("No active rule");
  await matching.getByLabel("Rule version").selectOption("1");
  await matching.getByLabel("Rule evidence URL").fill(EVIDENCE);
  await matching.getByLabel("Rule reason").fill("Reviewed the matching rule");
  await sendCode(page, matching);
  await matching.getByRole("button", { name: "Apply rule change" }).click();
  await expect(matching).toContainText("Active: version 1");
  await expect(matching).toContainText("Public delivery:");
  // Deactivating binds the code to version 0.
  await matching.getByLabel("Rule version").selectOption("none");
  await matching.getByLabel("Rule evidence URL").fill(EVIDENCE);
  await matching.getByLabel("Rule reason").fill("Pause the matching rule");
  await sendCode(page, matching);
  await matching.getByRole("button", { name: "Apply rule change" }).click();
  await expect(matching).toContainText("No active rule");
});

const printingRow = async () =>
  (
    await pool.query(
      `SELECT p.id,m.live_state,m.live_identity FROM catalog_printing p
       JOIN catalog_printing_metadata m ON m.printing_id=p.id WHERE p.source_id='meta-1'`
    )
  ).rows[0];

/** Activates the shipped matching rule, then moves the normal Edition's source product so it quarantines. */
function quarantineNormalEdition() {
  execFileSync(
    ".venv/bin/python",
    [
      "-c",
      `from test_catalog_metadata import Records
from test_catalog_reconciliation import run
from test_catalog_targets import card
from app.main import connect
from app.catalog_targets import MATCHING, activate_rule
with connect() as conn, conn.transaction():
    conn.execute("INSERT INTO inventory_owner(user_id) VALUES ('seed-maintainer') ON CONFLICT DO NOTHING")
    activate_rule(conn, MATCHING, 1, 'seed-maintainer', 'https://example.org/rule', 'Reviewed against the target')
changed = card(1)
changed['variants_detailed'][0]['pricing']['tcgplayer']['normal']['productId'] = 999
run(Records(changed))`,
    ],
    { env: { ...process.env, PYTHONPATH: "api:api/tests" } }
  );
}

async function reportLive(page: Page, printingId: string) {
  const response = await page.request.post(
    `${ORIGIN}/api/catalog/metadata-reports`,
    {
      headers: { origin: ORIGIN },
      data: {
        target: "live",
        issue: "missing",
        printing_id: printingId,
        proposed: { set_code: "dab" },
        note: "Live identity is missing",
      },
    }
  );
  expect(response.status()).toBe(201);
}

test("quarantining the Edition mapping leaves a reviewed Live identity eligible", async ({
  page,
}) => {
  seed(false);
  await signIn(page);
  await setMaintainer(true);
  const printing = await printingRow();
  await reportLive(page, printing.id);
  let review = await openOwnerReview(page);

  // Activate the Live rule v1 with a fresh code.
  const live = review
    .getByRole("region", { name: "Metadata rules" })
    .getByRole("article")
    .filter({ hasText: "live_derivation" });
  await live.getByLabel("Rule version").selectOption("1");
  await live.getByLabel("Rule evidence URL").fill(EVIDENCE);
  await live.getByLabel("Rule reason").fill("Reviewed the Live rule");
  await sendCode(page, live);
  await live.getByRole("button", { name: "Apply rule change" }).click();
  await expect(live).toContainText("Active: version 1");
  // The activation changed the target's evidence, so reopen the review first.
  review = await openOwnerReview(page);

  // A complete Live correction; the set code is normalised to upper case.
  const item = review
    .getByRole("article")
    .filter({ hasText: "Furret" })
    .filter({ hasText: "Live identity" });
  await item.getByLabel("Decision", { exact: true }).selectOption("correct");
  await item.getByLabel("Live name").fill("Furret");
  await item.getByLabel("Live set code").fill("dab");
  await item.getByLabel("Live collector number").fill("1");
  await item.getByLabel("Decision evidence URL").fill(EVIDENCE);
  await item.getByLabel("Decision reason").fill("Printed identity checked");
  await sendCode(page, item);
  await item.getByRole("button", { name: "Record decision" }).click();
  await expect(item).toContainText("Decision recorded: eligible");
  expect(await printingRow()).toMatchObject({
    live_state: "eligible",
    live_identity: {
      category: "Pokemon",
      name: "Furret",
      set_code: "DAB",
      number: "1",
    },
  });
  await item.getByRole("button", { name: "Show history" }).click();
  await expect(
    item.getByRole("region", { name: "Decision history" })
  ).toContainText("Rule: live_derivation v1");

  // Now the same Printing's Edition mapping is quarantined.
  quarantineNormalEdition();
  const edition = await normal();
  expect(edition).toMatchObject({
    mapping_state: "quarantined",
    printing_id: printing.id,
  });
  review = await openOwnerReview(page);
  await expect(
    review
      .getByRole("article")
      .filter({ hasText: "Furret" })
      .filter({ hasText: "normal" })
  ).toContainText("quarantined");
  const marketplaceApi = await page.request.get(
    `${ORIGIN}/api/admin/catalog-metadata/editions/${edition.id}`
  );
  expect((await marketplaceApi.json()).state).toBe("quarantined");
  // Live is independent: still eligible in the database and in the maintainer API.
  expect((await printingRow()).live_state).toBe("eligible");
  const liveApi = await page.request.get(
    `${ORIGIN}/api/admin/catalog-metadata/printings/${printing.id}`
  );
  expect((await liveApi.json()).state).toBe("eligible");
});

test("a request for information round-trips through the collector back to the maintainer queue", async ({
  page,
}) => {
  seed(false);
  await signIn(page);
  await setMaintainer(true);
  const target = await normal();
  const created = await page.request.post(
    `${ORIGIN}/api/catalog/metadata-reports`,
    {
      headers: { origin: ORIGIN },
      data: {
        target: "marketplace",
        issue: "incorrect",
        printing_id: target.printing_id,
        edition_id: target.id,
        proposed: { product_id: 4321 },
        evidence_url: "https://example.org/listing",
        note: "Original note",
      },
    }
  );
  expect(created.status()).toBe(201);
  const reportId = (await created.json()).id as string;
  const review = await openOwnerReview(page);
  const item = review
    .getByRole("article")
    .filter({ hasText: "Furret" })
    .filter({ hasText: "normal" });
  // The maintainer can read what was reported, and the link cannot leak the opener.
  await expect(item).toContainText("Note: Original note");
  await expect(item).toContainText("product id 4321");
  const link = item.getByRole("link", { name: "https://example.org/listing" });
  await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  await expect(link).toHaveAttribute("href", "https://example.org/listing");
  await item.getByLabel("Decision reason").fill("Which listing did you mean?");
  await item
    .getByRole("button", { name: /Ask reporter for information/ })
    .click();
  await expect(item).toContainText("Information requested from the reporter.");
  expect(
    (
      await pool.query(
        "SELECT status FROM catalog_metadata_report WHERE id=$1",
        [reportId]
      )
    ).rows[0].status
  ).toBe("needs_info");

  // The collector sees the request and answers it.
  await setMaintainer(false);
  await page.reload();
  await page.getByRole("button", { name: "Catalog", exact: true }).click();
  const mine = page.getByRole("region", { name: "My metadata reports" });
  await expect(mine).toContainText("needs info");
  await expect(mine).toContainText("Which listing did you mean?");
  await mine
    .getByLabel("Additional information")
    .fill("The TCGplayer listing 4321");
  await mine
    .getByRole("button", { name: "Send information to maintainer" })
    .click();
  await expect(mine).toContainText("Information sent to the maintainer.");
  await expect(mine).toContainText("pending");
  expect(
    (
      await pool.query(
        "SELECT status,note FROM catalog_metadata_report WHERE id=$1",
        [reportId]
      )
    ).rows[0]
  ).toEqual({ status: "pending", note: "The TCGplayer listing 4321" });

  // The answered report is back in the maintainer queue.
  await setMaintainer(true);
  const again = await openOwnerReview(page);
  await expect(
    again
      .getByRole("article")
      .filter({ hasText: "Furret" })
      .filter({ hasText: "normal" })
  ).toContainText("Note: The TCGplayer listing 4321"); // the reply is readable
  const queue = await page.request.get(
    `${ORIGIN}/api/admin/catalog-metadata/queue`
  );
  const items = (await queue.json()).items as { report_ids: string[] }[];
  expect(items.some((entry) => entry.report_ids.includes(reportId))).toBe(true);
});
