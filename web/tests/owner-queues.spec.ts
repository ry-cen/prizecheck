// Ticket #168: Owner controls' Catalog, Metadata and Missing cards queues (spec "Missing cards and Owner
// controls"). Each queue is a ScrollTable; Review opens the item's card in a row under it, pinned to the
// table's visible area while the table scrolls sideways; every decision takes a reason, then (except a
// missing-card Request information or Reject) the code step. The shared page check runs at 1280×800 and
// 375×812 with each card open. The full decision flows with real codes are in catalog-reconciliation,
// metadata-review and missing-cards.
import { test, expect, type Locator, type Page } from "@playwright/test";
import { signInAsOwner as fakeSignInAsOwner } from "./support/sign-in";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
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

/** Signs in at /collection through the OAuth test fake. seedQueues binds the owner role afterwards. */
async function signInAsOwner(page: Page) {
  await query("DELETE FROM auth_send_event");
  await fakeSignInAsOwner(page, "/collection");
  await expect(
    page.getByRole("navigation", { name: "Main views" })
  ).toBeVisible();
}

type Seeded = { set: string; undo: () => Promise<void> };

/**
 * One item in each queue: a catalog review of "Queue Pikachu" whose only Edition holds 3 copies, a
 * metadata report on that Edition, and two missing-card reports (B is newer, so it is listed first).
 * The catalog fixture resets the catalog and the owner binding, so the owner is bound afterwards.
 */
async function seedQueues(page: Page): Promise<Seeded> {
  execFileSync(
    ".venv/bin/python",
    [
      "-c",
      `from test_catalog_search import promote
promote({'queues-1':'Queue Pikachu'})`,
    ],
    { env: { ...process.env, PYTHONPATH: "api:api/tests" } }
  );
  await query(
    'INSERT INTO owner_binding(singleton,user_id) SELECT true,id FROM "user" WHERE email=$1 ON CONFLICT(singleton) DO UPDATE SET user_id=EXCLUDED.user_id',
    [OWNER_EMAIL]
  );
  const [owner] = await query<{ id: string }>(
    'SELECT id FROM "user" WHERE email=$1',
    [OWNER_EMAIL]
  );
  await query(
    "INSERT INTO inventory_owner(user_id) VALUES($1) ON CONFLICT DO NOTHING",
    [owner.id]
  );
  const [edition] = await query<{ id: string; printing_id: string }>(
    "SELECT e.id,e.printing_id FROM catalog_edition e JOIN catalog_printing p ON p.id=e.printing_id WHERE p.source_id='queues-1'"
  );
  const [review] = await query<{ id: string }>(
    "INSERT INTO catalog_review(printing_id,source_id,kind,source_fingerprint,detail,candidate) VALUES($1,'queues-1','name_change',$2,'Incoming name requires physical identity review','{\"name\":\"Queue Raichu\"}') RETURNING id",
    [edition.printing_id, `queues-${randomUUID()}`]
  );
  const leaf = randomUUID();
  await query(
    "INSERT INTO location(id,owner_id,name,kind) VALUES($1,$2,'Queue binder','storage_leaf')",
    [leaf, owner.id]
  );
  await query("INSERT INTO holding VALUES($1,$2,$3,3,1)", [
    owner.id,
    leaf,
    edition.id,
  ]);
  const metadata = await page.request.post(
    `${ORIGIN}/api/catalog/metadata-reports`,
    {
      headers: { origin: ORIGIN },
      data: {
        target: "marketplace",
        issue: "incorrect",
        printing_id: edition.printing_id,
        edition_id: edition.id,
        proposed: { product_id: 4321 },
        evidence_url: "https://example.org/queue-listing",
        note: "Wrong product listed",
      },
    }
  );
  expect(metadata.status()).toBe(201);
  const set = `Q168-${randomUUID().slice(0, 8)}`;
  const reports: string[] = [];
  for (const [letter, number] of [
    ["A", "1"],
    ["B", "2"],
  ]) {
    const created = await page.request.post(
      `${ORIGIN}/api/missing-card-reports`,
      {
        headers: { origin: ORIGIN },
        data: {
          kind: "printing",
          set_id: set,
          set_name: set,
          collector_number: number,
          english_name: `Queue Card ${letter}`,
          evidence_url: "https://example.org/queue-photo",
          note: `Card ${letter} is missing from the set list.`,
        },
      }
    );
    expect(created.status()).toBe(201);
    reports.push(((await created.json()) as { id: string }).id);
  }
  const metadataId = ((await metadata.json()) as { id: string }).id;
  return {
    set,
    undo: async () => {
      await query("DELETE FROM missing_card_report WHERE id=ANY($1)", [
        reports,
      ]);
      await query("DELETE FROM catalog_metadata_report WHERE id=$1", [
        metadataId,
      ]);
      await query("DELETE FROM catalog_review WHERE id=$1", [review.id]);
      await query("DELETE FROM holding WHERE location_id=$1", [leaf]);
      await query("DELETE FROM location WHERE id=$1", [leaf]);
    },
  };
}

