// Ticket #167: Owner controls (spec "Missing cards and Owner controls"). The problems line, the sub-tabs
// with counts and their addresses, Status (the pull panel and the operational health table) and Rules, with
// the shared page check at 1280×800 and 375×812. Each queue tab's own review is on the kit too (#168, #170, #171), and
// its own specs cover it (owner-queues, catalog-reconciliation, metadata-review, missing-cards, owner-attributes,
// owner-reprints).
import { test, expect, type Page } from "@playwright/test";
import { signInAsOwner as fakeSignInAsOwner } from "./support/sign-in";
import { execFileSync } from "node:child_process";
import { Pool } from "pg";
import { expectPageChecks } from "./support/page-check";

const ORIGIN = process.env.TEST_ORIGIN || "http://localhost:5173";
const OWNER_EMAIL = process.env.OWNER_EMAIL || "owner@example.test";

async function query<T = Record<string, unknown>>(
  sql: string,
  values: unknown[] = []
): Promise<T[]> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    return (await pool.query(sql, values)).rows as T[];
  } finally {
    await pool.end();
  }
}

/** Signs in at /collection through the OAuth test fake, then binds the owner role to that user and reloads. */
async function signInAsOwner(page: Page) {
  await query("DELETE FROM auth_send_event");
  await fakeSignInAsOwner(page, "/collection");
  await expect(
    page.getByRole("navigation", { name: "Main views" })
  ).toBeVisible();
  await query(
    'INSERT INTO owner_binding(singleton,user_id) SELECT true,id FROM "user" WHERE email=$1 ON CONFLICT(singleton) DO UPDATE SET user_id=EXCLUDED.user_id',
    [OWNER_EMAIL]
  );
  await page.reload();
  await expect(
    page.getByRole("navigation", { name: "Main views" })
  ).toBeVisible();
}

/** A stale backup (bad), an allowance at 70% (warn) and a stale measurement (unverified). Returns the undo. */
async function seedHealth(): Promise<() => Promise<void>> {
  const [before] = await query(
    "SELECT backup_last_success,backup_stale,watchdog_last_check,backup_alerts FROM operations_state WHERE singleton"
  );
  await query(
    "UPDATE operations_state SET backup_last_success=now()-interval '26 hours',backup_stale=true,watchdog_last_check=now(),backup_alerts=1 WHERE singleton"
  );
  await query(
    "INSERT INTO operations_quota(resource,used,allowance) VALUES('database_bytes',70,100) ON CONFLICT(resource) DO UPDATE SET used=70,allowance=100,measured_at=now()"
  );
  await query(
    "INSERT INTO operations_quota(resource,used,allowance,measured_at) VALUES('email_monthly',10,3000,now()-interval '30 hours') ON CONFLICT(resource) DO UPDATE SET used=10,allowance=3000,measured_at=now()-interval '30 hours'"
  );
  return async () => {
    await query(
      "UPDATE operations_state SET backup_last_success=$1,backup_stale=$2,watchdog_last_check=$3,backup_alerts=$4 WHERE singleton",
      [
        before.backup_last_success,
        before.backup_stale,
        before.watchdog_last_check,
        before.backup_alerts,
      ]
    );
    await query(
      "DELETE FROM operations_quota WHERE resource IN ('database_bytes','email_monthly')"
    );
  };
}

/** Closes any open catalog run, then opens one that is fetching (60% fetched) with a live lease. */
async function seedRun(): Promise<string> {
  await query(
    "UPDATE catalog_run SET phase='failed',outcome='failed',finished_at=now() WHERE outcome IS NULL"
  );
  const [run] = await query<{ id: string }>(
    "INSERT INTO catalog_run(phase,enumerated_count,fetched_count,validated_count,started_at,lease_until) VALUES('fetching',200,120,100,now()-interval '10 minutes',now()+interval '10 minutes') RETURNING id"
  );
  return run.id;
}

/** Empties the price import tables; the panel tests start from "never imported". */
async function resetPriceImports() {
  await query(
    "TRUNCATE price_import, tcgplayer_product, tcgplayer_price RESTART IDENTITY"
  );
}

