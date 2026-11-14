import { execFileSync } from "node:child_process";
import { type Page } from "@playwright/test";
import { Pool } from "pg";
import { randomInt, randomUUID } from "node:crypto";
import { test, expect } from "./support/collectors";
import { startAsNewOwner } from "./support/owner";
import { signInAsOwner } from "./support/sign-in";
import { buildLegalDeck, promoteLegalCatalog } from "./support/legal-deck";

// Navigation and continuity (S14e): the desktop inspector keeps its card in the address, Back to a Deck restores
// its scroll, a Friend's Collection opened from the Friends dialog takes heading focus, an address that is no page
// says so, and a For trade tag gives way before its Location's name.

const ORIGIN = process.env.TEST_ORIGIN || "http://localhost:5173";
/** The restore window of web/src/shell/restorePageScroll.ts (RESTORE_WINDOW_MS). */
const RESTORE_WINDOW_MS = 5000;
const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 375, height: 812 };

/** Replaces the catalog with one Printing per name; this also clears every Holding. */
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

async function signIn(page: Page, path = "/collection") {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await startAsNewOwner(pool);
  } finally {
    await pool.end();
  }
  await signInAsOwner(page, path);
}

async function createLocation(page: Page, name: string): Promise<string> {
  const response = await page.request.post(`${ORIGIN}/api/location-tree`, {
    headers: { origin: ORIGIN },
    data: {
      name,
      parent_id: null,
      parent_version: null,
      idempotency_key: randomUUID(),
    },
  });
  expect(response.status()).toBe(201);
  return (await response.json()).location.id as string;
}

async function addCopies(
  page: Page,
  locationId: string,
  editionId: string,
  quantity: number
) {
  const response = await page.request.post(`${ORIGIN}/api/holdings`, {
    headers: { origin: ORIGIN },
    data: {
      location_id: locationId,
      edition_id: editionId,
      quantity: String(quantity),
      idempotency_key: randomUUID(),
    },
  });
  expect(response.status(), await response.text()).toBe(200);
}

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
const searchOf = (url: string) => new URL(url).searchParams;

