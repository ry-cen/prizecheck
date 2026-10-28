// Tickets #170 and #193: Owner controls' Attributes queue, on the shared ReviewQueue (spec "Missing cards and Owner controls", "Card type: one
// source"). The queue is a ScrollTable; Review opens the review card inline, pinned to the table's visible
// width; a Trainer Type correction takes a reason and evidence and closes the linked report;
// Reject report needs only the reason. The shared page check runs at 1280×800 and 375×812 with the card open
// and closed.
import { test, expect, type Locator, type Page } from "@playwright/test";
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

/** A fresh catalog of Switch (a Trainer whose source gives no Trainer Type) and Bulbasaur, through the real
 * import, so their attributes come from the real derivation rules. It also unbinds the owner. */
function seedCatalog() {
  execFileSync(
    ".venv/bin/python",
    [
      "-c",
      `from test_catalog import reset_catalog
from test_catalog_metadata import Records
from test_catalog_reconciliation import run
from test_card_attributes import BULBASAUR_ME, SWITCH_ME
reset_catalog()
run(Records(SWITCH_ME, BULBASAUR_ME))`,
    ],
    { env: { ...process.env, PYTHONPATH: "api:api/tests" } }
  );
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
}

const switchId = async () =>
  (
    await query<{ id: string }>(
      "SELECT id FROM catalog_printing WHERE source_id='me01-130'"
    )
  )[0].id;

/** Files a collector report on Switch as the signed-in user. */
async function reportSwitch(page: Page, proposed: Record<string, unknown>) {
  const response = await page.request.post(
    `${ORIGIN}/api/catalog/attribute-reports`,
    {
      headers: { origin: ORIGIN },
      data: {
        printing_id: await switchId(),
        proposed,
        evidence_url: "https://example.org/switch-scan",
        note: "The card says Item above its name.",
      },
    }
  );
  expect(response.status()).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

async function openAttributes(page: Page) {
  await page.goto(`${ORIGIN}/owner/attributes`);
  await expect(
    page
      .getByRole("tablist", { name: "Owner controls sections" })
      .getByRole("tab", { name: /^Attributes/ })
  ).toHaveAttribute("aria-selected", "true");
}

const queue = (page: Page) =>
  page.getByRole("region", { name: "Attribute review queue" });
const queueRow = (page: Page, name: string) =>
  queue(page)
    .getByRole("row")
    .filter({ has: page.getByRole("cell", { name, exact: true }) });
const reviewCard = (page: Page, name: string) =>
  page.getByRole("article", { name });
const valueCells = (card: Locator, attribute: string) =>
  card
    .getByRole("region", { name: "Attribute values" })
    .getByRole("row")
    .filter({
      has: card.page().getByRole("rowheader", { name: attribute, exact: true }),
    })
    .getByRole("cell");

test.describe("desktop", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("the queue corrects a Trainer Type with a reason and evidence, and the linked report closes with it", async ({
    page,
  }) => {
    seedCatalog();
    await signInAsOwner(page);
    const reportId = await reportSwitch(page, { trainer_type: "item" });
    await openAttributes(page);
    await expect(
      page
        .getByRole("tablist", { name: "Owner controls sections" })
        .getByRole("tab", { name: /^Attributes/ })
    ).toHaveAccessibleName("Attributes 1");

    await expect(queue(page).getByRole("columnheader")).toHaveText([
      "Card",
      "Set · number",
      "Kind",
      "Reports",
      "Opened",
      "Age",
      "Review",
    ]);
    const row = queueRow(page, "Switch");
    await expect(row.getByRole("cell")).toContainText([
      "Switch",
      "me01 · 130",
      "Collector report",
      "1",
    ]);
    await expectPageChecks(page, "Owner controls, Attributes queue (desktop)");

    const review = row.getByRole("button", { name: "Review Switch" });
    await expect(review).toHaveAttribute("aria-expanded", "false");
    await review.click();
    await expect(review).toHaveAttribute("aria-expanded", "true");
    const card = reviewCard(page, "Switch");
    await expect(card.getByLabel("Reason")).toBeFocused();

    // Derived, correction and effective values per attribute, Trainer Type and Evolves from included.
    await expect(valueCells(card, "Card kind")).toHaveText([
      "Trainer",
      "Not corrected",
      "Trainer",
    ]);
    await expect(valueCells(card, "Trainer Type")).toHaveText([
      "Unknown",
      "Not corrected",
      "Unknown",
    ]);
    await expect(valueCells(card, "Evolves from")).toHaveText([
      "None",
      "Not reviewed",
      "None",
    ]);
    const reports = card.getByRole("region", { name: "Collector reports" });
    await expect(reports).toContainText("Proposed: Trainer Type: Item");
    await expect(reports).toContainText("The card says Item above its name.");

    const confirm = card.getByRole("button", { name: "Confirm decision" });
    await expect(confirm).toBeDisabled();
    await expect(card.getByLabel("Decision").locator("option")).toHaveText([
      "Correct",
    ]);
    // A Select's label wraps its options, so the combobox is found by its accessible name.
    await card
      .getByRole("combobox", { name: "Trainer Type", exact: true })
      .selectOption("item");
    await card.getByLabel("Reason").fill("Printed as an Item");
    await card
      .getByLabel("Review evidence URL")
      .fill("https://example.org/switch-scan");
    await expect(confirm).toBeEnabled();
    await expectPageChecks(
      page,
      "Owner controls, Attributes review card open (desktop)"
    );

    await confirm.click();

    await expect(
      page.getByRole("region", { name: "Notifications" })
    ).toContainText("Attributes corrected: Switch.");
    await expect(card).toHaveCount(0);
    await expect(queue(page)).toHaveCount(0);
    await expect(page.getByText("Nothing waits for review.")).toBeVisible();
    await expectPageChecks(page, "Owner controls, Attributes queue (empty)");
    await expect(
      page.getByRole("heading", { name: "Card attributes" })
    ).toBeFocused();
    await expect(
      page
        .getByRole("tablist", { name: "Owner controls sections" })
        .getByRole("tab", { name: /^Attributes/ })
    ).toHaveAccessibleName("Attributes 0");
    await expect
      .poll(
        async () =>
          (
            await query<{ status: string }>(
              "SELECT status FROM catalog_attribute_report WHERE id=$1",
              [reportId]
            )
          )[0].status
      )
      .toBe("approved");
    await expect
      .poll(
        async () =>
          (
            await query<{ trainer_type: string | null }>(
              "SELECT trainer_type FROM catalog_card_attribute WHERE printing_id=$1",
              [await switchId()]
            )
          )[0].trainer_type
      )
      .toBe("item");
  });

  test("Refresh queue reads the queue again", async ({ page }) => {
    seedCatalog();
    await signInAsOwner(page);
    await openAttributes(page);
    await expect(page.getByText("Nothing waits for review.")).toBeVisible();
    await reportSwitch(page, { trainer_type: "item" });
    await page.getByRole("button", { name: "Refresh queue" }).click();
    await expect(queueRow(page, "Switch")).toHaveCount(1);
  });

  test("Close returns focus to Review, and Reject report needs only the reason", async ({
    page,
  }) => {
    seedCatalog();
    await signInAsOwner(page);
    const reportId = await reportSwitch(page, { trainer_type: "supporter" });
    await openAttributes(page);
    const review = queueRow(page, "Switch").getByRole("button", {
      name: "Review Switch",
    });
    await review.click();
    const card = reviewCard(page, "Switch");
    await card.getByRole("button", { name: "Close" }).click();
    await expect(card).toHaveCount(0);
    await expect(review).toBeFocused();
    await expect(review).toHaveAttribute("aria-expanded", "false");

    await review.click();
    const reject = card.getByRole("button", { name: "Reject report" });
    await expect(reject).toBeDisabled();
    await expect(
      card.getByRole("button", { name: "Ask for information" })
    ).toBeDisabled();
    await card.getByLabel("Reason").fill("Switch is an Item, not a Supporter");
    await expect(reject).toBeEnabled();
    await reject.click();

    await expect(
      page.getByRole("region", { name: "Notifications" })
    ).toContainText("Report rejected.");
    await expect(queue(page)).toHaveCount(0);
    await expect
      .poll(
        async () =>
          (
            await query<{ status: string }>(
              "SELECT status FROM catalog_attribute_report WHERE id=$1",
              [reportId]
            )
          )[0].status
      )
      .toBe("rejected");
  });
});