/** One finished price_import row finished `hoursAgo` hours ago, plus any extra column values. */
async function seedImport(
  outcome: string,
  hoursAgo = 0,
  extra: Record<string, unknown> = {}
) {
  const names = [
    "outcome",
    "finished_at",
    "source_updated_at",
    ...Object.keys(extra),
  ];
  const marks = [
    "$1",
    "now()-$2*interval '1 hour'",
    "now()-$2*interval '1 hour'",
    ...Object.keys(extra).map((_, i) => `$${i + 3}`),
  ];
  await query(
    `INSERT INTO price_import(${names.join(",")}) VALUES (${marks.join(",")})`,
    [outcome, hoursAgo, ...Object.values(extra)]
  );
}

async function seedPrice(hoursAgo = 0) {
  await query(
    "INSERT INTO tcgplayer_price(product_id,sub_type_name,market_price,seen_at,source_updated_at) VALUES (1,'Normal',1,now(),now()-$1*interval '1 hour')",
    [hoursAgo]
  );
}

/** Two dpp Editions verified by card number under matching rule v4 (the Status panel's count and the Metadata list). */
function seedNumberMatches() {
  execFileSync(
    ".venv/bin/python",
    [
      "-c",
      `from test_catalog import reset_catalog
from test_catalog_metadata import Records
from test_catalog_reconciliation import run
from test_catalog_targets import promo, listing
from app.main import connect
from app.catalog_targets import MATCHING, activate_rule
reset_catalog()
with connect() as conn:
    conn.execute("TRUNCATE tcgplayer_product, tcgplayer_price")
listing(900, "Turtwig", "DP01", 1421)
listing(901, "Chimchar - DP02", "DP02", 1421)
run(Records(promo("dpp-1", "DP01", "dpp", "Turtwig"), promo("dpp-2", "DP02", "dpp", "Chimchar")))
with connect() as conn, conn.transaction():
    conn.execute("INSERT INTO inventory_owner(user_id) VALUES ('seed-maintainer') ON CONFLICT DO NOTHING")
    activate_rule(conn, MATCHING, 4, 'seed-maintainer', 'https://example.org/rule', 'Reviewed against the target')`,
    ],
    { env: { ...process.env, PYTHONPATH: "api:api/tests" } }
  );
}

const priceImport = (page: Page) =>
  page.getByRole("region", { name: "Price import" });

const sections = (page: Page) =>
  page.getByRole("tablist", { name: "Owner controls sections" });
const sectionTab = (page: Page, name: string | RegExp) =>
  sections(page).getByRole("tab", { name });
const health = (page: Page) =>
  page.getByRole("region", { name: "Health checks" });
const healthRow = (page: Page, check: string) =>
  health(page)
    .getByRole("row")
    .filter({ has: page.getByRole("cell", { name: check, exact: true }) });

async function openFromAccountMenu(page: Page) {
  await page.getByRole("button", { name: "Account" }).click();
  await page.getByRole("menuitem", { name: "Owner controls" }).click();
  await expect(page).toHaveURL(/\/owner$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Owner controls"
  );
}

