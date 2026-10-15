// Ticket #232: Collection Import's groups, landing Location and copies already held (spec "Collection import from other
// trackers": the review's side column). In this file lists the file's groups, all ticked; unticking one leaves its rows
// out of every count and the save, and ticking it brings them back. Put cards in changes the landing Storage Leaf during
// the review, and the cards land there; no group becomes a Location. Each row names its group and how many copies the
// Collection already holds, and the side column notes how many incoming cards it already holds. Checked at 1280×800
// and at 375×812 (the side column above the list, 44 px targets, no horizontal scroll). The catalog is
// api/tests/test_collection_import.py seed_import_catalog.
import { test, expect, type Locator, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { startAsNewOwner } from "./support/owner";
import { expectPageChecks } from "./support/page-check";
import { signInAsOwner } from "./support/sign-in";
import { expectTouchTarget } from "./support/touch-target";

const ORIGIN = process.env.TEST_ORIGIN || "http://localhost:5173";
const HEADER =
  "Portfolio Name,Category,Set,Product Name,Card Number,Rarity,Variance,Grade,Card Condition,Average Cost Paid,Quantity,Market Price (As of 2026-09-14),Price Override,Watchlist,Date Added,Notes";
/** Main: Starmie 2 and Wartortle. For Trade: Poké Ball 3. Sold: Wigglytuff, and Flying Pikachu, whose set the catalog
 * lacks, so it needs the collector. 7 cards in 5 rows, 6 without Sold. */
const GROUPS = [
  HEADER,
  "Main,Pokemon,Base Set,Starmie,064/102,Common,Normal,Ungraded,Near Mint,0,2,0.52,0,false,2026-03-01,",
  "Main,Pokemon,Base Set,Wartortle,042/102,Uncommon,Normal,Ungraded,Near Mint,0,1,3.10,0,false,2026-03-01,",
  "For Trade,Pokemon,Jungle,Poké Ball,064/064,Common,Normal,Ungraded,Near Mint,0,3,0.20,0,false,2026-03-02,",
  "Sold,Pokemon,Jungle,Wigglytuff,032/064,Rare,Holofoil,Ungraded,Near Mint,0,1,0.90,0,false,2026-03-03,",
  "Sold,Pokemon,Rising Rivals,Flying Pikachu,113/111,Secret Rare,Holofoil,Ungraded,Near Mint,0,1,120.00,0,false,2026-03-03,",
  "",
].join("\n");
/** Starmie 2, already saved before the second import. */
const EARLIER = [
  HEADER,
  "Binder,Pokemon,Base Set,Starmie,064/102,Common,Normal,Ungraded,Near Mint,0,2,0.52,0,false,2026-01-01,",
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

type TreeNode = {
  id: string;
  name: string;
  parent_id: string | null;
};

async function tree(page: Page): Promise<TreeNode[]> {
  const response = await page.request.get(`${ORIGIN}/api/location-tree`);
  return ((await response.json()) as { locations: TreeNode[] }).locations;
}

async function unsortedId(page: Page): Promise<string> {
  return (await tree(page)).find(
    (node) => node.name === "Unsorted" && node.parent_id === null
  )!.id;
}

/** Makes a top-level Storage Leaf through the real API and returns its id. */
async function makeLeaf(page: Page, name: string): Promise<string> {
  const response = await page.request.post(`${ORIGIN}/api/location-tree`, {
    headers: { origin: ORIGIN },
    data: {
      name,
      parent_id: null,
      parent_version: null,
      idempotency_key: randomUUID(),
    },
  });
  expect(response.status(), await response.text()).toBe(201);
  return ((await response.json()) as { location: { id: string } }).location.id;
}

/** Imports `content` into `locationId` through the API alone, as an earlier import would have. */
async function importedBefore(page: Page, locationId: string, content: string) {
  const started = await page.request.post(
    `${ORIGIN}/api/collection-imports?location_id=${locationId}`,
    {
      headers: { origin: ORIGIN, "content-type": "text/csv" },
      data: Buffer.from(content),
    }
  );
  expect(started.status(), await started.text()).toBe(201);
  const { id } = (await started.json()) as { id: string };
  const saved = await page.request.post(
    `${ORIGIN}/api/collection-imports/${id}/save`,
    {
      headers: { origin: ORIGIN },
      data: { draft_revision: 1, idempotency_key: randomUUID() },
    }
  );
  expect(saved.status(), await saved.text()).toBe(200);
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
const item = (page: Page, row: number) =>
  rowsList(page).locator(`li[data-row="${row}"]`);
const chip = (page: Page, name: RegExp) =>
  page.getByRole("group", { name: "Show rows" }).getByRole("button", { name });
const groupsPanel = (page: Page) =>
  page.getByRole("region", { name: "In this file" });
const group = (page: Page, name: string) =>
  groupsPanel(page).getByRole("checkbox", { name });
/** The 44 px label around a group's checkbox, which is its tap area. */
const groupTarget = (page: Page, name: string) =>
  groupsPanel(page).locator("label", {
    has: page.getByRole("checkbox", { name }),
  });
const putCardsIn = (page: Page) =>
  page
    .getByRole("complementary", { name: "About this import" })
    .getByRole("combobox", { name: "Put cards in" });
const save = (page: Page) => page.getByRole("region", { name: "Save" });
const notice = (page: Page) =>
  page.getByRole("region", { name: "Rows" }).getByRole("status");
const notifications = (page: Page) =>
  page.getByRole("region", { name: "Notifications" });
const HELD_NOTE = /of these cards (is|are) already in your Collection/;

/** From Collection, opens the upload with Import…, chooses `content` as rows.csv and opens the review. */
async function review(page: Page, content: string, tap = false) {
  const press = (locator: Locator) => (tap ? locator.tap() : locator.click());
  await press(page.getByRole("button", { name: "Import…" }));
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

  test("unticking a group leaves its rows out, Put cards in changes where the cards go, and no group becomes a Location", async ({
    page,
  }) => {
    seedImportCatalog();
    await signIn(page);
    const unsorted = await unsortedId(page);
    const binder = await makeLeaf(page, "Binder");
    await review(page, GROUPS);
    await expect(chip(page, /^Needs you 1$/)).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    for (const name of ["Main 2 rows", "For Trade 1 row", "Sold 2 rows"])
      await expect(group(page, name)).toBeChecked();
    await expect(
      save(page).getByRole("button", { name: "Add 7 cards to Unsorted" })
    ).toBeDisabled();
    await expect(putCardsIn(page)).toHaveValue(unsorted);
    await expectPageChecks(page, "Collection Import review, groups");

    // Leaving Sold out: its row that needs the collector goes, and the counts drop.
    await group(page, "Sold 2 rows").click();
    await expect(group(page, "Sold 2 rows")).not.toBeChecked();
    await expect(notice(page)).toHaveText(
      "The rows in Sold are left out of this import."
    );
    await expect(chip(page, /^Needs you 0$/)).toBeVisible();
    await expect(chip(page, /^All 3$/)).toBeVisible();
    await expect(save(page).getByRole("status")).toHaveText(
      "Ready: 6 cards from 3 rows."
    );
    // Ticking it brings its rows back, then it is left out again. (The notice comes once the rows are read again.)
    await group(page, "Sold 2 rows").click();
    await expect(group(page, "Sold 2 rows")).toBeChecked();
    await expect(notice(page)).toHaveText(
      "The rows in Sold are back in this import."
    );
    await expect(chip(page, /^Needs you 1$/)).toBeVisible();
    await expect(save(page).getByRole("status")).toHaveText(
      "1 row needs you. Fix or skip it to continue."
    );
    await group(page, "Sold 2 rows").click();
    await expect(notice(page)).toHaveText(
      "The rows in Sold are left out of this import."
    );
    await expect(chip(page, /^All 3$/)).toBeVisible();
    await chip(page, /^All 3$/).click();
    await expect(item(page, 1)).toContainText("Main");
    await expect(item(page, 3)).toContainText("For Trade");

    // Put cards in: the cards now go to Binder.
    await putCardsIn(page).selectOption({ label: "Binder" });
    await expect(notice(page)).toHaveText("Cards will go to Binder.");
    await expect(putCardsIn(page)).toHaveValue(binder);
    const add = save(page).getByRole("button", {
      name: "Add 6 cards to Binder",
    });
    await expect(add).toBeEnabled();
    await expectPageChecks(page, "Collection Import review, group left out");
    await add.click();
    await expect(heading(page)).toHaveText("Binder");
    await expect(notifications(page)).toContainText("Added 6 cards to Binder.");
    await expect
      .poll(() => held(page, binder))
      .toEqual(["1 Wartortle", "2 Starmie", "3 Poké Ball"]);
    expect(await held(page, unsorted)).toEqual([]);
    expect((await tree(page)).map((node) => node.name).sort()).toEqual([
      "Binder",
      "Unsorted",
    ]);
  });

  test("each row and the side column say how many incoming cards are already in the Collection", async ({
    page,
  }) => {
    seedImportCatalog();
    await signIn(page);
    const unsorted = await unsortedId(page);
    await importedBefore(page, unsorted, EARLIER);
    await page.reload();
    await expect(heading(page)).toHaveText("All owned");
    await review(page, GROUPS);
    await group(page, "Sold 2 rows").click();
    await expect(notice(page)).toHaveText(
      "The rows in Sold are left out of this import."
    );
    await chip(page, /^All 3$/).click();
    await expect(chip(page, /^All 3$/)).toHaveAttribute("aria-pressed", "true");
    const note = page
      .getByRole("complementary", { name: "About this import" })
      .getByText(HELD_NOTE);
    await expect(note).toHaveText(
      "2 of these cards are already in your Collection. Importing adds to them."
    );
    await expect(item(page, 1)).toContainText(
      "Main · 2 already in your Collection"
    );
    await expect(item(page, 2)).toContainText("Main");
    await expect(item(page, 2)).not.toContainText("already in your Collection");
    // A skipped row isn't added, so it isn't counted.
    await page.getByRole("button", { name: "Skip row 1" }).click();
    await expect(note).toHaveCount(0);
    await expect(notice(page)).toHaveText("Skipped 1 row.");
  });

  test("group and Location changes made while one is saving are queued, sent together in click order, and all reach the server", async ({
    page,
  }) => {
    seedImportCatalog();
    await signIn(page);
    const binder = await makeLeaf(page, "Binder");
    await review(page, GROUPS);
    // Sold goes first, so nothing needs the collector and Save is open.
    await group(page, "Sold 2 rows").click();
    await expect(notice(page)).toHaveText(
      "The rows in Sold are left out of this import."
    );
    const add = save(page).getByRole("button", { name: /^Add / });
    await expect(add).toBeEnabled();
    // The next change is held at the gate until it is released, and later ones go through.
    const sent: { changes: Record<string, unknown>[] }[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    await page.route("**/api/collection-imports/*/changes", async (route) => {
      sent.push(route.request().postDataJSON());
      if (sent.length === 1) await gate;
      await route.continue();
    });
    // The first click is sent; the next two come while it is saving. Each control shows its pending state at once.
    await group(page, "Main 2 rows").click();
    await group(page, "For Trade 1 row").click();
    await putCardsIn(page).selectOption({ label: "Binder" });
    await expect(group(page, "Main 2 rows")).not.toBeChecked();
    await expect(group(page, "For Trade 1 row")).not.toBeChecked();
    await expect(putCardsIn(page)).toHaveValue(binder);
    // Saving now would leave the changes behind.
    await expect(add).toBeDisabled();
    expect(sent).toHaveLength(1);
    release();
    await expect(notice(page)).toHaveText("Cards will go to Binder.");
    expect(sent.map((request) => request.changes)).toEqual([
      [{ group: "Main", include: false }],
      [{ group: "For Trade", include: false }, { location_id: binder }],
    ]);
    // The server holds all three, not just the controls.
    const response = await page.request.get(
      `${ORIGIN}/api/collection-imports/current`
    );
    const current = (await response.json()) as {
      location_id: string;
      groups: { name: string; included: boolean }[];
    };
    expect(current.location_id).toBe(binder);
    expect(current.groups.map((g) => [g.name, g.included])).toEqual([
      ["Main", false],
      ["For Trade", false],
      ["Sold", false],
    ]);
  });
});

test.describe("phone", () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true });

  test("on a phone the side column sits above the list, with 44 px group checkboxes and Location picker", async ({
    page,
  }) => {
    seedImportCatalog();
    await signIn(page);
    await review(page, GROUPS, true);
    await expect(rowsList(page).getByRole("listitem")).toHaveCount(1);
    const side = await page
      .getByRole("complementary", { name: "About this import" })
      .boundingBox();
    const rows = await page
      .getByRole("heading", { level: 2, name: "Rows" })
      .boundingBox();
    expect(side!.y + side!.height).toBeLessThanOrEqual(rows!.y);
    await expectTouchTarget(groupTarget(page, "Sold 2 rows"));
    await expectTouchTarget(putCardsIn(page));
    await expectPageChecks(page, "phone Collection Import review, groups");
    await groupTarget(page, "Sold 2 rows").tap();
    await expect(group(page, "Sold 2 rows")).not.toBeChecked();
    await expect(notice(page)).toHaveText(
      "The rows in Sold are left out of this import."
    );
    await expect(chip(page, /^Needs you 0$/)).toBeVisible();
    await expectPageChecks(
      page,
      "phone Collection Import review, group left out"
    );
  });
});
