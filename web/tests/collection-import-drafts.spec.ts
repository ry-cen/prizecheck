// Ticket #233: Collection Import drafts and bounds (spec "The import draft", "Web"). The review lives on the server for a
// day after its last change, so a reload of the import screen offers Unfinished import, and Continue import reopens
// the review with every fix kept. Starting another import while one is open asks first (Replace your unfinished
// import?), with Keep focused, and Escape or Keep leaves the open import as it was. A save refused because a card was
// withdrawn reopens the review on the row that now needs the collector. Checked at 1280×800 and 375×812 (no
// horizontal scroll, 44 px controls). The catalog is api/tests/test_collection_import.py seed_import_catalog.
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
/** Wartortle matches; Flying Pikachu's set isn't in the catalog, so that row needs the collector. 2 cards ready. */
const MIXED = [
  HEADER_12,
  "2,Wartortle,Wartortle,Base Set,042/102,BS,Normal,Near Mint,English,Uncommon,900002,800002",
  "1,Flying Pikachu,Flying Pikachu,Rising Rivals,113/111,RR,Holofoil,Near Mint,English,Secret Rare,900008,800010",
  "",
].join("\n");
/** Three rows that all match: 8 cards. Wigglytuff has one Edition, Holo. */
const CLEAN = [
  HEADER_12,
  "5,Water Energy,Water Energy,Base Set,102/102,BS,Normal,Near Mint,English,Common,900001,800001",
  "2,Starmie,Starmie,Base Set,064/102,BS,Normal,Near Mint,English,Common,900003,800004",
  "1,Wigglytuff (32),Wigglytuff,Jungle,32/64,JU,Unlimited,Heavily Played,English,Rare,900004,800006",
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

/** Sets whether Wigglytuff's one Edition (Jungle 32, Holo) is active in the catalog's active generation. */
async function setWigglytuffActive(active: boolean) {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await pool.query(
      `UPDATE catalog_generation_edition SET active=$1
         WHERE generation_id=(SELECT active_generation FROM catalog_state WHERE singleton)
           AND printing_id=(SELECT id FROM catalog_printing WHERE source_id='base2-32')`,
      [active]
    );
  } finally {
    await pool.end();
  }
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

/** The open import draft's id, or null when there is none. */
async function openDraft(page: Page): Promise<string | null> {
  const response = await page.request.get(
    `${ORIGIN}/api/collection-imports/current`
  );
  if (response.status() === 404) return null;
  expect(response.status(), await response.text()).toBe(200);
  return ((await response.json()) as { id: string }).id;
}

const heading = (page: Page) => page.getByRole("heading", { level: 1 });
const rowsList = (page: Page) => page.getByRole("list", { name: "Rows" });
const chip = (page: Page, name: RegExp) =>
  page.getByRole("group", { name: "Show rows" }).getByRole("button", { name });
const save = (page: Page) => page.getByRole("region", { name: "Save" });
const unfinished = (page: Page) =>
  page.getByRole("region", { name: "Unfinished import" });
const continueImport = (page: Page) =>
  page.getByRole("button", { name: "Continue import" });
const reviewImport = (page: Page) =>
  page.getByRole("button", { name: "Review import" });
const replaceDialog = (page: Page) =>
  page.getByRole("dialog", { name: "Replace your unfinished import?" });
const notifications = (page: Page) =>
  page.getByRole("region", { name: "Notifications" });

/** Chooses `content` as the file `name` through the file picker that Choose file opens. */
async function choose(page: Page, name: string, content: string, tap = false) {
  const chooser = page.waitForEvent("filechooser");
  const button = page.getByRole("button", {
    name: /^Choose (another )?file$/,
  });
  if (tap) await button.tap();
  else await button.click();
  await (
    await chooser
  ).setFiles({ name, mimeType: "text/csv", buffer: Buffer.from(content) });
  await expect(page.getByText(name, { exact: true })).toBeVisible();
}

/** From Collection, opens the upload with Import…, chooses `content` as `name` and opens its review. */
async function review(page: Page, name: string, content: string, tap = false) {
  const press = (locator: Locator) => (tap ? locator.tap() : locator.click());
  await press(page.getByRole("button", { name: "Import…" }));
  await expect(heading(page)).toHaveText("Import your collection");
  await choose(page, name, content, tap);
  await press(reviewImport(page));
  await expect(heading(page)).toHaveText("Review import");
}

test.describe("desktop", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("a reload keeps the review: Continue import reopens it with its fixes, and the save lands as before", async ({
    page,
  }) => {
    seedImportCatalog();
    await signIn(page);
    const unsorted = await unsortedId(page);
    await review(page, "mixed.csv", MIXED);
    await expect(page.getByText("mixed.csv · 2 rows")).toBeVisible();
    await page.getByRole("button", { name: "Skip all 1" }).click();
    await expect(
      page.getByRole("region", { name: "Rows" }).getByRole("status")
    ).toHaveText("Skipped 1 row.");
    const draft = await openDraft(page);

    // A reload starts at the upload, which offers the open import.
    await page.reload();
    await expect(heading(page)).toHaveText("Import your collection");
    await expect(unfinished(page)).toContainText(
      "You have an import you haven't added yet: 2 cards to add."
    );
    await expectPageChecks(page, "Collection Import, unfinished import");
    await continueImport(page).click();
    await expect(heading(page)).toHaveText("Review import");
    // The server doesn't keep the file's name; the fix is still there.
    await expect(page.getByText("2 rows", { exact: true })).toBeVisible();
    await expect(chip(page, /^Skipped 1$/)).toBeVisible();
    await expect(chip(page, /^All 1$/)).toHaveAttribute("aria-pressed", "true");
    await expect(save(page).getByRole("status")).toHaveText(
      "Ready: 2 cards from 1 row."
    );
    expect(await openDraft(page)).toBe(draft);
    await save(page)
      .getByRole("button", { name: "Add 2 cards to Unsorted" })
      .click();
    await expect(heading(page)).toHaveText("Unsorted");
    await expect(notifications(page)).toContainText(
      "Added 2 cards to Unsorted."
    );
    await expect.poll(() => held(page, unsorted)).toEqual(["2 Wartortle"]);

    // Saved, nothing is left to continue.
    await page.getByRole("button", { name: "Import…" }).click();
    await expect(heading(page)).toHaveText("Import your collection");
    await expect(reviewImport(page)).toBeDisabled();
    await expect(unfinished(page)).toHaveCount(0);
  });

  test("starting another import while one is open asks first, and only Replace import replaces it", async ({
    page,
  }) => {
    seedImportCatalog();
    await signIn(page);
    await review(page, "mixed.csv", MIXED);
    const first = await openDraft(page);
    await page.getByRole("button", { name: "Back" }).click();
    await expect(heading(page)).toHaveText("Import your collection");
    await expect(unfinished(page)).toContainText(
      "You have an import you haven't added yet: 2 cards to add, and 1 row needs you."
    );

    // Escape keeps the open import, and focus goes back to Review import.
    await choose(page, "clean.csv", CLEAN);
    await reviewImport(page).click();
    await expect(replaceDialog(page)).toBeVisible();
    await expect(
      replaceDialog(page).getByRole("button", {
        name: "Keep unfinished import",
      })
    ).toBeFocused();
    await expectPageChecks(page, "Collection Import, replace question");
    await page.keyboard.press("Escape");
    await expect(replaceDialog(page)).toHaveCount(0);
    await expect(reviewImport(page)).toBeFocused();
    await expect(heading(page)).toHaveText("Import your collection");
    expect(await openDraft(page)).toBe(first);

    // So does Keep unfinished import.
    await reviewImport(page).click();
    await replaceDialog(page)
      .getByRole("button", { name: "Keep unfinished import" })
      .click();
    await expect(replaceDialog(page)).toHaveCount(0);
    await expect(reviewImport(page)).toBeFocused();
    expect(await openDraft(page)).toBe(first);

    // Replace import starts the new one in its place.
    await reviewImport(page).click();
    await replaceDialog(page)
      .getByRole("button", { name: "Replace import" })
      .click();
    await expect(heading(page)).toHaveText("Review import");
    await expect(page.getByText("clean.csv · 3 rows")).toBeVisible();
    await expect(chip(page, /^All 3$/)).toHaveAttribute("aria-pressed", "true");
    const second = await openDraft(page);
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
  });

  test("a save refused because a card was withdrawn reopens the review on the row that now needs you", async ({
    page,
  }) => {
    seedImportCatalog();
    await signIn(page);
    const unsorted = await unsortedId(page);
    await review(page, "clean.csv", CLEAN);
    await expect(chip(page, /^All 3$/)).toHaveAttribute("aria-pressed", "true");
    await setWigglytuffActive(false);
    try {
      await save(page)
        .getByRole("button", { name: "Add 8 cards to Unsorted" })
        .click();
      await expect(save(page).getByRole("status")).toHaveText(
        "Some cards or your Locations changed, so nothing was added. Check the review and try again."
      );
      await expect(chip(page, /^Needs you 1$/)).toHaveAttribute(
        "aria-pressed",
        "true"
      );
      await expect(rowsList(page).getByRole("listitem")).toHaveCount(1);
      await expect(rowsList(page).getByRole("listitem")).toContainText(
        "Not found"
      );
      await expect(rowsList(page).getByRole("listitem")).toContainText(
        "Wigglytuff"
      );
      await expect(
        save(page).getByRole("button", { name: "Add 7 cards to Unsorted" })
      ).toBeDisabled();
      expect(await held(page, unsorted)).toEqual([]);

      // Skipped, the rest is added.
      await page.getByRole("button", { name: "Skip all 1" }).click();
      await save(page)
        .getByRole("button", { name: "Add 7 cards to Unsorted" })
        .click();
      await expect(heading(page)).toHaveText("Unsorted");
      await expect
        .poll(() => held(page, unsorted))
        .toEqual(["2 Starmie", "5 Water Energy"]);
    } finally {
      await setWigglytuffActive(true);
    }
  });
});

