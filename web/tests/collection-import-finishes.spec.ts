// Ticket #230: Collection Import finishes (spec "Collection import from other trackers": the finish table, Finish
// unknown, bulk selection and the save bar). A row whose card is known but whose finish isn't, on a card with no
// Unspecified Variant, is Pick a finish under Needs you; its finish picker lists the card's own Editions, and focus
// moves into it and back. Rows are selected one at a time or with Select all in the current filter, and the bar above
// the save bar sets a finish (only where the card has it, saying which rows it couldn't change) or skips them. Skipped
// rows wait under Skipped and can be restored; Finish unknown rows never block saving. Checked at 1280×800 and at
// 375×812 (44 px targets, no horizontal scroll, the selection bar above the tab bar). The catalog is
// api/tests/test_collection_import.py seed_import_catalog; its Fixture Finishes cards have TCGdex's descriptors.
import { test, expect, type Locator, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { Pool } from "pg";
import { startAsNewOwner } from "./support/owner";
import { expectPageChecks } from "./support/page-check";
import { signInAsOwner } from "./support/sign-in";
import { expectTouchTarget } from "./support/touch-target";

const ORIGIN = process.env.TEST_ORIGIN || "http://localhost:5173";
const HEADER_12 =
  "Quantity,Name,Simple Name,Set,Card Number,Set Code,Printing,Condition,Language,Rarity,Product ID,SKU";
/** Exeggcute (no finish), Pineco ("Foil", not in the table) and Suicune (no finish) have no Unspecified Variant, so
 * they wait for a finish; Weepinbell's 1st Edition isn't one of its Editions, so it is Finish unknown; Starmie
 * matches; Flying Pikachu's set isn't in the catalog. 3 cards are ready, of 7. */
const FINISHES = [
  HEADER_12,
  "1,Exeggcute,Exeggcute,Fixture Finishes,1,FF,,Near Mint,English,Common,1,1",
  "1,Pineco,Pineco,Fixture Finishes,3,FF,Foil,Near Mint,English,Common,3,3",
  "1,Suicune,Suicune,Fixture Finishes,2,FF,,Near Mint,English,Rare,2,2",
  "1,Weepinbell,Weepinbell,Jungle,48/64,JU,1st Edition,Near Mint,English,Uncommon,900005,800007",
  "2,Starmie,Starmie,Base Set,064/102,BS,Normal,Near Mint,English,Common,900003,800003",
  "1,Flying Pikachu,Flying Pikachu,Rising Rivals,113/111,RR,Holofoil,Near Mint,English,Secret Rare,900008,800010",
  "",
].join("\n");

function seedImportCatalog() {
  execFileSync(
    ".venv/bin/python",
    [
      "-c",
      "from test_collection_import import seed_import_catalog\nseed_import_catalog()",
    ],
    { env: { ...process.env, PYTHONPATH: "api:api/tests" } }
  );
}

/** Signs in as a new owner, who owns nothing and has Unsorted alone, and lands on Collection. */
async function signIn(page: Page) {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await startAsNewOwner(pool);
    await pool.query("DELETE FROM auth_send_event");
  } finally {
    await pool.end();
  }
  await signInAsOwner(page, "/collection");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("All owned");
}

async function unsortedId(page: Page): Promise<string> {
  const response = await page.request.get(`${ORIGIN}/api/location-tree`);
  const { locations } = (await response.json()) as {
    locations: { id: string; name: string; parent_id: string | null }[];
  };
  return locations.find(
    (node) => node.name === "Unsorted" && node.parent_id === null
  )!.id;
}

/** Every Holding in a Location, as "<quantity> <name>" lines, sorted. */
async function held(page: Page, locationId: string): Promise<string[]> {
  const response = await page.request.get(
    `${ORIGIN}/api/holdings/${locationId}`
  );
  const { holdings } = (await response.json()) as {
    holdings: { printing_name: string; quantity: string }[];
  };
  return holdings
    .map((holding) => `${holding.quantity} ${holding.printing_name}`)
    .sort();
}

const heading = (page: Page) => page.getByRole("heading", { level: 1 });
const rowsList = (page: Page) => page.getByRole("list", { name: "Rows" });
const rowsHeading = (page: Page) =>
  page.getByRole("heading", { level: 2, name: "Rows" });
const chip = (page: Page, name: RegExp) =>
  page.getByRole("group", { name: "Show rows" }).getByRole("button", { name });