test.describe("the desktop inspector's address", () => {
  test.use({ viewport: DESKTOP });

  test("desktop inspector writes card and a reload keeps it", async ({
    page,
    collectors,
  }) => {
    promoteCatalog({ "card-1": "Address Abra", "card-2": "Address Zubat" });
    await startAsNewOwner(collectors.pool);
    await signInAsOwner(page, "/collection");
    const leaf = await createLocation(page, "Address binder");
    await addCopies(page, leaf, await editionOf("card-1"), 2);
    await addCopies(page, leaf, await editionOf("card-2"), 1);
    await page.goto(`${ORIGIN}/collection?location=${leaf}`);
    await expect(tiles(page)).toHaveCount(3);
    const before = await page.evaluate(() => history.length);

    await tiles(page).nth(1).click();
    await expect.poll(() => searchOf(page.url()).get("card")).not.toBeNull();
    const params = searchOf(page.url());
    expect(params.get("location")).toBe(leaf);
    expect(params.get("copy")).toBe("1");
    expect(await page.evaluate(() => history.length)).toBe(before);
    const inspector = page.getByRole("complementary", { name: "Card details" });
    const named = await inspector.getByRole("heading").first().innerText();

    await page.reload();
    await expect(tiles(page)).toHaveCount(3);
    expect(searchOf(page.url()).get("card")).toBe(params.get("card"));
    await expect(
      page.getByRole("complementary", { name: "Card details" })
    ).toContainText(named);

    // A click on the first copy of another card writes it without `copy`.
    await tiles(page).nth(2).click();
    await expect
      .poll(() => searchOf(page.url()).get("card"))
      .not.toBe(params.get("card"));
    expect(searchOf(page.url()).has("copy")).toBe(false);
    expect(await page.evaluate(() => history.length)).toBe(before);

    // Deselecting, and Escape, take the card out of the address.
    await tiles(page).nth(2).click();
    await expect.poll(() => searchOf(page.url()).has("card")).toBe(false);
    await tiles(page).nth(0).click();
    await expect.poll(() => searchOf(page.url()).has("card")).toBe(true);
    await page.keyboard.press("Escape");
    await expect.poll(() => searchOf(page.url()).has("card")).toBe(false);
    expect(searchOf(page.url()).get("location")).toBe(leaf);
    expect(await page.evaluate(() => history.length)).toBe(before);
  });

  test("a desktop Move of the inspected card drops card without a notice", async ({
    page,
    collectors,
  }) => {
    promoteCatalog({ "card-1": "Moved Abra" });
    await startAsNewOwner(collectors.pool);
    await signInAsOwner(page, "/collection");
    const from = await createLocation(page, "Move from");
    await createLocation(page, "Move to");
    await addCopies(page, from, await editionOf("card-1"), 1);
    await page.goto(`${ORIGIN}/collection?location=${from}`);
    await expect(tiles(page)).toHaveCount(1);
    await tiles(page).first().click();
    await expect.poll(() => searchOf(page.url()).has("card")).toBe(true);

    await page
      .getByRole("region", { name: "Selection" })
      .getByRole("button", { name: "Actions" })
      .click();
    await page
      .getByRole("region", { name: "Selection" })
      .getByRole("button", { name: "Move…" })
      .click();
    const dialog = page.getByRole("dialog", { name: "Move 1 copy" });
    await dialog.getByRole("button", { name: "Move to", exact: true }).click();
    await dialog.getByRole("button", { name: "Move 1 copy" }).click();
    await expect(tiles(page)).toHaveCount(0);
    await expect.poll(() => searchOf(page.url()).has("card")).toBe(false);
    expect(searchOf(page.url()).get("location")).toBe(from);
    await expect(
      page.getByText("This card is unavailable here", { exact: false })
    ).toHaveCount(0);
  });

  test("a desktop deep link to a missing card still says so", async ({
    page,
    collectors,
  }) => {
    promoteCatalog({ "card-1": "Deep Abra" });
    await startAsNewOwner(collectors.pool);
    await signInAsOwner(page, "/collection");
    await page.goto(`${ORIGIN}/collection?card=nowhere%3Anothing`);
    await expect(
      page.getByText("This card is unavailable here. Showing your cards.")
    ).toBeVisible();
    await expect.poll(() => searchOf(page.url()).has("card")).toBe(false);
  });
});

test.describe("a phone sheet still pushes", () => {
  test.use({ viewport: PHONE, hasTouch: true });

  test("a tap pushes the sheet entry and Back closes it", async ({
    page,
    collectors,
  }) => {
    promoteCatalog({ "card-1": "Sheet Abra" });
    await startAsNewOwner(collectors.pool);
    await signInAsOwner(page, "/collection");
    const leaf = await createLocation(page, "Sheet binder");
    await addCopies(page, leaf, await editionOf("card-1"), 1);
    await page.goto(`${ORIGIN}/collection?location=${leaf}`);
    await expect(tiles(page)).toHaveCount(1);
    const before = await page.evaluate(() => history.length);
    await tiles(page).first().tap();
    await expect.poll(() => searchOf(page.url()).has("card")).toBe(true);
    expect(await page.evaluate(() => history.length)).toBe(before + 1);
    await page.goBack();
    await expect.poll(() => searchOf(page.url()).has("card")).toBe(false);
  });
});

