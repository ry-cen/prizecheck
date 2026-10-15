// Ticket #234: Collection Import, Paste a list (spec "Reading the input", "Web"). The import screen's Upload a file /
// Paste switch: rows copied from a spreadsheet with their header row are read like the file, and other lines are read
// with decklist import's grammar, then by name, so a mixed paste of spreadsheet-free decklist lines and free text goes
// through to saving. The review says "You pasted" for a pasted line, and Download skipped rows gives back the lines as
// they were pasted. Checked at 1280×800 and 375×812 (no horizontal scroll, 44 px controls). The catalog is
// api/tests/test_collection_import.py seed_import_catalog; the lines are api/tests/collection_import_fixtures/
// paste-lines.txt.
import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { startAsNewOwner } from "./support/owner";
import { expectPageChecks } from "./support/page-check";
import { signInAsOwner } from "./support/sign-in";
import { expectTouchTarget } from "./support/touch-target";

const ORIGIN = process.env.TEST_ORIGIN || "http://localhost:5173";
/** Two of the TCGplayer app's rows as a spreadsheet copies them: tab-separated, header first. 3 cards. */
const SPREADSHEET = [
  "Quantity\tName\tSimple Name\tSet\tCard Number\tSet Code\tPrinting\tCondition\tLanguage\tRarity\tProduct ID\tSKU",
  "2\tWartortle\tWartortle\tBase Set\t042/102\tBS\tNormal\tNear Mint\tEnglish\tUncommon\t900002\t800002",
  "1\tStarmie\tStarmie\tBase Set\t064/102\tBS\tNormal\tNear Mint\tEnglish\tCommon\t900003\t800003",
].join("\n");
/** A title line (Not found), decklist lines with "2x" and no quantity, and PriceCharting-style free text: 8 cards. */
const LINES = readFileSync(
  "api/tests/collection_import_fixtures/paste-lines.txt",
  "utf8"
);

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
const pasteTab = (page: Page) => page.getByRole("tab", { name: "Paste" });
const fileTab = (page: Page) =>
  page.getByRole("tab", { name: "Upload a file" });
const list = (page: Page) => page.getByRole("textbox", { name: "Your list" });
const reviewImport = (page: Page) =>
  page.getByRole("button", { name: "Review import" });
const status = (page: Page) =>
  page.getByRole("main").getByRole("status").last();
const rowsList = (page: Page) => page.getByRole("list", { name: "Rows" });
const chip = (page: Page, name: RegExp) =>
  page.getByRole("group", { name: "Show rows" }).getByRole("button", { name });
const notice = (page: Page) =>
  page.getByRole("region", { name: "Rows" }).getByRole("status");
const save = (page: Page) => page.getByRole("region", { name: "Save" });
const notifications = (page: Page) =>
  page.getByRole("region", { name: "Notifications" });
const replaceDialog = (page: Page) =>
  page.getByRole("dialog", { name: "Replace your unfinished import?" });