const sectionTab = (page: Page, name: RegExp) =>
  page
    .getByRole("tablist", { name: "Owner controls sections" })
    .getByRole("tab", { name });

async function openSection(page: Page, name: RegExp, address: RegExp) {
  await sectionTab(page, name).click();
  await expect(page).toHaveURL(address);
}

const catalogQueue = (page: Page) =>
  page.getByRole("region", { name: "Catalog reconciliation" });
const metadataQueue = (page: Page) =>
  page.getByRole("region", { name: "Catalog metadata review" });
const missingQueue = (page: Page) =>
  page.getByRole("region", { name: "Missing-card review queue" });
const notifications = (page: Page) =>
  page.getByRole("region", { name: "Notifications" });

/** Opens a row's card with its Review button; the card takes the focus in its reason field. */
async function openCard(queue: Locator, review: string | RegExp | Locator) {
  const button =
    typeof review === "string" || review instanceof RegExp
      ? queue.getByRole("button", { name: review })
      : review;
  await button.click();
  await expect(button).toHaveAttribute("aria-expanded", "true");
  const card = queue.getByRole("article");
  await expect(card).toHaveCount(1);
  await expect(card.getByLabel("Review reason")).toBeFocused();
  return card;
}

/** Scrolls a queue table fully sideways and checks its open card stays on the table's visible area. */
async function expectCardPinned(table: Locator) {
  await expect
    .poll(() => table.evaluate((box) => box.scrollWidth > box.clientWidth))
    .toBe(true);
  await table.evaluate((box) => {
    box.scrollLeft = box.scrollWidth;
  });
  await expect
    .poll(() =>
      table.evaluate((box) => {
        const card = box.querySelector("article")!.parentElement!;
        const region = box.getBoundingClientRect();
        const pinned = card.getBoundingClientRect();
        return {
          scrolled: box.scrollLeft > 0,
          atLeftEdge:
            Math.abs(pinned.left - (region.left + box.clientLeft)) < 1.5,
          fullWidth: Math.abs(pinned.width - box.clientWidth) < 1.5,
        };
      })
    )
    .toEqual({ scrolled: true, atLeftEdge: true, fullWidth: true });
}

