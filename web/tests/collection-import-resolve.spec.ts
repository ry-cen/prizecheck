// Ticket #229: Collection Import resolves flagged rows in the review (spec "Collection import from other trackers").
// A row whose number fails is Matched by name when its set has one card of that name, and doesn't hold up the save.
// Pick one, Not found and Can't read rows open an inline resolver (Fix): the cards the row could be, a catalog search
// and Skip row; focus moves into the resolver and back out. Skip all skips every row under Needs you, skipped rows can
// be restored, and Download skipped rows returns them in the file's own columns. The save stays disabled, and its
// button says why, while any row needs the collector. Checked at 1280×800 and at 375×812 (44 px targets, no horizontal
// scroll). The catalog is api/tests/test_collection_import.py seed_import_catalog with
// api/tests/test_collection_import_matching.py's cards (seed): two Klaras in Chilling Reign, no Charizard.
import { test, expect, type Locator, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { startAsNewOwner } from "./support/owner";
import { expectPageChecks } from "./support/page-check";
import { signInAsOwner } from "./support/sign-in";
import { expectTouchTarget } from "./support/touch-target";

const ORIGIN = process.env.TEST_ORIGIN || "http://localhost:5173";
const HEADER_12 =
  "Quantity,Name,Simple Name,Set,Card Number,Set Code,Printing,Condition,Language,Rarity,Product ID,SKU";
const CANT_READ =
  "0,Starmie,Starmie,Base Set,064/102,BS,Normal,Near Mint,English,Common,900003,800013";
const MISSING =
  "1,Missingno,Missingno,Base Set,201/102,BS,Normal,Near Mint,English,Common,900099,800014";
/** Row 1's number fails but Base Set has one Starmie (Matched by name); Klara has two cards in Chilling Reign (Pick
 * one); Charizard isn't in the catalog (Not found); row 4's quantity is 0 (Can't read); Missingno isn't either;
 * row 6 matches. 3 cards are ready, of 6 rows. */
const FLAGGED = [
  HEADER_12,
  "1,Starmie,Starmie,Base Set,999/102,BS,Normal,Near Mint,English,Common,900003,800011",
  "1,Klara,Klara,SWSH06: Chilling Reign,,SWSH06,Holofoil,Near Mint,English,Ultra Rare,900097,800012",
  "1,Charizard,Charizard,Base Set,4/102,BS,Holofoil,Near Mint,English,Holo Rare,900098,800015",
  CANT_READ,
  MISSING,
  "2,Starmie,Starmie,Base Set,064/102,BS,Normal,Near Mint,English,Common,900003,800003",
  "",
].join("\n");

function seedCatalog() {
  execFileSync(
    ".venv/bin/python",
    ["-c", "from test_collection_import_matching import seed\nseed()"],
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
const fix = (page: Page, row: number) =>
  page.getByRole("button", { name: `Fix row ${row}`, exact: true });
const resolver = (page: Page, name: string) =>
  page.getByRole("group", { name, exact: true });
const save = (page: Page) => page.getByRole("region", { name: "Save" });
const saveButton = (page: Page, cards: number) =>
  save(page).getByRole("button", { name: `Add ${cards} cards to Unsorted` });
/** The line that says what the last change did: the first status in the rows region (a resolver has its own). */
const notice = (page: Page) =>
  page.getByRole("region", { name: "Rows" }).getByRole("status").first();
const item = (page: Page, row: number) =>
  rowsList(page).locator(`li[data-row="${row}"]`);

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

  test("flagged rows are picked, searched, skipped, restored and downloaded, and the save waits for them", async ({
    page,
  }) => {
    seedCatalog();
    await signIn(page);
    const unsorted = await unsortedId(page);
    await review(page, FLAGGED);
    await expect(chip(page, /^Needs you 4$/)).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    await expect(chip(page, /^Matched by name 1$/)).toBeVisible();
    await expect(chip(page, /^All 6$/)).toBeVisible();
    await expect(item(page, 2)).toContainText("Pick one");
    await expect(item(page, 3)).toContainText("Not found");
    await expect(item(page, 4)).toContainText("Can't read");
    // The disabled save says why, to sight and to screen readers.
    const waiting = "4 rows need you. Fix or skip them to continue.";
    await expect(save(page).getByRole("status")).toHaveText(waiting);
    await expect(saveButton(page, 3)).toBeDisabled();
    await expect(saveButton(page, 3)).toHaveAccessibleDescription(waiting);

    // Pick one: focus moves into the resolver, Escape brings it back to Fix.
    await expect(fix(page, 2)).toHaveAttribute("aria-expanded", "false");
    await fix(page, 2).click();
    await expect(fix(page, 2)).toHaveAttribute("aria-expanded", "true");
    const klara = resolver(page, "Fix row 2");
    await expect(
      klara.getByRole("searchbox", { name: "Search the catalog" })
    ).toBeFocused();
    await expect(
      klara
        .getByRole("list", { name: "Cards this row could be" })
        .getByRole("button")
    ).toHaveText(["Klara · Chilling Reign 145", "Klara · Chilling Reign 194"]);
    await expectPageChecks(page, "Collection Import review, resolver open");
    await page.keyboard.press("Escape");
    await expect(klara).toHaveCount(0);
    await expect(fix(page, 2)).toBeFocused();
    await expect(fix(page, 2)).toHaveAttribute("aria-expanded", "false");
    await page.keyboard.press("Enter");
    await klara
      .getByRole("button", { name: "Klara · Chilling Reign 194" })
      .click();
    // The row leaves Needs you, the change is announced, and focus moves to the row that took its place.
    await expect(notice(page)).toHaveText(
      "Row 2 is now Klara · Chilling Reign 194."
    );
    await expect(chip(page, /^Needs you 3$/)).toBeVisible();
    await expect(checkbox(page, 3)).toBeFocused();

    // Not found: the search starts on the row's name and follows typing.
    await fix(page, 3).click();
    const charizard = resolver(page, "Fix row 3");
    const search = charizard.getByRole("searchbox", {
      name: "Search the catalog",
    });
    await expect(search).toHaveValue("Charizard");
    await search.fill("Wartortle");
    await charizard
      .getByRole("list", { name: "Catalog results" })
      .getByRole("button", { name: "Wartortle · Base Set 42" })
      .click();
    await expect(notice(page)).toHaveText(
      "Row 3 is now Wartortle · Base Set 42."
    );
    await expect(chip(page, /^Needs you 2$/)).toBeVisible();

    // A picked card can be changed: Change card chooses another from the search, and back again.
    await chip(page, /^All 6$/).click();
    await page.getByRole("button", { name: "Change card of row 3" }).click();
    const changing = resolver(page, "Change card of row 3");
    await changing
      .getByRole("searchbox", { name: "Search the catalog" })
      .fill("Starmie");
    await changing
      .getByRole("list", { name: "Catalog results" })
      .getByRole("button", { name: "Starmie · Base Set 64" })
      .click();
    await expect(notice(page)).toHaveText(
      "Row 3 is now Starmie · Base Set 64."
    );
    await page.getByRole("button", { name: "Change card of row 3" }).click();
    await changing
      .getByRole("searchbox", { name: "Search the catalog" })
      .fill("Wartortle");
    await changing
      .getByRole("list", { name: "Catalog results" })
      .getByRole("button", { name: "Wartortle · Base Set 42" })
      .click();
    await expect(notice(page)).toHaveText(
      "Row 3 is now Wartortle · Base Set 42."
    );
    await chip(page, /^Needs you 2$/).click();

    // Can't read: no card can fix a quantity, so the resolver offers Skip row alone, focused.
    await fix(page, 4).click();
    const unreadable = resolver(page, "Fix row 4");
    await expect(unreadable).toContainText(
      "PrizeCheck can't read how many copies this row has."
    );
    await expect(unreadable.getByRole("searchbox")).toHaveCount(0);
    await expect(
      unreadable.getByRole("button", { name: "Skip row" })
    ).toBeFocused();
    await unreadable.getByRole("button", { name: "Skip row" }).click();
    await expect(notice(page)).toHaveText("Skipped 1 row.");
    await expect(chip(page, /^Needs you 1$/)).toBeVisible();
    await expect(chip(page, /^Skipped 1$/)).toBeVisible();

    // Skip all: nothing needs you, and the save is ready.
    await page.getByRole("button", { name: "Skip all 1" }).click();
    await expect(notice(page)).toHaveText("Skipped 1 row.");
    await expect(chip(page, /^Needs you 0$/)).toBeVisible();
    await expect(rowsHeading(page)).toBeFocused();
    await expect(
      page.getByText("Nothing needs you. Every row is ready or skipped.")
    ).toBeVisible();
    await expect(saveButton(page, 5)).toBeEnabled();
    await expect(save(page).getByRole("status")).toHaveText(
      "Ready: 5 cards from 4 rows."
    );

    // Download skipped rows: the file's own header and the rows as the file held them.
    const downloading = page.waitForEvent("download");
    await page.getByRole("link", { name: "Download skipped rows" }).click();
    const download = await downloading;
    expect(download.suggestedFilename()).toBe("skipped-rows.csv");
    expect(readFileSync(await download.path(), "utf8")).toBe(
      `﻿${HEADER_12}\r\n${CANT_READ}\r\n${MISSING}\r\n`
    );

    // A restored row needs you again, and holds up the save until it is skipped.
    await chip(page, /^Skipped 2$/).click();
    await page.getByRole("button", { name: "Restore row 5" }).click();
    // The notice comes once the restore's rows are read again; a click before that would arrive while it is saving.
    await expect(notice(page)).toHaveText("Restored 1 row.");
    await expect(chip(page, /^Needs you 1$/)).toBeVisible();
    await expect(saveButton(page, 5)).toBeDisabled();
    await chip(page, /^Needs you 1$/).click();
    await page.getByRole("button", { name: "Skip all 1" }).click();
    await expect(chip(page, /^Needs you 0$/)).toBeVisible();

    // Matched by name: ready, and its card can be changed.
    await chip(page, /^Matched by name 1$/).click();
    await expect(item(page, 1)).toContainText("Matched by name");
    await page.getByRole("button", { name: "Change card of row 1" }).click();
    await expect(
      resolver(page, "Change card of row 1").getByRole("searchbox")
    ).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("button", { name: "Change card of row 1" })
    ).toBeFocused();

    await saveButton(page, 5).click();
    await expect(heading(page)).toHaveText("Unsorted");
    await expect
      .poll(() => held(page, unsorted))
      .toEqual(["1 Klara", "1 Wartortle", "3 Starmie"]);
  });
});