for (const viewport of [DESKTOP, PHONE]) {
  test.describe(`Deck scroll at ${viewport.width}`, () => {
    test.use({ viewport, hasTouch: viewport.width === 375 });

    /** A Deck page, left through All Decks, then returned to with Back. `slow` holds the Deck read after Back. */
    async function leaveAndReturn(page: Page, deckName: string, slow: boolean) {
      const reads: Array<() => void> = [];
      let held = false;
      if (slow)
        await page.route(/\/api\/decks\/[0-9a-f-]{36}$/, async (route) => {
          if (!held || route.request().method() !== "GET")
            return route.continue();
          await new Promise<void>((release) => reads.push(release));
          await route.continue();
        });
      await expect(
        page.getByRole("heading", { level: 1, name: deckName })
      ).toBeVisible();
      const end = await page.evaluate(() => {
        window.scrollTo(0, document.documentElement.scrollHeight);
        return window.scrollY;
      });
      expect(end).toBeGreaterThan(0);
      // The link sits at the top of the page, so a pointer click would scroll to it first: activate it in place.
      await page
        .getByRole("link", { name: "All Decks" })
        .evaluate((link: HTMLElement) => link.click());
      await expect(page).toHaveURL(`${ORIGIN}/decks`);
      held = true;
      await page.goBack();
      if (slow) {
        await expect(page.getByText("Loading Deck…")).toBeVisible();
        await expect.poll(() => reads.length).toBeGreaterThan(0);
        // Hold the read until after the restore window (5 s) that used to end the restore, measured on the
        // page's own clock; this is a deadline, not a sleep.
        const deadline =
          (await page.evaluate(() => performance.now())) +
          RESTORE_WINDOW_MS +
          1000;
        await page.waitForFunction((at) => performance.now() > at, deadline, {
          timeout: RESTORE_WINDOW_MS * 3,
        });
        held = false;
        reads.splice(0).forEach((resolve) => resolve());
      }
      return end;
    }

    for (const slow of [false, true])
      test(`Back to a Deck restores its scroll${slow ? ", also after a slow read" : ""}`, async ({
        page,
        collectors,
      }) => {
        promoteLegalCatalog();
        await startAsNewOwner(collectors.pool);
        await signInAsOwner(page, "/decks");
        const deck = await buildLegalDeck(page, "Scroll Deck");
        await page.goto(`${ORIGIN}/decks/${deck.deckId}`);
        const end = await leaveAndReturn(page, deck.deckName, slow);
        await expect(
          page.getByRole("heading", { level: 1, name: deck.deckName })
        ).toBeVisible();
        await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(end);
      });

    test("opening a Deck from a scrolled index starts at the top", async ({
      page,
      collectors,
    }) => {
      promoteLegalCatalog();
      await startAsNewOwner(collectors.pool);
      await signInAsOwner(page, "/decks");
      const deck = await buildLegalDeck(page, "Top Deck");
      await page.goto(`${ORIGIN}/decks`);
      await page.evaluate(() => {
        const filler = document.createElement("div");
        filler.style.height = "3000px";
        document.body.append(filler);
        window.scrollTo(0, 300);
      });
      await page
        .locator("main:visible")
        .getByRole("link", { name: deck.deckName, exact: true })
        .click();
      await expect(
        page.getByRole("heading", { level: 1, name: deck.deckName })
      ).toBeVisible();
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
    });
  });
}

async function api(
  page: Page,
  method: "GET" | "POST" | "PUT",
  path: string,
  data?: object
) {
  const response = await page.request.fetch(`${ORIGIN}${path}`, {
    method,
    headers: { origin: ORIGIN },
    data,
  });
  expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBe(
    true
  );
  return response.json();
}

/** Gives the signed-in collector a Display Name and a new Handle, and returns the Handle. */
async function nameCollector(page: Page, name: string): Promise<string> {
  const tail = Array.from(
    { length: 10 },
    () => "bcdfghjklmnpqrstvwxz"[randomInt(20)]
  ).join("");
  const handle = `${name.split(" ")[0].toLowerCase()}_${tail}`;
  await api(page, "PUT", "/api/profile/display-name", {
    display_name: name,
    idempotency_key: randomUUID(),
  });
  await api(page, "PUT", "/api/profile/handle", {
    handle,
    idempotency_key: randomUUID(),
  });
  return handle;
}

