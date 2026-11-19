// m13 s5: the Move dialog's chosen Location is announced, a Move keeps the card's details open while copies
// remain, toasts never sit on the last row of cards, and the details say "Report card details". Each runs at a
// desktop and a phone size.
import { expect, type Locator, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { signInAsOwner } from "./support/sign-in";
import { startAsNewOwner } from "./support/owner";
import { artUpstream, test } from "./support/art-upstream";

type TreeNode = { id: string; name: string; version: number };

// Helpers copied from collection-aside.spec.ts so that spec stays untouched.
function promoteCatalog(names: Record<string, string>) {
  execFileSync(
    ".venv/bin/python",
    [
      "-c",
      `import json, sys
import test_catalog_search as search
class Imaged(search.SearchSource):
    def fetch(self, source_id):
        record = super().fetch(source_id)
        record["image"] = "https://assets.tcgdex.net/en/fixture/" + source_id
        return record
search.SearchSource = Imaged
search.promote(json.loads(sys.argv[1]))`,
      JSON.stringify(names),
    ],
    { env: { ...process.env, PYTHONPATH: "api:api/tests" } }
  );
}

async function signIn(page: Page) {
  (await artUpstream()).reset();
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await pool.query("DELETE FROM auth_send_event");
    await startAsNewOwner(pool);
  } finally {
    await pool.end();
  }
  await signInAsOwner(page, "/collection");
  await expect(page).toHaveURL(/\/collection$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("All owned");
}

async function createLocation(page: Page, name: string): Promise<string> {
  const response = await page.request.post(
    new URL("/api/location-tree", page.url()).href,
    {
      headers: { origin: new URL(page.url()).origin },
      data: {
        name,
        parent_id: null,
        parent_version: null,
        idempotency_key: randomUUID(),
      },
    }
  );
  expect(response.status()).toBe(201);
  return ((await response.json()) as { location: TreeNode }).location.id;
}

async function addCopies(
  page: Page,
  locationId: string,
  editionId: string,
  quantity: number
) {
  const response = await page.request.post(
    new URL("/api/holdings", page.url()).href,
    {
      headers: { origin: new URL(page.url()).origin },
      data: {
        location_id: locationId,
        edition_id: editionId,
        quantity: String(quantity),
        idempotency_key: randomUUID(),
      },
    }
  );
  expect(response.status(), await response.text()).toBe(200);
}

async function editionOf(sourceId: string): Promise<string> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const { rows } = await pool.query(
      `SELECT e.id FROM catalog_edition e JOIN catalog_printing p ON p.id=e.printing_id
       WHERE p.source_id=$1 AND e.descriptor->>'finish'='normal'`,
      [sourceId]
    );
    return rows[0].id;
  } finally {
    await pool.end();
  }
}

const tiles = (page: Page) =>
  page.getByRole("region", { name: "Cards" }).getByRole("button");
const aside = (page: Page) =>
  page.getByRole("complementary", { name: "Card details" });
const toasts = (page: Page) =>
  page.getByRole("region", { name: "Notifications" });
const bar = (page: Page) => page.getByRole("region", { name: "Selection" });
const CARD = "Aside Abra";

const SIZES = [
  { name: "desktop", viewport: { width: 1280, height: 800 }, phone: false },
  { name: "phone", viewport: { width: 375, height: 812 }, phone: true },
] as const;

