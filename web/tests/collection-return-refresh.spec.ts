import { expect, type Page } from "@playwright/test";
import { signInAsOwner } from "./support/sign-in";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { startAsNewOwner } from "./support/owner";
import { test as artTest, artUpstream } from "./support/art-upstream";

type TreeNode = { id: string; name: string; version: number };

// Helpers copied from workspace-stale.spec.ts so that spec stays untouched.

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

const cards = (page: Page) => page.getByRole("region", { name: "Cards" });
const tiles = (page: Page) => cards(page).getByRole("button");
const bar = (page: Page) => page.getByRole("region", { name: "Selection" });
const mainViews = (page: Page) =>
  page.getByRole("navigation", { name: "Main views" });
const tab = (page: Page, name: string) =>
  mainViews(page).getByRole("button", { name, exact: true });
const STALE = "Your collection has changed since this view loaded.";
const banner = (page: Page) =>
  page.getByRole("status").filter({ hasText: STALE });

type Prepared = { leaf: string; pikachu: string };

/** The seeding, the sign-in and the first Collection load happen here, so each test body starts with Collection
 * loaded at 123 copies. Seeds 120 Abra and 3 Pikachu in one Storage Leaf, so the gallery scrolls. */
const test = artTest.extend<{ prepared: Prepared }>({
  prepared: async ({ page }, use) => {
    promoteCatalog({ "card-1": "Return Abra", "card-2": "Return Pikachu" });
    await signIn(page);
    const s = randomUUID().slice(0, 8);
    const leaf = await createLocation(page, `Return ${s}`, null);
    const pikachu = await editionOf("card-2");
    await addCopies(page, leaf, await editionOf("card-1"), 120);
    await addCopies(page, leaf, pikachu, 3);
    await page.reload();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "All owned"
    );
    await expect(page.getByRole("main")).toContainText(
      "123 copies · 2 editions"
    );
    await use({ leaf, pikachu });
  },
});

/** Watches the page from here on: whether the banner's text ever appeared, and whether the Cards region, while it
 * was shown, ever held no tile (the gallery empties while it reads again). Checked after every DOM change, which
 * runs before the browser paints it. */
async function watchPage(page: Page) {
  await page.evaluate((text) => {
    const w = window as unknown as {
      bannerSeen: boolean;
      cardsEmptied: boolean;
    };
    w.bannerSeen = false;
    w.cardsEmptied = false;
    const look = () => {
      if (document.body.innerText.includes(text)) w.bannerSeen = true;
      const cards = document.querySelector('section[aria-label="Cards"]');
      if (
        cards &&
        cards.getClientRects().length > 0 &&
        cards.querySelector("button") === null
      )
        w.cardsEmptied = true;
    };
    new MutationObserver(look).observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });
  }, STALE);
}
const watched = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as {
      bannerSeen: boolean;
      cardsEmptied: boolean;
    };
    return { bannerSeen: w.bannerSeen, cardsEmptied: w.cardsEmptied };
  });

test.describe("returning to Collection from another page (slice 5)", () => {
  test.use({ viewport: { width: 1280, height: 860 } });

  test("an idle Collection refreshes quietly when the collector returns: new data, no banner, same scroll, Location and history", async ({
    page,
    prepared: { leaf, pikachu },
  }) => {
    await page.evaluate(() => window.scrollTo(0, 700));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(700);
    await tab(page, "Decks").click();
    await expect(page).toHaveURL(/\/decks$/);
    await watchPage(page);

    // A holding change elsewhere (here the API), while Collection is out of sight.
    await addCopies(page, leaf, pikachu, 1);
    await tab(page, "Collection").click();
    await expect(page).toHaveURL(/\/collection$/);
    // Pressing the tab is the one navigation; the refresh adds none.
    const entries = await page.evaluate(() => window.history.length);
    await expect(page.getByRole("main")).toContainText(
      "124 copies · 2 editions"
    );
    await expect(banner(page)).toHaveCount(0);
    expect(await watched(page), "no banner frame, no empty gallery").toEqual({
      bannerSeen: false,
      cardsEmptied: false,
    });
    expect(await page.evaluate(() => window.scrollY)).toBe(700);
    expect(await page.evaluate(() => window.history.length)).toBe(entries);
  });

  test("a Collection with a selection does not refresh on return and keeps the banner and the selection", async ({
    page,
    prepared: { leaf, pikachu },
  }) => {
    await tiles(page).nth(0).click();
    await expect(bar(page)).toContainText("1 copy selected");
    await tab(page, "Decks").click();
    await expect(page).toHaveURL(/\/decks$/);

    await addCopies(page, leaf, pikachu, 1);
    await tab(page, "Collection").click();
    await expect(banner(page)).toHaveText(STALE);
    await expect(page.getByRole("main")).toContainText(
      "123 copies · 2 editions"
    );
    await expect(bar(page)).toContainText("1 copy selected");
    // Nothing refreshed by itself: it takes Reload.
    await page.getByRole("button", { name: "Reload", exact: true }).click();
    await expect(page.getByRole("main")).toContainText(
      "124 copies · 2 editions"
    );
    await expect(banner(page)).toHaveCount(0);
  });

  // A pending Move keeps Collection busy. Only a Move that involves Borrowed copies is held for recovery in its own
  // tab, which needs a Loan; a Move in progress in another tab of the same account is held the same way (the
  // workspace's Pending Move notice), and is the pending command a browser can make here. A Move or drag in
  // progress, and an open dialog, sheet or drawer, cannot survive a page change (the shell closes them as Collection
  // is hidden), so they are covered by the idle predicate's unit tests and the refresh-landing component tests.
  test("a Move in progress in another tab keeps Collection busy: no refresh on return, and the banner", async ({
    page,
    prepared: { leaf, pikachu },
  }) => {
    const session = await page.request.get(
      new URL("/auth/session", page.url()).href
    );
    const { userId } = (await session.json()) as { userId: string };
    // The other tab holds the account's Move lock, as a Move in progress does, and announces it.
    const other = await page.context().newPage();
    await other.goto(new URL("/auth/session", page.url()).href);
    await other.evaluate(
      (owner) =>
        new Promise<void>((held) => {
          const name = `prizecheck:mixed-move:${encodeURIComponent(owner)}`;
          void navigator.locks.request(name, () => {
            localStorage.setItem(`${name}:activity`, crypto.randomUUID());
            held();
            return new Promise<void>(() => {});
          });
        }),
      userId
    );
    await expect(
      page.getByRole("region", { name: "Pending Move" })
    ).toContainText("A Move is in progress in another tab.");
    await expect(bar(page)).toHaveCount(0);

    await tab(page, "Decks").click();
    await expect(page).toHaveURL(/\/decks$/);
    await addCopies(page, leaf, pikachu, 1);
    await tab(page, "Collection").click();
    await expect(banner(page)).toHaveText(STALE);
    await expect(page.getByRole("main")).toContainText(
      "123 copies · 2 editions"
    );
    await expect(
      page.getByRole("region", { name: "Pending Move" })
    ).toBeVisible();
    await other.close();
  });

  test("a change seen while the tab is in front still shows the banner, even when Collection is idle", async ({
    page,
    prepared: { leaf, pikachu },
  }) => {
    await addCopies(page, leaf, pikachu, 1);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(banner(page)).toHaveText(STALE);
    await expect(page.getByRole("main")).toContainText(
      "123 copies · 2 editions"
    );
  });
});