test.describe("desktop", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("each queue is a table, and Review opens one card at a time inline with Close", async ({
    page,
  }) => {
    await signInAsOwner(page);
    const seeded = await seedQueues(page);
    try {
      await page.goto(`${ORIGIN}/owner/catalog`);

      // Catalog: the table's columns, then the card with the incoming change and each Edition's Holdings.
      const catalog = catalogQueue(page);
      const catalogTable = catalog.getByRole("region", {
        name: "Pending catalog reviews",
      });
      await expect(catalogTable.getByRole("columnheader")).toHaveText([
        "Card",
        "Set · number",
        "Kind",
        "Reports",
        "Opened",
        "Age",
        "Review",
      ]);
      await expectPageChecks(page, "Catalog queue (desktop)");
      const review = catalog.getByRole("button", {
        name: "Review Queue Pikachu · queues-1",
      });
      const catalogCard = await openCard(catalog, review);
      await expect(
        catalogCard.getByRole("region", { name: "Incoming change" })
      ).toContainText("Queue Raichu");
      const mapping = catalogCard.getByRole("region", {
        name: "Edition mapping",
      });
      await expect(
        mapping
          .getByRole("row")
          .filter({ has: page.getByRole("cell", { name: "Normal" }) })
          .getByRole("cell")
          .nth(1)
      ).toHaveText("3");
      await catalogCard
        .getByRole("combobox", { name: /^Decision/ })
        .selectOption("deprecate_printing");
      await expect(mapping.getByRole("columnheader")).toHaveText([
        "Edition",
        "Holdings",
        "Replacement Edition",
      ]);
      await expectPageChecks(page, "Catalog queue, card open (desktop)");
      await catalogCard.getByRole("button", { name: "Close" }).click();
      await expect(catalogCard).toHaveCount(0);
      await expect(review).toBeFocused();
      await expect(review).toHaveAttribute("aria-expanded", "false");

      // Metadata: source and reviewed values, the linked report, and the folded history.
      await openSection(page, /^Metadata/, /\/owner\/metadata$/);
      const metadata = metadataQueue(page);
      await expectPageChecks(page, "Metadata queue (desktop)");
      const metadataCard = await openCard(metadata, /^Review Queue Pikachu · /);
      await expect(
        metadataCard.getByRole("region", { name: "Source and reviewed values" })
      ).toBeVisible();
      await expect(metadataCard).toContainText("Note: Wrong product listed");
      await expect(
        metadataCard.getByRole("region", { name: "Decision history" })
      ).toHaveCount(0);
      await metadataCard.getByRole("button", { name: "Show history" }).click();
      await expect(
        metadataCard.getByRole("region", { name: "Decision history" })
      ).toBeVisible();
      await expectPageChecks(page, "Metadata queue, card open (desktop)");

      // Missing cards: one card at a time; Begin a record directly is folded above the table.
      await openSection(page, /^Missing cards/, /\/owner\/missing$/);
      const missing = missingQueue(page);
      await expect(
        missing.getByRole("form", { name: "Begin a record directly" })
      ).toHaveCount(0);
      await missing
        .getByRole("button", { name: "Begin a record directly" })
        .click();
      await expect(
        missing.getByRole("form", { name: "Begin a record directly" })
      ).toBeVisible();
      await expectPageChecks(
        page,
        "Missing cards, Begin a record open (desktop)"
      );
      await missing
        .getByRole("button", { name: "Begin a record directly" })
        .click();
      await openCard(missing, `Review Queue Card A · ${seeded.set} #1`);
      const card = await openCard(
        missing,
        `Review Queue Card B · ${seeded.set} #2`
      );
      await expect(card).toHaveAccessibleName(
        `Queue Card B · ${seeded.set} #2`
      );
      await expect(card).toContainText("Card B is missing from the set list.");
      await expect(
        card.getByRole("link", { name: "Open link" })
      ).toHaveAttribute("href", "https://example.org/queue-photo");
      await expectPageChecks(page, "Missing cards queue, card open (desktop)");
    } finally {
      await seeded.undo();
    }
  });

  test("decisions take a reason and the code step, except a missing-card Request information or Reject", async ({
    page,
  }) => {
    await signInAsOwner(page);
    const seeded = await seedQueues(page);
    try {
      // Catalog and Metadata: Confirm decision waits for a reason, a review evidence URL and six digits.
      for (const [section, address, queue, review] of [
        [
          /^Catalog/,
          /\/owner\/catalog$/,
          catalogQueue(page),
          "Review Queue Pikachu · queues-1",
        ],
        [
          /^Metadata/,
          /\/owner\/metadata$/,
          metadataQueue(page),
          /^Review Queue Pikachu · /,
        ],
      ] as const) {
        await page.goto(`${ORIGIN}/owner`);
        await openSection(page, section, address);
        const card = await openCard(queue, review);
        await card
          .getByRole("combobox", { name: /^Decision/ })
          .selectOption({ index: 0 });
        const confirm = card.getByRole("button", { name: "Confirm decision" });
        await expect(
          card.getByRole("button", { name: "Send code" })
        ).toBeEnabled();
        await expect(confirm).toBeDisabled();
        await card.getByLabel("Review reason").fill("Checked by hand");
        await card.getByLabel("Fresh six-digit code").fill("123456");
        await expect(confirm).toBeDisabled();
        await card
          .getByLabel("Review evidence URL")
          .fill("https://example.org/evidence");
        await card.getByLabel("Fresh six-digit code").fill("12345");
        await expect(confirm).toBeDisabled();
        await card.getByLabel("Fresh six-digit code").fill("123456");
        await expect(confirm).toBeEnabled();
      }

      // Missing cards: no evidence field; Request information and Reject need only the reason.
      await page.goto(`${ORIGIN}/owner/missing`);
      const missing = missingQueue(page);
      const table = missing.getByRole("region", { name: "Open reports" });
      const reviewA = missing.getByRole("button", {
        name: `Review Queue Card A · ${seeded.set} #1`,
      });
      const reviewB = missing.getByRole("button", {
        name: `Review Queue Card B · ${seeded.set} #2`,
      });
      let card = await openCard(missing, reviewB);
      await expect(card.getByLabel("Review evidence URL")).toHaveCount(0);
      const ask = card.getByRole("button", { name: "Request information" });
      const reject = card.getByRole("button", { name: "Reject" });
      const approve = card.getByRole("button", {
        name: "Approve shared record",
      });
      await expect(ask).toBeDisabled();
      await expect(reject).toBeDisabled();
      await card.getByLabel("Fresh six-digit code").fill("123456");
      await expect(approve).toBeDisabled();
      await card.getByLabel("Review reason").fill("Which print run is this?");
      await expect(ask).toBeEnabled();
      await expect(reject).toBeEnabled();
      await expect(approve).toBeEnabled();

      // Request information keeps the row, now "needs info", and returns focus to its Review button.
      await ask.click();
      await expect(notifications(page)).toContainText(
        `Information requested from the reporter: Queue Card B · ${seeded.set} #2.`
      );
      await expect(card).toHaveCount(0);
      await expect(
        table.getByRole("row").filter({ hasText: "Queue Card B" })
      ).toContainText("needs info");
      await expect(reviewB).toBeFocused();
      await expect
        .poll(
          async () =>
            (
              await query<{ status: string }>(
                "SELECT status FROM missing_card_report WHERE set_id=$1 AND collector_number='2'",
                [seeded.set]
              )
            )[0].status
        )
        .toBe("needs_info");

      // Reject removes the row; focus moves to the next row's Review button and the tab count drops.
      card = await openCard(missing, reviewB);
      await card.getByLabel("Review reason").fill("Not an English card");
      await card.getByRole("button", { name: "Reject" }).click();
      await expect(notifications(page)).toContainText(
        `Report rejected: Queue Card B · ${seeded.set} #2.`
      );
      await expect(reviewB).toHaveCount(0);
      await expect(reviewA).toBeFocused();
      const [open] = await query<{ n: number }>(
        "SELECT count(*)::int AS n FROM missing_card_report WHERE status IN ('pending','needs_info')"
      );
      await expect(sectionTab(page, /^Missing cards/)).toHaveAccessibleName(
        `Missing cards ${open.n}`
      );
      await expectPageChecks(
        page,
        "Missing cards queue, after Reject (desktop)"
      );
    } finally {
      await seeded.undo();
    }
  });
});