for (const viewport of [DESKTOP, PHONE]) {
  test.describe(`Friends dialog at ${viewport.width}`, () => {
    test.use({ viewport, hasTouch: viewport.width === 375 });

    test("opening a Friend's Collection from the Friends dialog focuses its title", async ({
      page,
      collectors,
    }) => {
      promoteCatalog({ "card-1": "Friend Abra" });
      const misty = await collectors.signIn({ next: "/decks" });
      const handle = await nameCollector(misty.page, "Misty W");
      await signInAsOwner(page, "/decks");
      await nameCollector(page, "Ash K");
      const mistyId = (await api(misty.page, "GET", "/auth/session")).userId;
      const ashId = (await api(page, "GET", "/auth/session")).userId;
      await api(page, "POST", "/api/social/friend-requests", {
        collector_id: mistyId,
        idempotency_key: randomUUID(),
      });
      await api(
        misty.page,
        "POST",
        `/api/social/friend-requests/${ashId}/accept`,
        {
          idempotency_key: randomUUID(),
        }
      );
      await page.reload();
      const friends = page
        .getByRole("button", { name: "Friends", exact: true })
        .filter({ visible: true })
        .first();
      await friends.click();
      await page
        .getByRole("dialog", { name: "Friends" })
        .getByRole("button", { name: "Open Misty W's Collection" })
        .click();
      await expect(page).toHaveURL(`${ORIGIN}/friends/${handle}`);
      const title = page.getByRole("heading", { level: 1, name: "Misty W" });
      await expect(title).toBeFocused();
      // Back refocuses the persistent Friends opener.
      await page.goBack();
      await expect(page).toHaveURL(`${ORIGIN}/decks`);
      await expect(friends).toBeFocused();
    });
  });
}

for (const viewport of [DESKTOP, PHONE]) {
  test.describe(`unknown addresses at ${viewport.width}`, () => {
    test.use({ viewport, hasTouch: viewport.width === 375 });

    test("unknown signed-in addresses show the not-found page; old addresses still redirect", async ({
      page,
      collectors,
    }) => {
      await startAsNewOwner(collectors.pool);
      await signInAsOwner(page, "/collection");
      for (const path of [
        "/nowhere",
        "/collection/extra",
        "/decks/a/b",
        "/friends/",
      ]) {
        await page.goto(`${ORIGIN}${path}`);
        await expect(page).toHaveURL(`${ORIGIN}${path}`);
        await expect(page.getByRole("heading", { level: 1 })).toHaveText(
          "This page doesn't exist"
        );
        await expect(page).toHaveTitle("This page doesn't exist · PrizeCheck");
        await expect(
          page.getByText("The link may be mistyped, or the page has moved.", {
            exact: true,
          })
        ).toBeVisible();
        const links = page.getByRole("main").getByRole("link");
        await expect(links).toHaveText(["Go to Collection", "Discover decks"]);
        await expect(links.nth(0)).toHaveAttribute("href", "/collection");
        await expect(links.nth(1)).toHaveAttribute("href", "/discover");
        await expect(
          page
            .getByRole("navigation", { name: "Main views" })
            .locator('[aria-current="page"]')
        ).toHaveCount(0);
      }
      await page
        .getByRole("main")
        .getByRole("link", { name: "Go to Collection" })
        .click();
      await expect(page).toHaveURL(`${ORIGIN}/collection`);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(
        "All owned"
      );

      // The old addresses still redirect, and so does the sign-in address.
      for (const path of [
        "/",
        "/workspace",
        "/locations",
        "/old-collection",
        "/sign-in",
      ]) {
        await page.goto(`${ORIGIN}${path}`);
        await expect(page).toHaveURL(`${ORIGIN}/collection`);
        await expect(page.getByRole("heading", { level: 1 })).toHaveText(
          "All owned"
        );
      }
      await page.goto(`${ORIGIN}/settings/sign-ins`);
      await expect(page).toHaveURL(`${ORIGIN}/settings`);
      await page.goto(`${ORIGIN}/?location=abc#frag`);
      await expect(page).toHaveURL(`${ORIGIN}/collection?location=abc#frag`);
    });

    test("an address with a trailing slash is the route without it", async ({
      page,
      collectors,
    }) => {
      await startAsNewOwner(collectors.pool);
      await signInAsOwner(page, "/collection");
      await page.goto(`${ORIGIN}/collection/?q=abc#top`);
      await expect(page).toHaveURL(`${ORIGIN}/collection?q=abc#top`);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(
        "All owned"
      );
      await page.goto(`${ORIGIN}/discover/`);
      await expect(page).toHaveURL(`${ORIGIN}/discover`);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(
        "Discover decks"
      );
    });

    test("an unknown Location explains the fallback", async ({
      page,
      collectors,
    }) => {
      await startAsNewOwner(collectors.pool);
      await signInAsOwner(page, "/collection");
      await page.goto(`${ORIGIN}/collection?location=missing-location`);
      await expect(
        page.getByText("This Location is unavailable. Showing All owned.")
      ).toBeVisible();
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(
        "All owned"
      );
    });
  });
}

