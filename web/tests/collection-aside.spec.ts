import { expect, mergeTests, type Page } from "@playwright/test";
import { signInAsOwner } from "./support/sign-in";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { startAsNewOwner } from "./support/owner";
import { expectPageChecks } from "./support/page-check";
import { test as artTest, artUpstream } from "./support/art-upstream";
import { test as collectorsTest } from "./support/collectors";
import { befriend, lendHandedOver, nameCollector } from "./support/loans";

const test = mergeTests(artTest, collectorsTest);

type TreeNode = { id: string; name: string; version: number };

// Helpers copied from workspace-sheet-actions.spec.ts so that spec stays untouched.

/** Replaces the catalog with one Printing per name (set "Fixture Set", number from the id),
 * each with artwork. This also clears every Holding, so All owned holds only what a test adds. */
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
  // Card art comes through the art route; the API fetches it from the art stub (a 1×1 PNG).
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

/** Creates a Location through the API and returns its id. */
async function createLocation(
  page: Page,
  name: string,
  parentId: string | null
): Promise<string> {
  const api = (path: string) => new URL(path, page.url()).href;
  let parentVersion: number | null = null;
  if (parentId) {
    const tree = await page.request.get(api("/api/location-tree"));
    expect(tree.ok()).toBeTruthy();
    parentVersion = (
      (await tree.json()) as { locations: TreeNode[] }
    ).locations.find((node) => node.id === parentId)!.version;
  }
  const response = await page.request.post(api("/api/location-tree"), {
    headers: { origin: new URL(page.url()).origin },
    data: {
      name,
      parent_id: parentId,
      parent_version: parentVersion,
      idempotency_key: randomUUID(),
    },
  });
  expect(response.status()).toBe(201);
  return ((await response.json()) as { location: TreeNode }).location.id;
}

/** Adds copies of an Edition to a Storage Leaf through the API. */
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

/** The normal-finish Edition of a fixture Printing. */
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

test.use({ viewport: { width: 1280, height: 800 } });

const tiles = (page: Page) =>
  page.getByRole("region", { name: "Cards" }).getByRole("button");
const aside = (page: Page) =>
  page.getByRole("complementary", { name: "Card details" });
const toasts = (page: Page) =>
  page.getByRole("region", { name: "Notifications" });