for (const size of SIZES) {
  test.describe(`Collection m13 at ${size.name}`, () => {
    test.use({ viewport: size.viewport, hasTouch: size.phone });

    /** Where a card's details show: the aside on a desktop, the sheet on a phone. */
    const panel = (page: Page): Locator =>
      size.phone
        ? page.getByRole("dialog", { name: CARD, exact: true })
        : aside(page);

    /** Picks the first tile: a click on a desktop, a tap on a phone, which opens the sheet. */
    async function openCard(page: Page) {
      if (size.phone) await tiles(page).first().tap();
      else await tiles(page).first().click();
      await expect(panel(page)).toContainText(CARD);
    }

    async function openMoveFromPanel(page: Page) {
      await panel(page)
        .getByRole("button", { name: "Move…", exact: true })
        .click();
    }

    async function seed(page: Page, copies: number) {
      promoteCatalog({ "card-1": CARD });
      await signIn(page);
      const source = await createLocation(page, "Source binder");
      await createLocation(page, "Destination binder");
      await addCopies(page, source, await editionOf("card-1"), copies);
      await page.reload();
      // A long gallery draws only the tiles near the window.
      if (copies <= 12) await expect(tiles(page)).toHaveCount(copies);
      else await expect(tiles(page).first()).toBeVisible();
      return source;
    }

    async function moveOneFromPanel(page: Page, copiesBefore: number) {
      await openMoveFromPanel(page);
      const dialog = page.getByRole("dialog", {
        name: "Move 1 copy",
        exact: true,
      });
      await dialog
        .getByRole("button", { name: "Destination binder", exact: true })
        .click();
      await dialog
        .getByRole("button", { name: "Move 1 copy", exact: true })
        .click();
      await expect(dialog).toHaveCount(0);
      await expect(toasts(page)).toContainText(
        "Moved 1 copy to Destination binder."
      );
      return copiesBefore - 1;
    }

    test("the Move dialog marks the chosen Location as pressed, in a labelled group", async ({
      page,
    }) => {
      await seed(page, 2);
      await openCard(page);
      await openMoveFromPanel(page);
      const dialog = page.getByRole("dialog", {
        name: "Move 1 copy",
        exact: true,
      });
      const destination = dialog.getByRole("button", {
        name: "Destination binder",
        exact: true,
      });
      const source = dialog.getByRole("button", {
        name: "Source binder",
        exact: true,
      });
      await expect(destination).toHaveAttribute("aria-pressed", "false");
      await expect(source).toHaveAttribute("aria-pressed", "false");
      await destination.click();
      await expect(destination).toHaveAttribute("aria-pressed", "true");
      await expect(source).toHaveAttribute("aria-pressed", "false");
      // The choice sits in a labelled group, and the visible check mark stays.
      await expect(
        dialog.getByRole("group", { name: "Destination" })
      ).toBeVisible();
      await expect(destination.locator("svg")).toHaveCount(1);
      await source.click();
      await expect(destination).toHaveAttribute("aria-pressed", "false");
      await expect(source).toHaveAttribute("aria-pressed", "true");
    });

    test("a Move from the card's details keeps the desktop aside open while copies remain, and closes it when none do", async ({
      page,
    }) => {
      test.skip(size.phone, "a phone's sheet closes after a Move");
      await seed(page, 3);
      await openCard(page);
      await expect(panel(page)).toContainText("3 copies here");
      await moveOneFromPanel(page, 3);
      // Two copies of the card remain in Source binder: the aside stays, with the new count, and the card is in
      // the address.
      await expect(panel(page)).toContainText(CARD);
      await expect(panel(page)).toContainText("2 copies here");
      await expect(page).toHaveURL(/[?&]card=/);
      await expect(page.locator("#ws-heading")).toBeFocused();
      // A reload reopens the same card.
      await page.reload();
      await expect(panel(page)).toContainText("2 copies here");
      await expect(page).toHaveURL(/[?&]card=/);

      await moveOneFromPanel(page, 2);
      await expect(panel(page)).toContainText("1 copy here");
      await moveOneFromPanel(page, 1);
      // The last copy left Source binder but is still in All owned, in Destination binder: the aside follows it.
      await expect(panel(page)).toContainText(CARD);
      await expect(panel(page)).toContainText("3 copies here");
      await expect(panel(page)).toContainText("Destination binder");
      await expect(page).toHaveURL(/[?&]card=/);
      await expect(page.locator("#ws-heading")).toBeFocused();
    });

    test("in a Location, moving the last copy out closes the desktop aside", async ({
      page,
    }) => {
      test.skip(size.phone, "a phone's sheet closes after a Move");
      const source = await seed(page, 1);
      await page.goto(
        new URL(`/collection?location=${source}`, page.url()).href
      );
      await expect(tiles(page)).toHaveCount(1);
      await openCard(page);
      await moveOneFromPanel(page, 1);
      // The copy is no longer in this Location: nothing of the card is left to show here.
      await expect(tiles(page)).toHaveCount(0);
      await expect(aside(page)).toContainText(
        "Select a card to see its details."
      );
      await expect(page).not.toHaveURL(/[?&]card=/);
    });

    test("a phone's sheet closes after a Move and the toast's Undo can be pressed", async ({
      page,
    }) => {
      test.skip(!size.phone, "the desktop aside stays open");
      await seed(page, 3);
      await openCard(page);
      await moveOneFromPanel(page, 3);
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(page).not.toHaveURL(/[?&]card=/);
      await expect(page.locator("#ws-heading")).toBeFocused();
      await page.getByRole("button", { name: "Undo", exact: true }).tap();
      await expect(toasts(page)).toContainText("Undo restored 1 copy");
    });

    test("Back and Forward with the Move dialog open leave it working", async ({
      page,
    }) => {
      // A desktop aside writes its address with replace, so its Back leaves Collection altogether.
      test.skip(!size.phone, "the aside has no history entry of its own");
      await seed(page, 3);
      await openCard(page);
      await openMoveFromPanel(page);
      const dialog = page.getByRole("dialog", {
        name: "Move 1 copy",
        exact: true,
      });
      await expect(dialog).toBeVisible();
      await page.goBack();
      // Back leaves the sheet's address; the Move dialog is the collector's own and stays, and it cancels cleanly.
      await expect(page).not.toHaveURL(/[?&]card=/);
      await expect(dialog).toBeVisible();
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await page.goForward();
      await expect(page).toHaveURL(/[?&]card=/);
      await expect(panel(page)).toContainText(CARD);
    });

    test("details say Report card details", async ({ page }) => {
      await seed(page, 1);
      await openCard(page);
      await expect(
        panel(page).getByRole("link", { name: "Report card details" })
      ).toBeVisible();
      await expect(
        panel(page).getByText("Report a problem with this card's data")
      ).toHaveCount(0);
    });

    test("the last row of cards scrolls clear of a toast and of the selection bar", async ({
      page,
    }) => {
      await seed(page, 40);
      // Act through the selection bar so no details panel is in the way.
      if (size.phone) {
        await page.getByRole("button", { name: "Select", exact: true }).click();
        await tiles(page).first().tap();
      } else await tiles(page).first().click();
      await bar(page).getByRole("button", { name: "Actions" }).click();
      await bar(page)
        .getByRole("button", { name: "Move…", exact: true })
        .click();
      const dialog = page.getByRole("dialog", {
        name: "Move 1 copy",
        exact: true,
      });
      await dialog
        .getByRole("button", { name: "Destination binder", exact: true })
        .click();
      await dialog
        .getByRole("button", { name: "Move 1 copy", exact: true })
        .click();
      await expect(toasts(page)).toContainText("Moved 1 copy");

      const clearance = async (withBar: boolean) => {
        await page.evaluate(() =>
          window.scrollTo(0, document.documentElement.scrollHeight)
        );
        const last = await tiles(page).last().boundingBox();
        const toast = await toasts(page).locator("div").first().boundingBox();
        const barBox = withBar ? await bar(page).boundingBox() : null;
        const limit = Math.min(toast!.y, barBox ? barBox.y : Infinity);
        return last!.y + last!.height - limit;
      };
      // The toast alone.
      await expect.poll(() => clearance(false)).toBeLessThanOrEqual(0);
      // The toast stacked over the selection bar.
      if (size.phone) {
        await page.getByRole("button", { name: "Select", exact: true }).click();
        await page.getByRole("button", { name: "Select", exact: true }).click();
        await tiles(page).nth(1).tap();
      } else await tiles(page).nth(1).click();
      await expect(bar(page)).toBeVisible();
      await expect(toasts(page)).toContainText("Moved 1 copy");
      await expect.poll(() => clearance(true)).toBeLessThanOrEqual(0);
    });
  });
}