test.describe("signed out", () => {
  test.use({ viewport: DESKTOP });
  test("an unknown address says This page doesn't exist, with Discover decks and Sign in", async ({
    page,
  }) => {
    await page.goto(`${ORIGIN}/nowhere`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "This page doesn't exist"
    );
    await expect(page).toHaveTitle("This page doesn't exist · PrizeCheck");
    await expect(page.getByRole("main").getByRole("link")).toHaveText([
      "Discover decks",
      "Sign in",
    ]);
    await page.goto(`${ORIGIN}/discover/`);
    await expect(page).toHaveURL(`${ORIGIN}/discover`);
  });
});

test.describe("For trade tag", () => {
  test.use({ viewport: DESKTOP });

  test("the For trade tag gives way to the Location name", async ({
    page,
    collectors,
  }) => {
    await startAsNewOwner(collectors.pool);
    await signInAsOwner(page, "/collection");
    const names = [
      "For trade binder",
      "A much longer For trade binder name that cannot fit",
      "Plain shelf",
    ];
    for (const name of names) {
      const created = await api(page, "POST", "/api/location-tree", {
        name,
        parent_id: null,
        parent_version: null,
        idempotency_key: randomUUID(),
      });
      const location = created.location as { id: string; version: number };
      if (name !== "Plain shelf")
        await api(page, "PUT", `/api/location-tree/${location.id}/for-trade`, {
          for_trade: true,
          version: location.version,
          idempotency_key: randomUUID(),
        });
    }
    await page.reload();
    const sidebar = page
      .getByRole("complementary", { name: "Sidebar" })
      .getByRole("navigation", { name: "Locations" });
    await sidebar
      .getByRole("button", { name: "For trade binder", exact: true })
      .click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "For trade binder"
    );
    const rows = await sidebar
      .locator('[data-testid="for-trade-mark"]')
      .evaluateAll((tags) =>
        tags.map((tag) => {
          const name = tag.previousElementSibling?.matches(".truncate")
            ? tag.previousElementSibling
            : tag.parentElement!.querySelector<HTMLElement>(".truncate")!;
          return {
            tag: tag.getBoundingClientRect().width,
            truncated: name.scrollWidth > name.clientWidth,
            name: name.getBoundingClientRect().width,
          };
        })
      );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) if (row.tag > 0) expect(row.truncated).toBe(false);
    const selected = await sidebar
      .locator('[aria-current="page"] [data-testid="for-trade-mark"]')
      .evaluate((tag) => ({
        tag: tag.getBoundingClientRect().width,
        name: tag
          .parentElement!.querySelector(".truncate")!
          .getBoundingClientRect().width,
      }));
    expect(selected.name).toBeGreaterThan(selected.tag);
  });
});