const checkbox = (page: Page, row: number) =>
  page.getByRole("checkbox", { name: `Select row ${row}` });
/** The 44 px label around a row's checkbox, which is its tap area. */
const checkboxTarget = (page: Page, row: number) =>
  rowsList(page).locator("label", { has: checkbox(page, row) });
const finishPicker = (page: Page, row: number) =>
  page.getByRole("button", { name: new RegExp(`^Finish of row ${row}: `) });
const bulkBar = (page: Page) =>
  page.getByRole("group", { name: "Selected rows" });
const save = (page: Page) => page.getByRole("region", { name: "Save" });
/** The line that says what the last change did. */
const notice = (page: Page) =>
  page.getByRole("region", { name: "Rows" }).getByRole("status");

/** Opens the upload from the empty Collection, chooses `content` as rows.csv and opens the review. */
async function review(page: Page, content: string, tap = false) {
  const press = (locator: Locator) => (tap ? locator.tap() : locator.click());
  await press(
    page.getByRole("button", { name: "Import from another tracker" })
  );
  await expect(heading(page)).toHaveText("Import your collection");
  const chooser = page.waitForEvent("filechooser");
  await press(page.getByRole("button", { name: /^Choose (another )?file$/ }));
  await (
    await chooser
  ).setFiles({
    name: "rows.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(content),
  });
  await press(page.getByRole("button", { name: "Review import" }));
  await expect(heading(page)).toHaveText("Review import");
}