test.describe("Collection m13 on a desktop selection bar", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("a selection-bar Move keeps the inspected card open while copies remain", async ({
    page,
  }) => {
    promoteCatalog({ "card-1": CARD });
    await signIn(page);
    const source = await createLocation(page, "Source binder");
    await createLocation(page, "Destination binder");
    await addCopies(page, source, await editionOf("card-1"), 3);
    await page.reload();
    await expect(tiles(page)).toHaveCount(3);
    await tiles(page).nth(0).click();
    await tiles(page)
      .nth(1)
      .click({ modifiers: ["ControlOrMeta"] });
    await expect(bar(page)).toContainText("2 copies selected");
    await bar(page).getByRole("button", { name: "Actions" }).click();
    await bar(page).getByRole("button", { name: "Move…", exact: true }).click();
    const dialog = page.getByRole("dialog", {
      name: "Move 2 copies",
      exact: true,
    });
    await dialog
      .getByRole("button", { name: "Destination binder", exact: true })
      .click();
    await dialog
      .getByRole("button", { name: "Move 2 copies", exact: true })
      .click();
    await expect(dialog).toHaveCount(0);
    await expect(aside(page)).toContainText(CARD);
    await expect(aside(page)).toContainText("1 copy here");
    await expect(bar(page)).toHaveCount(0);
  });
});