test.describe("desktop", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("Owner controls has a problems line, worst first, and sub-tabs with counts that each have an address", async ({
    page,
  }) => {
    await signInAsOwner(page);
    const undoHealth = await seedHealth();
    const created = await page.request.post(
      `${ORIGIN}/api/missing-card-reports`,
      {
        headers: { origin: ORIGIN },
        data: {
          kind: "printing",
          set_id: "OC",
          set_name: "Owner Controls",
          collector_number: "167",
          english_name: "Counted Card",
          note: "Counted on the Missing cards tab",
        },
      }
    );
    expect(created.status()).toBe(201);
    const reportId = ((await created.json()) as { id: string }).id;
    try {
      await openFromAccountMenu(page);

      // The problems line: every check that isn't OK, bad before warn before unverified.
      const problems = page.getByRole("list", { name: "Problems" });
      await expect(problems).toContainText("Backup: Stale");
      await expect
        .poll(async () => {
          const listed = await problems.getByRole("listitem").allTextContents();
          const backup = listed.indexOf("Backup: Stale");
          const allowance = listed.indexOf(
            "database_bytes: 70 / 100 · 70% warning"
          );
          const measurement = listed.indexOf("email_monthly: Unverified");
          return backup === 0 && allowance > backup && measurement > allowance;
        })
        .toBe(true);
      await expect(problems).not.toContainText("Requests:");

      // Eight sub-tabs in order; Status is selected at /owner and only it is in the Tab order.
      const tabs = sections(page).getByRole("tab");
      await expect(tabs).toHaveCount(8);
      const names = [
        "Status",
        "Catalog",
        "Metadata",
        "Attributes",
        "Reprints",
        "Missing cards",
        "Trade reports",
        "Rules",
      ];
      for (const [index, name] of names.entries())
        await expect(tabs.nth(index)).toHaveAccessibleName(
          new RegExp(`^${name}`)
        );
      await expect(sectionTab(page, "Status")).toHaveAttribute(
        "aria-selected",
        "true"
      );
      await expect(sectionTab(page, "Status")).toHaveAttribute("tabindex", "0");
      await expect(sectionTab(page, "Rules")).toHaveAttribute("tabindex", "-1");

      // Counts: each queue tab shows how many items wait.
      const [catalog] = await query<{ n: number }>(
        "SELECT count(*)::int AS n FROM catalog_review WHERE status='pending'"
      );
      const [missing] = await query<{ n: number }>(
        "SELECT count(*)::int AS n FROM missing_card_report WHERE status IN ('pending','needs_info')"
      );
      expect(missing.n).toBeGreaterThan(0);
      await expect(sectionTab(page, /^Catalog/)).toHaveAccessibleName(
        `Catalog ${catalog.n}`
      );
      await expect(sectionTab(page, /^Missing cards/)).toHaveAccessibleName(
        `Missing cards ${missing.n}`
      );
      for (const name of [
        "Metadata",
        "Attributes",
        "Reprints",
        "Trade reports",
      ])
        await expect(
          sectionTab(page, new RegExp(`^${name}`))
        ).toHaveAccessibleName(new RegExp(`^${name} \\d+\\+?$`));
      await expect(sectionTab(page, "Status")).toHaveAccessibleName("Status");
      await expect(sectionTab(page, "Rules")).toHaveAccessibleName("Rules");

      // Keyboard: arrows move focus without selecting; Enter selects.
      await sectionTab(page, "Status").focus();
      await page.keyboard.press("ArrowLeft");
      await expect(sectionTab(page, "Rules")).toBeFocused();
      await expect(sectionTab(page, "Status")).toHaveAttribute(
        "aria-selected",
        "true"
      );
      await page.keyboard.press("Home");
      await expect(sectionTab(page, "Status")).toBeFocused();
      await page.keyboard.press("End");
      await expect(sectionTab(page, "Rules")).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(/\/owner\/rules$/);
      await expect(sectionTab(page, "Rules")).toHaveAttribute(
        "aria-selected",
        "true"
      );
      await expect(
        page
          .getByRole("tabpanel", { name: "Rules" })
          .getByRole("article", { name: "Marketplace matching" })
      ).toBeVisible();

      // Each section has an address: it survives a reload, and Back returns to the last one.
      await page.reload();
      await expect(sectionTab(page, "Rules")).toHaveAttribute(
        "aria-selected",
        "true"
      );
      await page.goBack();
      await expect(page).toHaveURL(/\/owner$/);
      await expect(sectionTab(page, "Status")).toHaveAttribute(
        "aria-selected",
        "true"
      );
      await expect(
        page.getByRole("heading", { name: "English catalog pull" })
      ).toBeVisible();

      // Each queue tab shows its own queue, a table on the kit.
      await sectionTab(page, /^Catalog/).click();
      await expect(page).toHaveURL(/\/owner\/catalog$/);
      await expect(
        page.getByRole("region", { name: "Catalog reconciliation" })
      ).toBeVisible();
      await expectPageChecks(page, "Owner controls, Catalog (desktop)");
      await sectionTab(page, /^Metadata/).click();
      await expect(page).toHaveURL(/\/owner\/metadata$/);
      await expect(
        page.getByRole("region", { name: "Catalog metadata review" })
      ).toBeVisible();
      await expectPageChecks(page, "Owner controls, Metadata (desktop)");
      await sectionTab(page, /^Missing cards/).click();
      await expect(page).toHaveURL(/\/owner\/missing$/);
      await expect(
        page
          .getByRole("region", { name: "Missing-card review queue" })
          .getByRole("row")
          .filter({ hasText: "Counted Card" })
      ).toBeVisible();
      await expectPageChecks(page, "Owner controls, Missing cards (desktop)");
      await sectionTab(page, /^Attributes/).click();
      await expect(page).toHaveURL(/\/owner\/attributes$/);
      // The Attributes queue is on the kit (#170); owner-attributes.spec.ts covers its review card.
      await expect(
        page
          .getByRole("tabpanel", { name: /^Attributes/ })
          .getByRole("heading", { name: "Card attributes" })
      ).toBeVisible();
      await expectPageChecks(page, "Owner controls, Attributes (desktop)");
    } finally {
      await query("DELETE FROM missing_card_report WHERE id=$1", [reportId]);
      await undoHealth();
    }
  });

  test("Status shows the pull panel and operational health; a stale run offers Restart pull with a warning", async ({
    page,
  }) => {
    await signInAsOwner(page);
    const undoHealth = await seedHealth();
    const runId = await seedRun();
    try {
      await openFromAccountMenu(page);
      const pull = page.getByRole("region", { name: "English catalog pull" });
      await expect(pull.getByText("Phase: fetching")).toBeVisible();
      await expect(
        pull.getByText("In progress", { exact: true })
      ).toBeVisible();
      await expect(
        pull.getByRole("progressbar", { name: "Pull progress" })
      ).toHaveAttribute("aria-valuenow", "60");
      await expect(pull).toContainText(
        "Enumerated 200 · Fetched 120 · Validated 100"
      );
      await expect(
        pull.getByRole("button", { name: "Start full pull" })
      ).toBeDisabled();
      await expect(pull.getByRole("button", { name: "Refresh" })).toBeEnabled();
      await expect(
        pull.getByRole("button", { name: "Restart pull" })
      ).toHaveCount(0);

      // Operational health is a table of area, check, value and detail in its own focusable region.
      const table = health(page);
      await expect(table).toHaveAttribute("tabindex", "0");
      await expect(table.getByRole("columnheader")).toHaveText([
        "Area",
        "Check",
        "Value",
        "Detail",
      ]);
      await expect(healthRow(page, "Backup")).toContainText("Backups");
      await expect(healthRow(page, "Backup")).toContainText("Stale");
      await expect(healthRow(page, "Backup watchdog")).toContainText(
        "Stale backup alerts: 1"
      );
      await expect(healthRow(page, "database_bytes")).toContainText(
        "70 / 100 · 70% warning"
      );
      await expect(healthRow(page, "email_monthly")).toContainText(
        "Measurement is stale"
      );
      await expect(table).not.toContainText(OWNER_EMAIL);

      // The run stops reporting progress: Refresh shows Restart pull and the stale warning.
      await query(
        "UPDATE catalog_run SET lease_until=now()-interval '1 minute' WHERE id=$1",
        [runId]
      );
      await pull.getByRole("button", { name: "Refresh" }).click();
      await expect(
        pull.getByRole("button", { name: "Restart pull" })
      ).toBeEnabled();
      await expect(
        pull.getByRole("button", { name: "Start full pull" })
      ).toHaveCount(0);
      await expect(
        pull.getByText("Progress stale", { exact: true })
      ).toBeVisible();
      await expect(pull.getByRole("status")).toHaveText(
        "Progress is stale. Restart the pull to check the runner and recover if it was interrupted."
      );
      await expectPageChecks(page, "Owner controls, Status (desktop)");
    } finally {
      await query("DELETE FROM catalog_run WHERE id=$1", [runId]);
      await undoHealth();
    }
  });

  test("Status shows the price import: never imported, an imported run, and one warning line for each problem", async ({
    page,
  }) => {
    await signInAsOwner(page);
    await resetPriceImports();
    try {
      await openFromAccountMenu(page);
      const panel = priceImport(page);
      const refresh = async () => {
        await page
          .getByRole("region", { name: "English catalog pull" })
          .getByRole("button", { name: "Refresh" })
          .click();
      };
      await expect(panel).toContainText("Prices have not been imported yet.");
      await expect(panel.getByRole("alert")).toHaveCount(0);

      await seedPrice();
      await seedImport("imported", 0, {
        verified_editions: 1200,
        priced_editions: 1100,
        unpriced: JSON.stringify({ ambiguous: 60, no_price: 40 }),
        fallback_art: 25,
      });
      await refresh();
      await expect(panel).toContainText("TCGplayer data from");
      await expect(panel).toContainText(
        "1,100 of 1,200 verified Editions priced"
      );
      await expect(panel).toContainText("ambiguous 60");
      await expect(panel).toContainText("no price 40");
      await expect(panel).toContainText("25 Printings use TCGplayer art");
      await expect(panel.getByRole("alert")).toHaveCount(0);

      await seedImport("partial", 0, {
        groups_failed: 3,
        error_code: "group_failed",
      });
      await refresh();
      await expect(panel.getByRole("alert")).toHaveCount(1);
      await expect(panel.getByRole("alert")).toContainText(
        "The latest price import was partial (group_failed) · Groups failed: 3"
      );

      await seedImport("failed", 0, { error_code: "stale_source" });
      await refresh();
      await expect(panel.getByRole("alert")).toHaveCount(1);
      await expect(panel.getByRole("alert")).toContainText(
        "The latest price import failed (stale_source)"
      );

      await seedImport("imported", 0, { public_error: "publish failed" });
      await refresh();
      await expect(panel.getByRole("alert")).toHaveCount(1);
      await expect(panel.getByRole("alert")).toContainText(
        "Publishing prices failed: publish failed"
      );

      // The last good run is over 48 hours old.
      await resetPriceImports();
      await seedPrice();
      await seedImport("imported", 49);
      await seedImport("failed", 0, { error_code: "group_list" });
      await refresh();
      await expect(panel.getByRole("alert")).toHaveCount(2);
      await expect(panel).toContainText(
        "The last good price import is over 48 hours old"
      );

      // The latest run is unchanged, yet TCGCSV's own update time is frozen over 48 hours back.
      await resetPriceImports();
      await seedPrice(50);
      await seedImport("unchanged", 0);
      await refresh();
      await expect(panel.getByRole("alert")).toHaveCount(1);
      await expect(panel.getByRole("alert")).toContainText(
        "TCGCSV's own update time is over 48 hours old"
      );
      await expectPageChecks(
        page,
        "Owner controls, Status price import (desktop)"
      );
    } finally {
      await resetPriceImports();
    }
  });

  test("a collector's pages carry no price import text", async ({ page }) => {
    await signInAsOwner(page);
    await resetPriceImports();
    try {
      await seedPrice();
      await seedImport("failed", 0, {
        error_code: "stale_source",
        public_error: "publish failed",
      });
      await page.goto(`${ORIGIN}/catalog`);
      await expect(
        page.getByRole("navigation", { name: "Main views" })
      ).toBeVisible();
      const text = (await page.locator("body").innerText()).toLowerCase();
      for (const word of [
        "tcgcsv",
        "price import",
        "stale_source",
        "imported",
        "matched by card number",
      ])
        expect(text).not.toContain(word);
    } finally {
      await resetPriceImports();
    }
  });

  test("the panel counts card-number matches and links to the list, where an owner rejects one", async ({
    page,
  }) => {
    seedNumberMatches();
    await signInAsOwner(page);
    await resetPriceImports();
    try {
      // The reset above emptied the product list the seed matched against; the list shows the products again.
      await query(
        `INSERT INTO tcgplayer_product(product_id,group_id,name,number,number_key,seen_at,source_updated_at) VALUES
         (900,1421,'Turtwig','DP01','DP1',now(),now()),(901,1421,'Chimchar - DP02','DP02','DP2',now(),now())`
      );
      await seedPrice();
      await seedImport("imported", 0);
      await openFromAccountMenu(page);
      const panel = priceImport(page);
      await expect(panel).toContainText("2 Editions matched by card number");
      await panel.getByRole("button", { name: "Review matches" }).click();
      const list = page.getByRole("region", { name: "Matched by card number" });
      const table = list.getByRole("region", { name: "Card-number matches" });
      await expect(table.getByRole("row")).toHaveCount(3);
      await expect(table).toContainText("Chimchar - DP02");
      await expect(table).toContainText("product 901, group 1421");
      await expect(table).toContainText("v4");
      const turtwig = table.getByRole("row").filter({ hasText: "Turtwig" });
      await turtwig.getByRole("button", { name: /^Review / }).click();
      const card = list.getByRole("article");
      await expect(card.getByLabel("Review reason")).toBeFocused();
      const reject = card.getByRole("button", { name: "Reject match" });
      await expect(reject).toBeDisabled();
      await card.getByLabel("Review reason").fill("Wrong card");
      await card
        .getByLabel("Review evidence URL")
        .fill("https://example.org/evidence");
      await reject.click();
      await expect(table.getByRole("row")).toHaveCount(2);
      await expect(table).not.toContainText("Turtwig");
      const [row] = await query<{
        mapping_state: string;
        mapping_reason: string;
      }>(
        `SELECT m.mapping_state,m.mapping_reason FROM catalog_edition_metadata m JOIN catalog_edition e ON e.id=m.edition_id
         JOIN catalog_printing p ON p.id=e.printing_id WHERE p.source_id='dpp-1'`
      );
      expect(row).toEqual({
        mapping_state: "unverified",
        mapping_reason: "reviewed_unmapped",
      });
      await expectPageChecks(
        page,
        "Owner controls, Matched by card number (desktop)"
      );
    } finally {
      await resetPriceImports();
    }
  });

  test("an unknown owner address lands on Collection, and a non-owner sees only the heading on a sub-address", async ({
    page,
  }) => {
    await signInAsOwner(page);
    await page.goto(`${ORIGIN}/owner/nowhere`);
    await expect(page).toHaveURL(/\/collection$/);

    await query("DELETE FROM owner_binding");
    await page.goto(`${ORIGIN}/owner/rules`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Owner controls"
    );
    await expect(sections(page)).toHaveCount(0);
    await expect(page.getByRole("article")).toHaveCount(0);
  });

  test("Rules shows a card per rule kind with its versions and digest, and Confirm waits for evidence and a reason", async ({
    page,
  }) => {
    await signInAsOwner(page);
    await openFromAccountMenu(page);
    await sectionTab(page, "Rules").click();
    const rules = page.getByRole("tabpanel", { name: "Rules" });
    await expect(rules.getByRole("article")).toHaveCount(2);
    for (const name of ["Live derivation", "Marketplace matching"]) {
      const card = rules.getByRole("article", { name });
      await expect(card.getByRole("heading", { name })).toBeVisible();
      await expect(card).toContainText(
        /Version \d+ · digest [0-9a-f]{12} · latest/
      );
      await expect(card).toContainText(/Active: version \d+|No active rule/);
      await expect(card.getByLabel("Rule version")).toBeVisible();
      const confirm = card.getByRole("button", { name: "Confirm rule change" });
      await expect(confirm).toBeDisabled();
      await card
        .getByLabel("Rule evidence URL")
        .fill("https://example.org/rule");
      await expect(confirm).toBeDisabled();
      await card.getByLabel("Rule reason").fill("Checked the rule");
      await expect(confirm).toBeEnabled();
    }
    await expectPageChecks(page, "Owner controls, Rules (desktop)");
  });
});