test.describe("desktop", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("a row's finish is picked from its card's Editions, a bulk finish applies only where it fits, and skipped rows can be restored", async ({
    page,
  }) => {
    seedImportCatalog();
    await signIn(page);
    const unsorted = await unsortedId(page);
    await review(page, FINISHES);
    await expect(chip(page, /^Needs you 4$/)).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    await expect(chip(page, /^Finish unknown 1$/)).toBeVisible();
    await expect(chip(page, /^All 6$/)).toBeVisible();
    await expect(chip(page, /^Skipped 0$/)).toBeVisible();
    await expect(rowsList(page).getByRole("listitem")).toHaveCount(4);
    await expect(rowsList(page).getByRole("listitem").first()).toContainText(
      "Pick a finish"
    );
    await expect(save(page).getByRole("status")).toHaveText(
      "4 rows need you. Fix or skip them to continue. 1 row with finish unknown can be fixed later."
    );
    await expect(
      save(page).getByRole("button", { name: "Add 3 cards to Unsorted" })
    ).toBeDisabled();

    // The finish picker lists the card's own Editions; focus moves into it and back out.
    const picker = finishPicker(page, 1);
    await expect(picker).toHaveAccessibleName("Finish of row 1: Pick a finish");
    await picker.focus();
    await page.keyboard.press("Enter");
    const menu = page.getByRole("menu", {
      name: "Finish of row 1: Pick a finish",
    });
    await expect(menu.getByRole("menuitemradio")).toHaveText([
      "Reverse Holo, Masterball",
      "Reverse Holo, Pokeball",
      "Normal",
      "Reverse Holo",
    ]);
    await expect(menu.getByRole("menuitemradio").first()).toBeFocused();
    await expectPageChecks(
      page,
      "Collection Import review, finish picker open"
    );
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(picker).toBeFocused();
    await picker.click();
    await menu
      .getByRole("menuitemradio", { name: "Reverse Holo, Pokeball" })
      .click();
    // The row leaves Needs you, and focus moves to the row that took its place.
    await expect(chip(page, /^Needs you 3$/)).toBeVisible();
    await expect(notice(page)).toHaveText(
      "Set Reverse Holo, Pokeball on 1 row."
    );
    await expect(checkbox(page, 2)).toBeFocused();

    // Select all in Needs you, then Set finish…: it applies only where the card has that finish.
    await page.getByRole("button", { name: "Select all 3" }).click();
    await expect(bulkBar(page)).toContainText("3 selected");
    for (const row of [2, 3, 6])
      await expect(checkbox(page, row)).toBeChecked();
    await expectPageChecks(page, "Collection Import review, rows selected");
    await bulkBar(page).getByRole("button", { name: "Set finish…" }).click();
    await page
      .getByRole("menu", { name: "Set finish…" })
      .getByRole("menuitem", { name: "Reverse Holo" })
      .click();
    await expect(notice(page)).toHaveText(
      "Set Reverse Holo on 1 row. Rows 3 and 6 can't be Reverse Holo, so they weren't changed."
    );
    await expect(chip(page, /^Needs you 2$/)).toBeVisible();
    await expect(bulkBar(page)).toHaveCount(0);
    await expect(rowsHeading(page)).toBeFocused();

    // Rows chosen one at a time, then Skip: nothing needs you, and Finish unknown doesn't hold up the save.
    await checkbox(page, 3).check();
    await checkbox(page, 6).check();
    await expect(bulkBar(page)).toContainText("2 selected");
    await bulkBar(page).getByRole("button", { name: "Skip" }).click();
    await expect(notice(page)).toHaveText("Skipped 2 rows.");
    await expect(chip(page, /^Needs you 0$/)).toBeVisible();
    await expect(chip(page, /^Skipped 2$/)).toBeVisible();
    await expect(
      page.getByText("Nothing needs you. Every row is ready or skipped.")
    ).toBeVisible();
    await expect(save(page).getByRole("status")).toHaveText(
      "Ready: 5 cards from 4 rows. 1 row with finish unknown can be fixed later."
    );
    await expect(
      save(page).getByRole("button", { name: "Add 5 cards to Unsorted" })
    ).toBeEnabled();

    // Skipped rows are listed under Skipped and can be restored.
    await chip(page, /^Skipped 2$/).click();
    await expect(rowsList(page).getByRole("listitem")).toHaveCount(2);
    await expect(rowsList(page).getByRole("listitem").first()).toContainText(
      "Skipped"
    );
    await page.getByRole("button", { name: "Restore row 6" }).click();
    await expect(chip(page, /^Skipped 1$/)).toBeVisible();
    await expect(chip(page, /^Needs you 1$/)).toBeVisible();
    await expect(
      save(page).getByRole("button", { name: "Add 5 cards to Unsorted" })
    ).toBeDisabled();
    await chip(page, /^Needs you 1$/).click();
    await page.getByRole("button", { name: "Skip row 6" }).click();
    await expect(chip(page, /^Needs you 0$/)).toBeVisible();

    // A Finish unknown row's finish is picked the same way.
    await chip(page, /^Finish unknown 1$/).click();
    await finishPicker(page, 4).click();
    const weepinbell = page.getByRole("menu", {
      name: "Finish of row 4: Unspecified Variant",
    });
    await expect(
      weepinbell.getByRole("menuitemradio", { name: "Unspecified Variant" })
    ).toHaveAttribute("aria-checked", "true");
    await weepinbell.getByRole("menuitemradio", { name: "Normal" }).click();
    await expect(chip(page, /^Finish unknown 0$/)).toBeVisible();
    await expect(
      page.getByText("No rows have an unknown finish.")
    ).toBeVisible();
    await expect(save(page).getByRole("status")).toHaveText(
      "Ready: 5 cards from 4 rows."
    );
    await save(page)
      .getByRole("button", { name: "Add 5 cards to Unsorted" })
      .click();
    await expect(heading(page)).toHaveText("Unsorted");
    await expect
      .poll(() => held(page, unsorted))
      .toEqual(["1 Exeggcute", "1 Pineco", "1 Weepinbell", "2 Starmie"]);
  });
});