test.describe("phone", () => {
  test.use({
    viewport: { width: 375, height: 812 },
    isMobile: true,
    hasTouch: true,
  });

  test("each queue's card stays pinned while its table scrolls sideways, and the page check passes", async ({
    page,
  }) => {
    await signInAsOwner(page);
    const seeded = await seedQueues(page);
    try {
      for (const [address, queue, tableName, review] of [
        [
          "/owner/catalog",
          catalogQueue(page),
          "Pending catalog reviews",
          "Review Queue Pikachu · queues-1",
        ],
        [
          "/owner/metadata",
          metadataQueue(page),
          "Metadata targets",
          /^Review Queue Pikachu · /,
        ],
        [
          "/owner/missing",
          missingQueue(page),
          "Open reports",
          `Review Queue Card A · ${seeded.set} #1`,
        ],
      ] as const) {
        await page.goto(`${ORIGIN}${address}`);
        const table = queue.getByRole("region", { name: tableName });
        await expect(table).toBeVisible();
        await expectPageChecks(page, `${tableName} (phone)`);
        await openCard(queue, review);
        await expectCardPinned(table);
        await expectPageChecks(page, `${tableName}, card open (phone)`);
        if (tableName === "Metadata targets") {
          await queue.getByRole("button", { name: "Show history" }).tap();
          await expect(
            queue.getByRole("region", { name: "Decision history" })
          ).toBeVisible();
          await expectPageChecks(page, `${tableName}, history open (phone)`);
        }
      }
      const missing = missingQueue(page);
      await missing
        .getByRole("button", { name: "Begin a record directly" })
        .tap();
      await expect(
        missing.getByRole("form", { name: "Begin a record directly" })
      ).toBeVisible();
      await expectPageChecks(
        page,
        "Missing cards, Begin a record open (phone)"
      );
    } finally {
      await seeded.undo();
    }
  });
});
