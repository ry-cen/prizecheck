// Catalog states (m11 s5): an Add that fails with the device offline says so and offers Retry on the same safe add;
// an empty search offers one step that clears the search and every filter; and in Add mode an owned count reads
// "×N owned" while the card also has a queued count, so the two numbers can't be mistaken for each other.
import { expect, type Locator, type Page } from "@playwright/test";
import { signInAsOwner } from "./support/sign-in";
import { execFileSync } from "node:child_process";
import { Pool } from "pg";
import { startAsNewOwner } from "./support/owner";
import { expectPageChecks } from "./support/page-check";
import { expectTouchTarget } from "./support/touch-target";
import { test, artUpstream } from "./support/art-upstream";

const ORIGIN = process.env.TEST_ORIGIN || "http://localhost:5173";

/** Five tiles (api/tests/test_catalog_browse.py seed_popup): Bulbasaur Normal and Reverse Holo (MEG 001), Rare Candy
 * (MEG 125) and Switch (MEG 130), then Professor's Research (Professor Juniper). */
function seedPopup() {
  execFileSync(
    ".venv/bin/python",
    ["-c", "from test_catalog_browse import seed_popup\nseed_popup()"],
    { env: { ...process.env, PYTHONPATH: "api:api/tests" } }
  );
}

async function signIn(page: Page) {
  // Card art comes through the art route; the API fetches it from the art stub (a 1×1 PNG).
  (await artUpstream()).reset();
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await startAsNewOwner(pool);
    await pool.query("DELETE FROM auth_send_event");
  } finally {
    await pool.end();
  }
  await signInAsOwner(page, "/catalog");
  await expect(page).toHaveURL(/\/catalog$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Catalog");
}