test.describe("phone", () => {
  test.use({
    viewport: { width: 375, height: 812 },
    isMobile: true,
    hasTouch: true,
  });

  test("Owner controls opens from the account sheet; the tab row and the health table scroll inside themselves, and the page check passes", async ({
    page,
  }) => {
    await signInAsOwner(page);
    const undoHealth = await seedHealth();
    try {
      // Loans took the More slot (#252): Owner controls is in the account sheet.
      const more = page.getByRole("button", { name: "Account", exact: true });
      await more.tap();
      const sheet = page.getByRole("dialog", { name: "Account" });
      await sheet.getByRole("button", { name: "Owner controls" }).tap();
      await expect(page).toHaveURL(/\/owner$/);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(
        "Owner controls"
      );
      await expect(healthRow(page, "Backup")).toContainText("Stale");

      // Wide content scrolls inside its own box, never the page.
      const overflows = (element: HTMLElement) =>
        element.scrollWidth > element.clientWidth;
      await expect.poll(() => sections(page).evaluate(overflows)).toBe(true);
      await expect.poll(() => health(page).evaluate(overflows)).toBe(true);
      await expectPageChecks(page, "Owner controls, Status (phone)");

      // A tab past the right edge comes into view and opens its section.
      await sectionTab(page, "Rules").tap();
      await expect(page).toHaveURL(/\/owner\/rules$/);
      await expect(
        page
          .getByRole("tabpanel", { name: "Rules" })
          .getByRole("article", { name: "Live derivation" })
      ).toBeVisible();
      await expectPageChecks(page, "Owner controls, Rules (phone)");

      await sectionTab(page, /^Attributes/).tap();
      await expect(page).toHaveURL(/\/owner\/attributes$/);
      await expectPageChecks(page, "Owner controls, Attributes (phone)");

      await more.tap();
      await expect(sheet).toBeVisible();
      await expect(
        sheet.getByRole("button", { name: "Owner controls" })
      ).toHaveAttribute("aria-current", "page");
      await expectPageChecks(
        page,
        "Owner controls, account sheet open (phone)"
      );
      await page.keyboard.press("Escape");
      await expect(sheet).toBeHidden();
    } finally {
      await undoHealth();
    }
  });
});