test("the aside's Move… and Remove… confirm one copy, return focus on cancel, and offer Undo", async ({
  page,
}) => {
  promoteCatalog({ "card-1": "Aside Abra" });
  await signIn(page);
  const source = await createLocation(page, "Source binder", null);
  await createLocation(page, "Destination binder", null);
  await addCopies(page, source, await editionOf("card-1"), 3);
  await page.reload();
  await expect(tiles(page)).toHaveCount(3);
  await tiles(page).first().click();
  const move = aside(page).getByRole("button", { name: "Move…", exact: true });
  const remove = aside(page).getByRole("button", {
    name: "Remove…",
    exact: true,
  });
  await expect(move).toBeVisible();
  await expect(remove).toBeVisible();
  // Same order as the phone sheet: Move… then Remove…, reached by Tab inside the aside.
  await move.focus();
  await page.keyboard.press("Tab");
  await expect(remove).toBeFocused();
  await expectPageChecks(page, "card aside actions");

  const moveDialog = page.getByRole("dialog", {
    name: "Move 1 copy",
    exact: true,
  });
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Enter");
  await expect(moveDialog.getByRole("searchbox")).toBeFocused();
  await moveDialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(move).toBeFocused();
  await expect(aside(page)).toContainText("Aside Abra");

  await remove.click();
  const removal = page.getByRole("dialog", {
    name: "Remove 1 copy from your Collection",
    exact: true,
  });
  await expect(
    removal.getByRole("button", { name: "Cancel", exact: true })
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(remove).toBeFocused();

  await move.click();
  await moveDialog
    .getByRole("button", { name: "Destination binder", exact: true })
    .click();
  await moveDialog
    .getByRole("button", { name: "Move 1 copy", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(toasts(page)).toContainText(
    "Moved 1 copy to Destination binder."
  );
  await expect(page.locator("#ws-heading")).toBeFocused();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(toasts(page)).toContainText("Undo restored 1 copy");
  await expect(tiles(page)).toHaveCount(3);

  await tiles(page).first().click();
  await remove.click();
  await removal
    .getByRole("button", { name: "Remove 1 copy", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(tiles(page)).toHaveCount(2);
  await expect(toasts(page)).toContainText("Removed 1 copy");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(tiles(page)).toHaveCount(3);
});

test("the aside acts on the copy it shows, not on the whole selection", async ({
  page,
}) => {
  promoteCatalog({ "card-1": "Aside Abra" });
  await signIn(page);
  const source = await createLocation(page, "Selection binder", null);
  await createLocation(page, "Other binder", null);
  await addCopies(page, source, await editionOf("card-1"), 3);
  await page.reload();
  await expect(tiles(page)).toHaveCount(3);
  await tiles(page).nth(0).click();
  await tiles(page)
    .nth(1)
    .click({ modifiers: ["ControlOrMeta"] });
  const selection = page.getByRole("region", { name: "Selection" });
  await expect(selection).toContainText("2 copies selected");
  await aside(page).getByRole("button", { name: "Move…", exact: true }).click();
  const move = page.getByRole("dialog", { name: "Move 1 copy", exact: true });
  await expect(move).toBeVisible();
  await move.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(selection).toContainText("2 copies selected");
  await expect(
    page
      .getByRole("region", { name: "Cards" })
      .getByRole("button", { pressed: true })
  ).toHaveCount(2);

  await aside(page).getByRole("button", { name: "Move…", exact: true }).click();
  await move.getByRole("button", { name: "Other binder", exact: true }).click();
  await move.getByRole("button", { name: "Move 1 copy", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(toasts(page)).toContainText("Moved 1 copy to Other binder.");
  // The other selected copy stays where it was.
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(toasts(page)).toContainText("Undo restored 1 copy");
});

test("cancelling from an aside opened by its address keeps the card in view", async ({
  page,
}) => {
  promoteCatalog({ "card-1": "Aside Abra" });
  await signIn(page);
  const source = await createLocation(page, "Linked binder", null);
  await addCopies(page, source, await editionOf("card-1"), 2);
  await page.reload();
  await expect(tiles(page)).toHaveCount(2);
  await tiles(page).first().click();
  await expect(page).toHaveURL(/[?&]card=/);
  const address = page.url();
  await page.reload();
  await expect(aside(page)).toContainText("Aside Abra");
  await expect(page.getByRole("region", { name: "Selection" })).toHaveCount(0);
  await aside(page)
    .getByRole("button", { name: "Remove…", exact: true })
    .click();
  const removal = page.getByRole("dialog", {
    name: "Remove 1 copy from your Collection",
    exact: true,
  });
  await removal.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(aside(page)).toContainText("Aside Abra");
  await expect(
    aside(page).getByRole("button", { name: "Remove…", exact: true })
  ).toBeFocused();
  expect(page.url()).toBe(address);
  await expect(page.getByRole("region", { name: "Selection" })).toHaveCount(0);
});

test("a Borrowed Copy has Move… but no Remove… in the aside", async ({
  page,
  collectors,
}) => {
  promoteCatalog({ "card-1": "Aside Abra" });
  const lender = (await collectors.signIn()).page;
  await nameCollector(lender, "Sam");
  const source = await createLocation(lender, "Lender binder", null);
  const edition = await editionOf("card-1");
  await addCopies(lender, source, edition, 2);
  await signIn(page);
  await nameCollector(page, "Jordan");
  await befriend(lender, page);
  await lendHandedOver(lender, page, [[edition, 2]]);
  await createLocation(page, "Borrowed destination", null);
  await page.reload();
  await expect(tiles(page)).toHaveCount(2);
  await tiles(page).first().click();
  await expect(
    aside(page).getByRole("button", { name: "Move…", exact: true })
  ).toBeVisible();
  await expect(
    aside(page).getByRole("button", { name: "Remove…", exact: true })
  ).toHaveCount(0);
  await expectPageChecks(page, "borrowed card aside");
  await aside(page).getByRole("button", { name: "Move…", exact: true }).click();
  const move = page.getByRole("dialog", { name: "Move 1 copy", exact: true });
  await move
    .getByRole("button", { name: "Borrowed destination", exact: true })
    .click();
  await move.getByRole("button", { name: "Move 1 copy", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(toasts(page)).toContainText(
    "Moved 1 copy to Borrowed destination."
  );
});

/** Closes an open dialog the way a collector would. */
async function dismiss(
  page: Page,
  dialog: ReturnType<Page["getByRole"]>,
  how: "Cancel" | "Escape"
) {
  if (how === "Cancel")
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  else await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
}

for (const how of ["Cancel", "Escape"] as const) {
  test(`a selection-bar Move after an aside Move cancelled returns focus to Actions (${how})`, async ({
    page,
  }) => {
    promoteCatalog({ "card-1": "Aside Abra" });
    await signIn(page);
    const source = await createLocation(page, "Source binder", null);
    await createLocation(page, "Destination binder", null);
    await addCopies(page, source, await editionOf("card-1"), 3);
    await page.reload();
    await expect(tiles(page)).toHaveCount(3);
    await tiles(page).first().click();
    const move = page.getByRole("dialog", { name: "Move 1 copy", exact: true });
    const asideMove = aside(page).getByRole("button", {
      name: "Move…",
      exact: true,
    });
    await asideMove.click();
    await dismiss(page, move, how);
    await expect(asideMove).toBeFocused();

    const bar = page.getByRole("region", { name: "Selection" });
    const actions = bar.getByRole("button", { name: "Actions", exact: true });
    await actions.click();
    await bar.getByRole("button", { name: "Move…", exact: true }).click();
    await expect(move).toBeVisible();
    await dismiss(page, move, how);
    await expect(actions).toBeFocused();
  });

  test(`a selection-bar Move after an aside Move succeeded returns focus to Actions (${how})`, async ({
    page,
  }) => {
    promoteCatalog({ "card-1": "Aside Abra" });
    await signIn(page);
    const source = await createLocation(page, "Source binder", null);
    await createLocation(page, "Destination binder", null);
    await addCopies(page, source, await editionOf("card-1"), 3);
    await page.reload();
    await expect(tiles(page)).toHaveCount(3);
    await tiles(page).first().click();
    const move = page.getByRole("dialog", { name: "Move 1 copy", exact: true });
    await aside(page)
      .getByRole("button", { name: "Move…", exact: true })
      .click();
    await move
      .getByRole("button", { name: "Destination binder", exact: true })
      .click();
    await move
      .getByRole("button", { name: "Move 1 copy", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(toasts(page)).toContainText(
      "Moved 1 copy to Destination binder."
    );

    await tiles(page).first().click();
    const bar = page.getByRole("region", { name: "Selection" });
    const actions = bar.getByRole("button", { name: "Actions", exact: true });
    await actions.click();
    await bar.getByRole("button", { name: "Move…", exact: true }).click();
    await expect(move).toBeVisible();
    await dismiss(page, move, how);
    await expect(actions).toBeFocused();
  });
}

test("a stale Move from the aside stays reachable and retries exactly once", async ({
  page,
}) => {
  promoteCatalog({ "card-1": "Aside Abra" });
  await signIn(page);
  const source = await createLocation(page, "Source binder", null);
  const destination = await createLocation(page, "Destination binder", null);
  const edition = await editionOf("card-1");
  await addCopies(page, source, edition, 1);
  await page.reload();
  await expect(tiles(page)).toHaveCount(1);
  await tiles(page).first().click();
  await aside(page).getByRole("button", { name: "Move…", exact: true }).click();
  const move = page.getByRole("dialog", { name: "Move 1 copy", exact: true });
  await move
    .getByRole("button", { name: "Destination binder", exact: true })
    .click();

  // A second session moves and undoes the same Holding, changing its version.
  const other = await page.context().newPage();
  await other.setViewportSize({ width: 1280, height: 800 });
  await other.goto(new URL("/collection", page.url()).href);
  await expect(tiles(other)).toHaveCount(1);
  await tiles(other).first().click();
  const bar = other.getByRole("region", { name: "Selection" });
  await bar.getByRole("button", { name: "Actions", exact: true }).click();
  await bar.getByRole("button", { name: "Move…", exact: true }).click();
  const otherMove = other.getByRole("dialog", {
    name: "Move 1 copy",
    exact: true,
  });
  await otherMove
    .getByRole("button", { name: "Destination binder", exact: true })
    .click();
  await otherMove
    .getByRole("button", { name: "Move 1 copy", exact: true })
    .click();
  await other.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(toasts(other)).toContainText("Undo restored 1 copy");
  await other.close();

  const confirm = move.getByRole("button", {
    name: "Move 1 copy",
    exact: true,
  });
  const refreshed = page.waitForResponse(
    (r) => new URL(r.url()).pathname === "/api/collection/holdings"
  );
  await confirm.click();
  await refreshed;
  await expect(move.getByRole("alert")).toContainText("Nothing moved.");
  await expect(move.getByRole("alert")).toContainText("try again");
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(toasts(page)).toContainText(
    "Moved 1 copy to Destination binder."
  );
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const { rows } = await pool.query(
      "SELECT location_id, quantity FROM holding WHERE edition_id=$1",
      [edition]
    );
    expect(rows).toEqual([
      expect.objectContaining({ location_id: destination, quantity: "1" }),
    ]);
  } finally {
    await pool.end();
  }
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(toasts(page)).toContainText("Undo restored 1 copy");
});
