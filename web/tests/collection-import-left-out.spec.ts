// Ticket #231: Collection Import leaves out what PrizeCheck can't hold (spec "Collection import from other trackers":
// the filters, and the review's Left out panel). Watchlist rows, other games, non-English cards and sealed product never
// reach the list; the side column counts them by reason in plain words, View opens a dialog with the first few of each
// (focus moves in, and back to View on Escape), and Download returns them in the file's own columns. A graded card is
// an ordinary row. Checked at 1280×800 and at 375×812 (the side column above the list, 44 px targets, no horizontal
// scroll). The catalog is api/tests/test_collection_import.py seed_import_catalog.
import { test, expect, type Locator, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { startAsNewOwner } from "./support/owner";
import { expectPageChecks } from "./support/page-check";
import { signInAsOwner } from "./support/sign-in";
import { expectTouchTarget } from "./support/touch-target";

const HEADER =
  "Portfolio Name,Category,Set,Product Name,Card Number,Rarity,Variance,Grade,Card Condition,Average Cost Paid,Quantity,Market Price (As of 2026-09-14),Price Override,Watchlist,Date Added,Notes";
const STARMIE =
  "Binder,Pokemon,Base Set,Starmie,064/102,Common,Normal,Ungraded,Near Mint,0,3,0.52,0,false,2026-02-11,";
const GRADED =
  'Slabs,Pokemon,Jungle,Wigglytuff,032/064,Rare,Holofoil,CGC 9.0,Near Mint,0,1,"1,210.00",0,false,2026-02-12,graded';
/** The left-out rows, as the file holds them (each is written as the download writes it back). */
const LEFT_OUT = [
  ",Pokemon,Base Set,Wartortle,042/102,Uncommon,Normal,Ungraded,Near Mint,,,3.10,0,true,2026-02-13,",
  "Binder,Pokemon,Base Set,Starmie (JP),064/102,Common,Normal,Ungraded,Near Mint,0,1,0.40,0,false,2026-02-14,",
  "Binder,Pokemon,Jungle,Poké Ball (CN),064/064,Common,Normal,Ungraded,Near Mint,0,2,0.20,0,false,2026-02-15,",
  "Binder,Pokemon,Jungle,Weepinbell (JP),048/064,Uncommon,Normal,Ungraded,Near Mint,0,1,0.30,0,false,2026-02-15,",
  "Binder,Pokemon,Jungle,Wigglytuff (CN),032/064,Rare,Holofoil,Ungraded,Near Mint,0,1,0.90,0,false,2026-02-15,",
  "Binder,Magic: The Gathering,Dominaria,Llanowar Elves,168,Common,Normal,Ungraded,Near Mint,0,4,0.25,0,false,2026-02-16,",
  "Sealed,Pokemon,Jungle,Jungle Booster Pack,,,,Ungraded,Near Mint,0,1,9.00,0,false,2026-02-17,",
];
/** Starmie 3 and a graded Wigglytuff are kept: 4 cards. 1 watchlist row, 4 not in English, 1 other game, 1 sealed. */
const COLLECTR = [HEADER, STARMIE, GRADED, ...LEFT_OUT, ""].join("\n");
const CLEAN = [HEADER, STARMIE, ""].join("\n");

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

const heading = (page: Page) => page.getByRole("heading", { level: 1 });
const rowsList = (page: Page) => page.getByRole("list", { name: "Rows" });
const chip = (page: Page, name: RegExp) =>
  page.getByRole("group", { name: "Show rows" }).getByRole("button", { name });
const leftOut = (page: Page) => page.getByRole("region", { name: "Left out" });
const viewButton = (page: Page) =>
  page.getByRole("button", { name: "View left-out rows" });
const downloadLink = (page: Page) =>
  page.getByRole("link", { name: "Download left-out rows" });
const dialog = (page: Page) =>
  page.getByRole("dialog", { name: "Left out of this import" });

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

  test("rows PrizeCheck can't hold are counted by reason, viewed and downloaded, and never listed or added", async ({
    page,
  }) => {
    seedImportCatalog();
    await signIn(page);
    await review(page, COLLECTR);
    // Only the cards are listed; the graded one is an ordinary row.
    await expect(chip(page, /^All 2$/)).toHaveAttribute("aria-pressed", "true");
    await expect(rowsList(page).getByRole("listitem")).toHaveText([
      /3 × Starmie/,
      /1 × Wigglytuff/,
    ]);
    await expect(
      page.getByRole("button", { name: "Add 4 cards to Unsorted" })
    ).toBeEnabled();
    // Counts by reason, in plain words.
    await expect(leftOut(page).getByRole("term")).toHaveText([
      "On a watchlist",
      "From other games",
      "Not in English",
      "Sealed products",
    ]);
    await expect(leftOut(page).getByRole("definition")).toHaveText([
      "1",
      "1",
      "4",
      "1",
    ]);
    const main = page.locator("#main-content");
    for (const hidden of [
      "other_game",
      "not_english",
      "CGC",
      "1,210.00",
      "Portfolio",
    ])
      await expect(main).not.toContainText(hidden);
    await expectPageChecks(page, "Collection Import review, left out");

    // View: focus moves into the dialog, which lists the first three of each reason.
    await viewButton(page).click();
    await expect(dialog(page)).toBeVisible();
    await expect(
      dialog(page).getByRole("button", { name: "Close left-out rows" })
    ).toBeFocused();
    await expect(dialog(page).getByRole("heading", { level: 3 })).toHaveText([
      "On a watchlist · 1 row",
      "From other games · 1 row",
      "Not in English · 4 rows",
      "Sealed products · 1 row",
    ]);
    await expect(
      dialog(page)
        .getByRole("region", { name: "Not in English · 4 rows" })
        .getByRole("listitem")
    ).toHaveText([
      "Starmie (JP) · Base Set 064/102",
      "Poké Ball (CN) · Jungle 064/064",
      "Weepinbell (JP) · Jungle 048/064",
      "and 1 more",
    ]);
    await expect(
      dialog(page)
        .getByRole("region", { name: "Sealed products · 1 row" })
        .getByRole("listitem")
    ).toHaveText(["Jungle Booster Pack · Jungle"]);
    await expectPageChecks(page, "Collection Import review, left out dialog");
    // Escape closes it and focus goes back to View.
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toHaveCount(0);
    await expect(viewButton(page)).toBeFocused();

    // Download: the file's own header, and every left-out row as the file held it.
    const downloading = page.waitForEvent("download");
    await downloadLink(page).click();
    const download = await downloading;
    expect(download.suggestedFilename()).toBe("left-out-rows.csv");
    expect(readFileSync(await download.path(), "utf8")).toBe(
      `﻿${[HEADER, ...LEFT_OUT].join("\r\n")}\r\n`
    );
    // The dialog's own Download returns the same rows.
    await viewButton(page).click();
    const again = page.waitForEvent("download");
    await dialog(page)
      .getByRole("link", { name: "Download these rows" })
      .click();
    expect(readFileSync(await (await again).path(), "utf8")).toBe(
      `﻿${[HEADER, ...LEFT_OUT].join("\r\n")}\r\n`
    );
    await dialog(page)
      .getByRole("button", { name: "Close left-out rows" })
      .click();
    await expect(viewButton(page)).toBeFocused();
  });

  test("a file with nothing left out shows no Left out panel", async ({
    page,
  }) => {
    seedImportCatalog();
    await signIn(page);
    await review(page, CLEAN);
    await expect(chip(page, /^All 1$/)).toHaveAttribute("aria-pressed", "true");
    await expect(
      page.getByRole("region", { name: "Import summary" })
    ).toBeVisible();
    await expect(leftOut(page)).toHaveCount(0);
  });
});

test.describe("phone", () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true });

  test("on a phone the Left out panel sits above the list, and View and Download are 44 px targets", async ({
    page,
  }) => {
    seedImportCatalog();
    await signIn(page);
    await review(page, COLLECTR, true);
    await expect(rowsList(page).getByRole("listitem")).toHaveCount(2);
    const panel = await leftOut(page).boundingBox();
    const rows = await page
      .getByRole("heading", { level: 2, name: "Rows" })
      .boundingBox();
    expect(panel!.y + panel!.height).toBeLessThanOrEqual(rows!.y);
    await expectTouchTarget(viewButton(page));
    await expectTouchTarget(downloadLink(page));
    await expectPageChecks(page, "phone Collection Import review, left out");
    await viewButton(page).tap();
    await expect(dialog(page)).toBeVisible();
    await expectTouchTarget(
      dialog(page).getByRole("link", { name: "Download these rows" })
    );
    await expectPageChecks(
      page,
      "phone Collection Import review, left out dialog"
    );
    await dialog(page)
      .getByRole("button", { name: "Close left-out rows" })
      .tap();
    await expect(dialog(page)).toHaveCount(0);
  });
});