test.describe("phone", () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true });

  test("on a phone, Import… stays where it is when Collection's totals arrive", async ({
    page,
  }) => {
    // The first listing waits until Import… has been measured, so the header is drawn without its totals first.
    let release!: () => void;
    const listing = new Promise<void>((resolve) => (release = resolve));
    await page.route("**/api/collection/holdings?**", async (route) => {
      await listing;
      await route.continue();
    });
    await signIn(page);
    const totals = page.getByText("0 copies · 0 editions", { exact: true });
    await expect(totals).toHaveCount(0);
    const importButton = page.getByRole("button", { name: "Import…" });
    await expect(importButton).toBeVisible();
    const before = await importButton.boundingBox();
    release();
    await expect(totals).toBeVisible();
    // flake-exempt one-shot-read (invariant): once the totals are drawn, Import… must be where it was before them.
    expect(await importButton.boundingBox()).toEqual(before);
  });

  test("on a phone, Unfinished import and the replace question fit the screen with 44 px controls", async ({
    page,
  }) => {
    seedImportCatalog();
    await signIn(page);
    await review(page, "mixed.csv", MIXED, true);
    await page.getByRole("button", { name: "Back" }).tap();
    await expect(heading(page)).toHaveText("Import your collection");
    await expect(unfinished(page)).toBeVisible();
    await expectTouchTarget(continueImport(page));
    await expectPageChecks(page, "phone Collection Import, unfinished import");
    await choose(page, "clean.csv", CLEAN, true);
    await reviewImport(page).tap();
    await expect(replaceDialog(page)).toBeVisible();
    await expectTouchTarget(
      replaceDialog(page).getByRole("button", {
        name: "Keep unfinished import",
      })
    );
    await expectTouchTarget(
      replaceDialog(page).getByRole("button", { name: "Replace import" })
    );
    await expectPageChecks(page, "phone Collection Import, replace question");
    await replaceDialog(page)
      .getByRole("button", { name: "Keep unfinished import" })
      .tap();
    await expect(replaceDialog(page)).toHaveCount(0);
    await continueImport(page).tap();
    await expect(heading(page)).toHaveText("Review import");
    await expect(chip(page, /^Needs you 1$/)).toHaveAttribute(
      "aria-pressed",
      "true"
    );
  });
});