test.describe("phone", () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true });

  test("on a phone, rows are selected with 44 px checkboxes and the selection bar sits above the tab bar", async ({
    page,
  }) => {
    seedImportCatalog();
    await signIn(page);
    await review(page, FINISHES, true);
    await expect(rowsList(page).getByRole("listitem")).toHaveCount(4);
    await expectTouchTarget(checkboxTarget(page, 1));
    await expectTouchTarget(finishPicker(page, 1));
    await expectTouchTarget(page.getByRole("button", { name: "Skip row 1" }));
    await expectTouchTarget(page.getByRole("button", { name: "Select all 4" }));
    await expectTouchTarget(chip(page, /^Finish unknown 1$/));
    await expectPageChecks(page, "phone Collection Import review, finishes");

    await checkboxTarget(page, 1).tap();
    await checkboxTarget(page, 2).tap();
    await expect(checkbox(page, 1)).toBeChecked();
    await expect(bulkBar(page)).toContainText("2 selected");
    const setFinish = bulkBar(page).getByRole("button", {
      name: "Set finish…",
    });
    await expectTouchTarget(setFinish);
    await expectTouchTarget(
      bulkBar(page).getByRole("button", { name: "Skip" })
    );
    await expectTouchTarget(
      bulkBar(page).getByRole("button", { name: "Clear" })
    );
    const tabBar = page.getByRole("navigation", { name: "Main views" });
    await expect
      .poll(async () => {
        const bar = await bulkBar(page).boundingBox();
        const tabs = await tabBar.boundingBox();
        return bar && tabs ? bar.y + bar.height - tabs.y : Infinity;
      })
      .toBeLessThanOrEqual(0.5);
    await expectPageChecks(
      page,
      "phone Collection Import review, rows selected"
    );

    await setFinish.tap();
    const menu = page.getByRole("menu", { name: "Set finish…" });
    await expect(menu.getByRole("menuitem")).toHaveCount(7);
    await expectTouchTarget(
      menu.getByRole("menuitem", { name: "Reverse Holo" })
    );
    await expectPageChecks(
      page,
      "phone Collection Import review, Set finish… open"
    );
    await menu.getByRole("menuitem", { name: "Reverse Holo" }).tap();
    await expect(notice(page)).toHaveText("Set Reverse Holo on 2 rows.");
    await expect(chip(page, /^Needs you 2$/)).toBeVisible();

    await page.getByRole("button", { name: "Select all 2" }).tap();
    await bulkBar(page).getByRole("button", { name: "Skip" }).tap();
    await expect(chip(page, /^Needs you 0$/)).toBeVisible();
    const add = page.getByRole("button", { name: "Add 5 cards to Unsorted" });
    await expect(add).toBeEnabled();
    await expect(add).toBeInViewport();
    await expectPageChecks(
      page,
      "phone Collection Import review, rows skipped"
    );
  });

  test("the seven-item bulk finish menu fits a 320 px phone and keeps keyboard items hittable", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    seedImportCatalog();
    await signIn(page);
    await review(page, FINISHES, true);
    await page.getByRole("button", { name: "Select all 4" }).tap();
    const trigger = bulkBar(page).getByRole("button", {
      name: "Set finish…",
      exact: true,
    });
    await trigger.press("ArrowUp");
    const menu = page.getByRole("menu", { name: "Set finish…" });
    const items = menu.getByRole("menuitem");
    await expect(items).toHaveCount(7);
    const expectPanelBounds = async () => {
      await expect
        .poll(() =>
          menu.evaluate((el) => {
            const panel = el
              .closest<HTMLElement>("[data-menu-panel]")!
              .getBoundingClientRect();
            return (
              panel.left >= 7.5 &&
              panel.top >= 7.5 &&
              panel.right <= innerWidth - 7.5 &&
              panel.bottom <= innerHeight - 7.5 &&
              document.documentElement.scrollWidth <= innerWidth
            );
          })
        )
        .toBe(true);
    };
    const expectFocusedHit = async (item: Locator) => {
      await expect(item).toBeFocused();
      // Sample after the captured scroll events and positioning frames have settled; a transient hit is insufficient.
      expect(
        await item.evaluate(async (el) => {
          for (let frame = 0; frame < 8; frame++) {
            await new Promise<void>((resolve) =>
              requestAnimationFrame(() => resolve())
            );
            const r = el.getBoundingClientRect();
            const hit = document.elementFromPoint(
              r.left + r.width / 2,
              r.top + r.height / 2
            );
            const viewport = el
              .closest("ul")!
              .parentElement!.getBoundingClientRect();
            if (
              document.activeElement !== el ||
              r.top < viewport.top - 0.5 ||
              r.bottom > viewport.bottom + 0.5 ||
              !hit ||
              !el.contains(hit)
            )
              return false;
          }
          return true;
        })
      ).toBe(true);
    };
    await expectPanelBounds();
    await expectFocusedHit(items.last()); // ArrowUp-open starts at the last item.
    await page.keyboard.press("Home");
    // Hit-test every item in the scrolling list as keyboard navigation reveals it.
    for (let index = 0; index < 7; index++) {
      if (index > 0) await page.keyboard.press("ArrowDown");
      await expectFocusedHit(items.nth(index));
      await expectPanelBounds();
    }
    await page.keyboard.press("Home");
    await page.keyboard.press("End");
    await expectFocusedHit(items.last());
    await expectPanelBounds();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });
});
