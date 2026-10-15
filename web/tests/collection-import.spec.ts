// Ticket #226: Collection Import (spec "Collection import from other trackers"). An empty Collection's Import from
// another tracker, or Import… in Collection's header, opens the upload: choose a file and where its cards go (Put
// cards in, Unsorted by default), then Review import. The review is one list with Needs you and All, opening on Needs
// you when a row doesn't match; nothing can be added while a row needs the collector. Add N cards to <Location> adds
// every copy in one step and lands on that Location with a toast and no Undo. Checked at 1280×800 and 375×812 (no
// horizontal scroll, 44 px controls). The files are small reconstructions of the TCGplayer app export, under the
// gateway's present 16 KiB body limit; the catalog is api/tests/test_collection_import.py seed_import_catalog.
import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { startAsNewOwner } from "./support/owner";
import { expectPageChecks } from "./support/page-check";
import { signInAsOwner } from "./support/sign-in";
import { expectTouchTarget } from "./support/touch-target";

const ORIGIN = process.env.TEST_ORIGIN || "http://localhost:5173";
const HEADER_12 =
  "Quantity,Name,Simple Name,Set,Card Number,Set Code,Printing,Condition,Language,Rarity,Product ID,SKU";
const HEADER_14 = `${HEADER_12},Price,Price Each`;
/** Wartortle matches; Flying Pikachu's set isn't in the catalog, so that row needs the collector. */
const MIXED = [
  HEADER_12,
  "2,Wartortle,Wartortle,Base Set,042/102,BS,Normal,Near Mint,English,Uncommon,900002,800002",
  "1,Flying Pikachu,Flying Pikachu,Rising Rivals,113/111,RR,Holofoil,Near Mint,English,Secret Rare,900008,800010",
  "",
].join("\n");
/** Four rows that all match, with CRLF line endings: 9 cards. */
const CLEAN = [
  HEADER_14,
  "5,Water Energy,Water Energy,Base Set,102/102,BS,Normal,Near Mint,English,Common,900001,800001,$1.50,$0.30",
  "1,Starmie,Starmie,Base Set,064/102,BS,Normal,Moderately Played,English,Common,900003,800003,$0.25,$0.25",
  "2,Starmie,Starmie,Base Set,064/102,BS,Normal,Near Mint,English,Common,900003,800004,$1.00,$0.50",
  "1,Wigglytuff (32),Wigglytuff,Jungle,32/64,JU,Unlimited,Heavily Played,English,Rare,900004,800006,$2.00,$2.00",
  "",
].join("\r\n");

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

/** Makes a nested Storage Leaf with a long path, through the real API, and returns its id. */
async function longPathLeaf(page: Page): Promise<string> {
  const names = [
    "Binders kept at the back of the cupboard",
    "Trades promised to the whole local league",
    "Water and fire cards sorted by set",
  ];
  const tree = async () =>
    (
      (await (
        await page.request.get(`${ORIGIN}/api/location-tree`)
      ).json()) as {
        locations: { id: string; version: number }[];
      }
    ).locations;
  let parent: string | null = null;
  for (const name of names) {
    const version = parent
      ? (await tree()).find((node) => node.id === parent)!.version
      : null;
    const response = await page.request.post(`${ORIGIN}/api/location-tree`, {
      headers: { origin: ORIGIN },
      data: {
        name,
        parent_id: parent,
        parent_version: version,
        idempotency_key: randomUUID(),
      },
    });
    expect(response.status(), await response.text()).toBe(201);
    parent = ((await response.json()) as { location: { id: string } }).location
      .id;
  }
  return parent!;
}

const heading = (page: Page) => page.getByRole("heading", { level: 1 });
const chooseFile = (page: Page) =>
  page.getByRole("button", { name: /^Choose (another )?file$/ });
const rowsList = (page: Page) => page.getByRole("list", { name: "Rows" });
const chip = (page: Page, name: RegExp) =>
  page.getByRole("group", { name: "Show rows" }).getByRole("button", { name });
const notifications = (page: Page) =>
  page.getByRole("region", { name: "Notifications" });

/** Chooses `content` as the file `name` through the file picker that Choose file opens. */
async function choose(page: Page, name: string, content: string, tap = false) {
  const chooser = page.waitForEvent("filechooser");
  if (tap) await chooseFile(page).tap();
  else await chooseFile(page).click();
  await (
    await chooser
  ).setFiles({ name, mimeType: "text/csv", buffer: Buffer.from(content) });
  await expect(page.getByText(name, { exact: true })).toBeVisible();
}