test.describe("phone", () => {
  test.use({
    viewport: { width: 375, height: 812 },
    isMobile: true,
    hasTouch: true,
  });

  test("the review card stays pinned to the queue's visible width while the queue scrolls sideways", async ({
    page,
  }) => {
    seedCatalog();
    await signInAsOwner(page);
    await reportSwitch(page, { trainer_type: "item" });
    await openAttributes(page);
    const overflows = (element: HTMLElement) =>
      element.scrollWidth > element.clientWidth;
    await expect.poll(() => queue(page).evaluate(overflows)).toBe(true);
    await expectPageChecks(page, "Owner controls, Attributes queue (phone)");

    await queueRow(page, "Switch")
      .getByRole("button", { name: "Review Switch" })
      .tap();
    const card = reviewCard(page, "Switch");
    await expect(card.getByLabel("Reason")).toBeVisible();
    await queue(page).evaluate((element) => {
      element.scrollLeft = element.scrollWidth;
    });
    await expect
      .poll(() => queue(page).evaluate((element) => element.scrollLeft))
      .toBeGreaterThan(0);
    // Pinned: the card's box starts at the queue's inner left edge and is as wide as its visible area.
    await expect
      .poll(() =>
        queue(page).evaluate((box) => {
          const pinned = box
            .querySelector("article")!
            .parentElement!.getBoundingClientRect();
          const region = box.getBoundingClientRect();
          return {
            scrolled: box.scrollLeft > 0,
            atLeftEdge:
              Math.abs(pinned.left - (region.left + box.clientLeft)) < 1.5,
            fullWidth: Math.abs(pinned.width - box.clientWidth) < 1.5,
          };
        })
      )
      .toEqual({ scrolled: true, atLeftEdge: true, fullWidth: true });
    await expectPageChecks(
      page,
      "Owner controls, Attributes review card open (phone)"
    );
  });
});