type TreeNode = { id: string; name: string };
async function unsortedId(page: Page): Promise<string> {
  const response = await page.request.get(`${ORIGIN}/api/location-tree`);
  return ((await response.json()) as { locations: TreeNode[] }).locations.find(
    (node) => node.name === "Unsorted"
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

const search = (page: Page) =>
  page.getByRole("searchbox", { name: "Search the catalog" });
const results = (page: Page | Locator) =>
  page.getByRole("region", { name: "Catalog results" });
const tile = (page: Page, start: string): Locator =>
  results(page).getByRole("button", {
    name: new RegExp(`^${start.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
  });
const filters = (page: Page) => page.getByRole("group", { name: "Filters" });
const chip = (page: Page, name: string) =>
  filters(page).getByRole("button", { name, exact: true });
const mode = (page: Page, name: string) =>
  page
    .getByRole("radiogroup", { name: "Catalog mode" })
    .getByRole("radio", { name });
const more = (page: Page, words: string) =>
  results(page).getByRole("button", {
    name: `One more ${words}`,
    exact: true,
  });
const fewer = (page: Page, words: string) =>
  results(page).getByRole("button", {
    name: `One fewer ${words}`,
    exact: true,
  });
const addBar = (page: Page) =>
  page.getByRole("region", { name: "Add to a Location" });

const BULBASAUR = "Bulbasaur MEG 001 Normal";
const OFFLINE = "You're offline. Add again when you're back online.";

for (const viewport of [
  { width: 1280, height: 800, touch: false },
  { width: 375, height: 812, touch: true },
]) {
  test.describe(`catalog states at ${viewport.width}×${viewport.height}`, () => {
    test.use({
      viewport: { width: viewport.width, height: viewport.height },
      hasTouch: viewport.touch,
    });

    test("an Add that fails offline says so and offers Retry, which fails the same way while still offline", async ({
      page,
      context,
    }) => {
      seedPopup();
      await signIn(page);
      await tile(page, "Switch, MEG 130").click();
      const popup = page.getByRole("dialog", { name: "Switch", exact: true });
      const add = popup.getByRole("button", { name: "Add 1", exact: true });
      await expect(add).toBeEnabled();
      await context.setOffline(true);
      await add.click();
      await expect(popup.getByText(OFFLINE)).toBeVisible();
      await expect(
        popup.getByText("Add may have completed", { exact: false })
      ).toHaveCount(0);
      const retry = popup.getByRole("button", { name: "Retry", exact: true });
      await expect(retry).toBeVisible();
      if (viewport.touch) await expectTouchTarget(retry, ["height"]);
      await expectPageChecks(page, "Catalog card popup, Add failed offline");

      // Still offline: Retry fails the same way, and nothing was added.
      await retry.click();
      await expect(popup.getByText(OFFLINE)).toBeVisible();
      await expect(retry).toBeVisible();
    });
  });
}

test.describe("offline Add, back online", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("Retry after the connection returns adds exactly one copy", async ({
    page,
    context,
  }) => {
    seedPopup();
    await signIn(page);
    await tile(page, "Switch, MEG 130").click();
    const popup = page.getByRole("dialog", { name: "Switch", exact: true });
    await context.setOffline(true);
    await popup.getByRole("button", { name: "Add 1", exact: true }).click();
    await expect(popup.getByText(OFFLINE)).toBeVisible();
    await context.setOffline(false);
    await popup.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(popup).toContainText("1 copy owned");
    await expect(popup.getByText(OFFLINE)).toHaveCount(0);
    await expect(
      popup.getByRole("button", { name: "Retry", exact: true })
    ).toHaveCount(0);
    expect(await held(page, await unsortedId(page))).toEqual(["1 Switch"]);
    // Retry gave up its focus to Add while it ran, and the row is usable again.
    await expect(
      popup.getByRole("button", { name: "Add 1", exact: true })
    ).toBeFocused();
  });
});

for (const viewport of [
  { width: 1280, height: 800, touch: false },
  { width: 375, height: 812, touch: true },
]) {
  test.describe(`empty search at ${viewport.width}×${viewport.height}`, () => {
    test.use({
      viewport: { width: viewport.width, height: viewport.height },
      hasTouch: viewport.touch,
    });

    test("Clear search and filters resets the search and every filter in one step", async ({
      page,
    }) => {
      seedPopup();
      await signIn(page);
      await expect(results(page).getByRole("listitem")).toHaveCount(5);
      await chip(page, "Owned only").click();
      await expect(results(page)).toContainText("No cards match this search.");
      await search(page).fill("zzzzqq");
      await expect(results(page)).toContainText("No cards match this search.");
      await expect(page).toHaveURL(/q=zzzzqq/);
      await expect(page).toHaveURL(/owned=1/);
      const clear = results(page).getByRole("button", {
        name: "Clear search and filters",
        exact: true,
      });
      if (viewport.touch) await expectTouchTarget(clear, ["height"]);
      await expectPageChecks(page, "Catalog, no match");
      await clear.click();
      await expect(search(page)).toHaveValue("");
      await expect(search(page)).toBeFocused();
      await expect(page).toHaveURL(/\/catalog$/);
      await expect(chip(page, "Owned only")).toHaveAttribute(
        "aria-pressed",
        "false"
      );
      await expect(results(page).getByRole("listitem")).toHaveCount(5);
      await expect(
        results(page).getByRole("button", { name: "Clear search and filters" })
      ).toHaveCount(0);
    });
  });
}

test.describe("owned count in Add mode at 375×812 touch", () => {
  test.use({
    viewport: { width: 375, height: 812 },
    hasTouch: true,
  });

  test("a queued card says how many you own in words and keeps its stepper clear", async ({
    page,
  }) => {
    seedPopup();
    await signIn(page);
    await mode(page, "Add to a Location").tap();
    await more(page, BULBASAUR).tap();
    await addBar(page).getByRole("button", { name: "Add 1 card" }).tap();
    const owned = tile(page, "Bulbasaur, MEG 001, Mega Evolution, Normal");
    await expect(owned).toHaveAccessibleName(
      "Bulbasaur, MEG 001, Mega Evolution, Normal, 1 owned"
    );
    // Nothing queued: the short badge.
    await expect(owned.getByText("×1", { exact: true })).toBeVisible();
    await expect(owned).not.toContainText("owned");

    await more(page, BULBASAUR).tap();
    await expect(owned).toHaveAccessibleName(
      "Bulbasaur, MEG 001, Mega Evolution, Normal, 1 owned, 1 to add"
    );
    const badge = owned.getByText("×1 owned", { exact: true });
    await expect(badge).toBeVisible();
    const stepper = results(page).getByRole("group", {
      name: `${BULBASAUR}: 1 to add`,
      exact: true,
    });
    for (const control of [more(page, BULBASAUR), fewer(page, BULBASAUR)])
      await expectTouchTarget(control);
    const [a, b, tileBox] = await Promise.all([
      badge.boundingBox(),
      stepper.boundingBox(),
      owned.boundingBox(),
    ]);
    expect(a && b && tileBox).toBeTruthy();
    // The badge sits clear of the stepper and inside its tile: no overflow, no overlap.
    expect(
      a!.y + a!.height <= b!.y ||
        b!.y + b!.height <= a!.y ||
        a!.x + a!.width <= b!.x
    ).toBe(true);
    expect(a!.x).toBeGreaterThanOrEqual(tileBox!.x);
    expect(a!.x + a!.width).toBeLessThanOrEqual(tileBox!.x + tileBox!.width);
    await expectPageChecks(page, "Catalog, Add mode, owned and queued");

    // Back to nothing queued, and the badge is short again.
    await fewer(page, BULBASAUR).tap();
    await expect(owned.getByText("×1", { exact: true })).toBeVisible();
    await expect(owned).not.toContainText("owned");
  });
});