test.describe("desktop", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("an empty Collection imports a file into Unsorted after its review", async ({
    page,
  }) => {
    seedImportCatalog();
    await signIn(page);
    const unsorted = await unsortedId(page);
    await expect(
      page.getByText("Your Collection has no cards yet.")
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Import from another tracker" })
      .click();
    await expect(page).toHaveURL(/\/collection\/import$/);
    await expect(heading(page)).toHaveText("Import your collection");
    await expect(
      page.getByRole("combobox", { name: "Put cards in" })
    ).toHaveValue(unsorted);
    const review = page.getByRole("button", { name: "Review import" });
    await expect(review).toBeDisabled();
    await expectPageChecks(page, "Collection Import, upload");

    // A row that doesn't match waits under Needs you, and nothing can be added.
    await choose(page, "mixed.csv", MIXED);
    await review.click();
    await expect(heading(page)).toHaveText("Review import");
    await expect(page.getByText("mixed.csv · 2 rows")).toBeVisible();
    await expect(chip(page, /^Needs you 1$/)).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    await expect(rowsList(page).getByRole("listitem")).toHaveCount(1);
    await expect(rowsList(page).getByRole("listitem")).toContainText(
      "Not found"
    );
    await expect(rowsList(page).getByRole("listitem")).toContainText(
      "From your file: 1 · Flying Pikachu · Rising Rivals · 113/111 · Holofoil"
    );
    const save = page.getByRole("region", { name: "Save" });
    await expect(save.getByRole("status")).toHaveText(
      "1 row needs you. Fix it in your file, then import the file again."
    );
    await expect(
      save.getByRole("button", { name: "Add 2 cards to Unsorted" })
    ).toBeDisabled();
    await expectPageChecks(
      page,
      "Collection Import, review with a row that needs you"
    );
    await chip(page, /^All 2$/).click();
    await expect(rowsList(page).getByRole("listitem")).toHaveCount(2);
    await expect(rowsList(page).getByRole("listitem").first()).toContainText(
      "2 × Wartortle"
    );
    // Nothing from the source tracker reaches the screen: no name, prices or marketplace IDs.
    for (const hidden of ["TCGplayer", "$", "900002", "Near Mint"])
      await expect(page.locator("#main-content")).not.toContainText(hidden);

    // Back keeps the Location; a clean file is ready to add.
    await page.getByRole("button", { name: "Back" }).click();
    await expect(heading(page)).toHaveText("Import your collection");
    await choose(page, "clean.csv", CLEAN);
    await review.click();
    await expect(heading(page)).toHaveText("Review import");
    await expect(chip(page, /^All 4$/)).toHaveAttribute("aria-pressed", "true");
    await expect(rowsList(page).getByRole("listitem")).toHaveCount(4);
    await expect(save.getByRole("status")).toHaveText(
      "Ready: 9 cards from 4 rows."
    );
    await chip(page, /^Needs you 0$/).click();
    await expect(
      page.getByText("Nothing needs you. Every row is ready.")
    ).toBeVisible();
    await save.getByRole("button", { name: "Add 9 cards to Unsorted" }).click();

    // It lands on Unsorted, with a toast and no Undo.
    await expect(page).toHaveURL(/\/collection$/);
    await expect(heading(page)).toHaveText("Unsorted");
    await expect(notifications(page)).toContainText(
      "Added 9 cards to Unsorted."
    );
    await expect(
      notifications(page).getByRole("button", { name: "Undo" })
    ).toHaveCount(0);
    await expect
      .poll(() => held(page, unsorted))
      .toEqual(["1 Wigglytuff", "3 Starmie", "5 Water Energy"]);
  });

  test("Import… in Collection's header opens the upload, and Cancel goes back", async ({
    page,
  }) => {
    seedImportCatalog();
    await signIn(page);
    await page.getByRole("button", { name: "Import…" }).click();
    await expect(heading(page)).toHaveText("Import your collection");
    await expect(
      page
        .getByRole("navigation", { name: "Main views" })
        .getByRole("button", { name: "Collection" })
    ).toHaveAttribute("aria-current", "page");
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page).toHaveURL(/\/collection$/);
    await expect(heading(page)).toHaveText("All owned");
  });
});

test.describe("phone", () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true });

  test("on a phone the upload, the review and the save fit the screen with 44 px controls", async ({
    page,
  }) => {
    seedImportCatalog();
    await signIn(page);
    const unsorted = await unsortedId(page);
    await page
      .getByRole("button", { name: "Import from another tracker" })
      .tap();
    await expect(heading(page)).toHaveText("Import your collection");
    await expectTouchTarget(chooseFile(page));
    await expectTouchTarget(
      page.getByRole("combobox", { name: "Put cards in" })
    );
    await expectPageChecks(page, "phone Collection Import, upload");
    await choose(page, "clean.csv", CLEAN, true);
    await page.getByRole("button", { name: "Review import" }).tap();
    await expect(heading(page)).toHaveText("Review import");
    await expect(rowsList(page).getByRole("listitem")).toHaveCount(4);
    await expectTouchTarget(chip(page, /^All 4$/));
    await expectTouchTarget(chip(page, /^Needs you 0$/));
    const add = page.getByRole("button", { name: "Add 9 cards to Unsorted" });
    await expectTouchTarget(add);
    await expect(add).toBeInViewport();
    await expectPageChecks(page, "phone Collection Import, review");
    await add.tap();
    await expect(heading(page)).toHaveText("Unsorted");
    await expect(notifications(page)).toContainText(
      "Added 9 cards to Unsorted."
    );
    await expect
      .poll(() => held(page, unsorted))
      .toEqual(["1 Wigglytuff", "3 Starmie", "5 Water Energy"]);
  });

  test("a long Location path shortens the save button instead of scrolling the phone", async ({
    page,
  }) => {
    seedImportCatalog();
    await signIn(page);
    const leaf = await longPathLeaf(page);
    await page
      .getByRole("button", { name: "Import from another tracker" })
      .tap();
    await page
      .getByRole("combobox", { name: "Put cards in" })
      .selectOption(leaf);
    await choose(page, "clean.csv", CLEAN, true);
    await page.getByRole("button", { name: "Review import" }).tap();
    await expect(heading(page)).toHaveText("Review import");
    const add = page.getByRole("button", {
      name: /^Add 9 cards to .*cupboard/,
    });
    await expect(add).toContainText("Water and fire cards sorted by set");
    await expect(add).toBeInViewport();
    await expectPageChecks(page, "phone Collection Import, long path review");
  });
});