test.describe("desktop", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("a pasted spreadsheet is read like the file, and pasted lines go through to saving", async ({
    page,
  }) => {
    seedImportCatalog();
    await signIn(page);
    const unsorted = await unsortedId(page);
    await page.getByRole("button", { name: "Import…" }).click();
    await expect(heading(page)).toHaveText("Import your collection");
    // Upload a file is chosen first; Paste swaps the file picker for the text box.
    await expect(fileTab(page)).toHaveAttribute("aria-selected", "true");
    await pasteTab(page).click();
    await expect(pasteTab(page)).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("tabpanel", { name: "Paste" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Choose file" })).toHaveCount(
      0
    );
    await expect(reviewImport(page)).toBeDisabled();
    await expectPageChecks(page, "Collection Import, paste");

    // Rows copied from a spreadsheet, header first, are read like the file.
    await list(page).fill(SPREADSHEET);
    await reviewImport(page).click();
    await expect(heading(page)).toHaveText("Review import");
    await expect(page.getByText("Pasted list · 2 rows")).toBeVisible();
    await expect(chip(page, /^All 2$/)).toHaveAttribute("aria-pressed", "true");

    // Back keeps the text; new lines replace the open import after asking.
    await page.getByRole("button", { name: "Back" }).click();
    await expect(heading(page)).toHaveText("Import your collection");
    await expect(pasteTab(page)).toHaveAttribute("aria-selected", "true");
    await expect(list(page)).toHaveValue(SPREADSHEET);
    await list(page).fill(LINES);
    await reviewImport(page).click();
    await replaceDialog(page)
      .getByRole("button", { name: "Replace import" })
      .click();
    await expect(heading(page)).toHaveText("Review import");
    await expect(page.getByText("Pasted list · 5 rows")).toBeVisible();
    await expect(
      page
        .getByRole("complementary", { name: "About this import" })
        .getByText("Rows in list")
    ).toBeVisible();

    // The title line isn't a card: Not found, shown as it was pasted.
    await expect(chip(page, /^Needs you 1$/)).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    const title = rowsList(page).getByRole("listitem");
    await expect(title).toHaveCount(1);
    await expect(title).toContainText("Not found");
    await expect(title).toContainText(
      "You pasted: My binder (Base Set + Jungle)"
    );
    await expectPageChecks(page, "Collection Import, pasted lines review");
    await page.getByRole("button", { name: "Skip row 1" }).click();
    await expect(notice(page)).toHaveText("Skipped 1 row.");

    // The decklist lines and the free text all matched.
    await chip(page, /^All 4$/).click();
    await expect(rowsList(page).getByRole("listitem")).toHaveCount(4);
    await expect(rowsList(page)).toContainText(
      "You pasted: 2 · Wartortle · BS · 42"
    );
    await expect(rowsList(page)).toContainText(
      "You pasted: Starmie · Base Set · 64"
    );

    // Download skipped rows gives back the line as it was pasted.
    const downloading = page.waitForEvent("download");
    await page.getByRole("link", { name: "Download skipped rows" }).click();
    const download = await downloading;
    expect(download.suggestedFilename()).toBe("skipped-rows.txt");
    expect(readFileSync(await download.path(), "utf8")).toBe(
      "My binder (Base Set + Jungle)\n"
    );

    await save(page)
      .getByRole("button", { name: "Add 8 cards to Unsorted" })
      .click();
    await expect(heading(page)).toHaveText("Unsorted");
    await expect(notifications(page)).toContainText(
      "Added 8 cards to Unsorted."
    );
    await expect
      .poll(() => held(page, unsorted))
      .toEqual(["1 Wigglytuff", "2 Wartortle", "5 Starmie"]);
  });

  test("a paste with no cards in it says so in a list's words", async ({
    page,
  }) => {
    seedImportCatalog();
    await signIn(page);
    await page.getByRole("button", { name: "Import…" }).click();
    await expect(heading(page)).toHaveText("Import your collection");
    await pasteTab(page).click();
    await list(page).fill("Pokémon: 4\nTrainer: 0\n");
    await reviewImport(page).click();
    await expect(status(page)).toHaveText("This list has no cards in it.");
    await expect(heading(page)).toHaveText("Import your collection");
    // Switching back to Upload a file clears the message.
    await fileTab(page).click();
    await expect(
      page.getByRole("button", { name: "Choose file" })
    ).toBeVisible();
    await expect(status(page)).toHaveText("");
  });
});

test.describe("phone", () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true });

  test("on a phone, the switch and the text box fit the screen with 44 px controls", async ({
    page,
  }) => {
    seedImportCatalog();
    await signIn(page);
    await page.getByRole("button", { name: "Import…" }).tap();
    await expect(heading(page)).toHaveText("Import your collection");
    await expectTouchTarget(pasteTab(page));
    await expectTouchTarget(fileTab(page));
    await pasteTab(page).tap();
    await list(page).fill(LINES);
    await expectPageChecks(page, "phone Collection Import, paste");
    await reviewImport(page).tap();
    await expect(heading(page)).toHaveText("Review import");
    await expect(page.getByText("Pasted list · 5 rows")).toBeVisible();
    await expect(rowsList(page).getByRole("listitem")).toContainText(
      "You pasted: My binder (Base Set + Jungle)"
    );
    await expectPageChecks(
      page,
      "phone Collection Import, pasted lines review"
    );
  });
});