test.describe("phone", () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true });

  test("on a phone, the resolver's choices, search and Skip row are 44 px targets", async ({
    page,
  }) => {
    seedCatalog();
    await signIn(page);
    await review(page, FLAGGED, true);
    await expect(rowsList(page).getByRole("listitem")).toHaveCount(4);
    await expectTouchTarget(fix(page, 2));
    await expectTouchTarget(page.getByRole("button", { name: "Skip all 4" }));
    await expectTouchTarget(chip(page, /^Matched by name 1$/));
    await fix(page, 2).tap();
    const klara = resolver(page, "Fix row 2");
    for (const target of [
      klara.getByRole("button", { name: "Klara · Chilling Reign 145" }),
      klara.getByRole("searchbox", { name: "Search the catalog" }),
      klara.getByRole("button", { name: "Skip row" }),
    ])
      await expectTouchTarget(target);
    await expectPageChecks(
      page,
      "phone Collection Import review, resolver open"
    );
    await klara.getByRole("button", { name: "Skip row" }).tap();
    await expect(chip(page, /^Needs you 3$/)).toBeVisible();
    await expect(chip(page, /^Skipped 1$/)).toBeVisible();
    // The download sits in the save bar, beside the status line.
    const download = save(page).getByRole("link", {
      name: "Download skipped rows",
    });
    await expect(download).toBeVisible();
    await expectTouchTarget(download);
    // The save bar sits above the bottom tab bar, not under it.
    const bar = await save(page).boundingBox();
    const tabs = await page
      .getByRole("navigation", { name: "Main views" })
      .boundingBox();
    expect(bar!.y + bar!.height).toBeLessThanOrEqual(tabs!.y + 0.5);
    await chip(page, /^Matched by name 1$/).tap();
    await expectTouchTarget(
      page.getByRole("button", { name: "Change card of row 1" })
    );
    await expectPageChecks(page, "phone Collection Import review, row skipped");
  });
});
