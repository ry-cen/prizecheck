import { test, expect, type Page } from "@playwright/test";
import { signInAsOwner } from "./support/sign-in";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { buildLegalDeck, promoteLegalCatalog } from "./support/legal-deck";
import { expectPageChecks } from "./support/page-check";
import { expectTouchTarget } from "./support/touch-target";
import { startAsNewOwner } from "./support/owner";

// My Decks as card tiles led by a cover card (#291). The cards come through the real catalog import
// (support/legal-deck.ts); its fixtures have no artwork, so a tile shows the cover card's name on the placeholder.

const ORIGIN = process.env.TEST_ORIGIN || "http://localhost:5173";
// Art-route addresses, as the API sends them (ADR 0020). The "ok" Printing is answered below; the "fail" one is not a
// Printing the API knows, so the route answers 404.
const IMAGE_OK =
  "/api/art/00000000-0000-4000-8000-0000000000a1/small?v=0000000a";
const IMAGE_FAIL =
  "/api/art/00000000-0000-4000-8000-0000000000a2/small?v=0000000b";
// A 1×1 PNG stands in for card artwork, so no test reaches the network.
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64"
);

async function signIn(page: Page) {
  // Card artwork never reaches the network.
  await page.route(/^https:\/\/assets\.tcgdex\.net\//, (route) =>
    route.abort()
  );
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await pool.query("DELETE FROM auth_send_event");
    await startAsNewOwner(pool);
  } finally {
    await pool.end();
  }
  await signInAsOwner(page, "/collection");
  await expect(
    page.getByRole("navigation", { name: "Main views" })
  ).toBeVisible();
}

/** Fixed cost answers, so nothing waits on the price cache: every Deck costs $12.34 to complete, 57 of 57 priced. */
async function stubCost(page: Page) {
  const figure = (amount: string | null, copies: string) => ({
    status: amount === null ? "empty" : "priced",
    reason: null,
    total_copies: copies,
    priced_copies: copies,
    stale_copies: "0",
    unknown_age_copies: "0",
    fallback_copies: "0",
    amount,
    display_amount: amount === null ? "$0.00" : `$${amount}`,
    currency: "USD",
  });
  await page.route("**/api/decks/*/cost", (route) => {
    const deckId = new URL(route.request().url()).pathname.split("/")[3];
    return route.fulfill({
      json: {
        deck_id: deckId,
        ...figure("15.00", "60"),
        owner_revision: null,
        deck_list_revision: null,
        deck_list_cost: figure("15.00", "60"),
        cost_to_complete: figure("12.34", "57"),
      },
    });
  });
}

const deckIndex = (page: Page) =>
  page.getByRole("navigation", { name: "Deck index" });
const tile = (page: Page, name: string) =>
  deckIndex(page)
    .getByRole("listitem")
    .filter({ has: page.getByRole("link", { name, exact: true }) });

async function emptyDeck(page: Page): Promise<string> {
  const name = `Empty ${randomUUID().slice(0, 6)}`;
  const created = await page.request.post(`${ORIGIN}/api/decks`, {
    headers: { origin: ORIGIN },
    data: { name, idempotency_key: randomUUID() },
  });
  expect(created.status()).toBe(201);
  return name;
}

async function setCover(
  page: Page,
  deckId: string,
  edition: string | null,
  expected: string | null
) {
  const response = await page.request.put(
    `${ORIGIN}/api/decks/${deckId}/cover`,
    {
      headers: { origin: ORIGIN },
      data: {
        edition_id: edition,
        expected_edition_id: expected,
        idempotency_key: randomUUID(),
      },
    }
  );
  expect(response.status()).toBe(200);
}

test.describe("on a desktop", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("My Decks shows each Deck as a tile led by its cover with every fact a row had, and the whole tile opens the Deck", async ({
    page,
  }) => {
    promoteLegalCatalog();
    await signIn(page);
    await stubCost(page);
    const a = await buildLegalDeck(page, "Tiles");
    const b = await buildLegalDeck(page, "Second");
    const emptyName = await emptyDeck(page);

    await page.goto(`${ORIGIN}/decks`);
    const tileA = tile(page, a.deckName);
    const tileB = tile(page, b.deckName);
    const empty = tile(page, emptyName);
    await expect(tileA).toContainText("0/60 in Deck");
    await expect(tileA).toContainText("$12.34 to complete (57/57 priced)");
    await expect(tileA).toContainText("Standard · ✓ Legal");
    // The automatic cover is the line with the most copies; with no artwork its placeholder names the card.
    await expect(tileA).toContainText("Basic Grass Energy");
    await expect(tileA.getByRole("button", { name: /^Want List/ })).toHaveCount(
      0
    );
    await expect(tileA).not.toContainText("Nothing to get");
    await expect(empty).toContainText("Empty: plan a list");
    await expect(empty.locator("img")).toHaveCount(0);

    // The three tiles share one row.
    await expect
      .poll(async () => {
        const boxes = await Promise.all(
          [tileA, tileB, empty].map((t) => t.boundingBox())
        );
        return new Set(boxes.map((box) => Math.round(box!.y))).size;
      })
      .toBe(1);
    await expectPageChecks(page, "Decks index tiles");

    // A click on the cover opens the Deck.
    await tileA.click({ position: { x: 24, y: 24 } });
    await expect(page).toHaveURL(`${ORIGIN}/decks/${a.deckId}`);
    // The Deck page opens its scoped Want List.
    await page.getByRole("button", { name: "Want List", exact: true }).click();
    await expect(page).toHaveURL(`${ORIGIN}/decks/want-list?deck=${a.deckId}`);
  });

  test("A tile shows the picked cover, never a broken image, and falls back when the card leaves the Deck List", async ({
    page,
  }) => {
    promoteLegalCatalog();
    await signIn(page);
    await stubCost(page);
    const built = await buildLegalDeck(page, "Tiles");
    await setCover(page, built.deckId, built.editions.switch, null);

    await page.goto(`${ORIGIN}/decks`);
    const mine = tile(page, built.deckName);
    await expect(mine).toContainText("Switch");
    await expect(mine).not.toContainText("Basic Grass Energy");

    // Registered after signIn's abort route, so these take precedence.
    let imageUrl = IMAGE_OK;
    await page.route(/\/api\/decks(\?.*)?$/, async (route) => {
      const response = await route.fetch();
      const json = await response.json();
      for (const deck of json.decks)
        if (deck.id === built.deckId && deck.cover)
          deck.cover.image_url = imageUrl;
      await route.fulfill({ response, json });
    });
    await page.route(
      /\/api\/art\/00000000-0000-4000-8000-0000000000a1\//,
      (route) => route.fulfill({ contentType: "image/png", body: PIXEL })
    );

    await page.reload();
    await expect(tile(page, built.deckName).locator("img")).toHaveAttribute(
      "src",
      IMAGE_OK
    );
    await expect(tile(page, built.deckName).locator("img")).toBeVisible();

    // A failed image is asked for twice more (a plain surface in between), then replaced by the card's name, never a
    // broken image.
    imageUrl = IMAGE_FAIL;
    await page.reload();
    await expect(tile(page, built.deckName)).toContainText("Switch", {
      timeout: 15_000,
    });
    await expect(tile(page, built.deckName).locator("img")).toHaveCount(0);

    // The picked card leaves the Deck List: the automatic cover shows again.
    const read = await page.request.get(`${ORIGIN}/api/decks/${built.deckId}`);
    const revision = (await read.json()).deck_list.revision;
    const removed = await page.request.delete(
      `${ORIGIN}/api/decks/${built.deckId}/deck-list/lines/${built.editions.switch}`,
      {
        headers: { origin: ORIGIN },
        data: { revision, idempotency_key: randomUUID() },
      }
    );
    expect(removed.status()).toBe(200);
    await page.unroute(/\/api\/decks(\?.*)?$/);
    await page.reload();
    await expect(tile(page, built.deckName)).toContainText(
      "Basic Grass Energy"
    );
  });

  test("A tile whose first picture request is answered 503 shows a plain surface, then the picture once the route serves it", async ({
    page,
  }) => {
    promoteLegalCatalog();
    await signIn(page);
    await stubCost(page);
    const built = await buildLegalDeck(page, "Tiles");
    await setCover(page, built.deckId, built.editions.switch, null);
    await page.route(/\/api\/decks(\?.*)?$/, async (route) => {
      const response = await route.fetch();
      const json = await response.json();
      for (const deck of json.decks)
        if (deck.id === built.deckId && deck.cover)
          deck.cover.image_url = IMAGE_OK;
      await route.fulfill({ response, json });
    });
    // The route can't serve the picture yet (a busy queue, a fetch in backoff): the first request is a 503, as the API
    // answers it, and the next one is served.
    let asked = 0;
    await page.route(
      /\/api\/art\/00000000-0000-4000-8000-0000000000a1\//,
      (route) => {
        asked += 1;
        return asked === 1
          ? route.fulfill({
              status: 503,
              headers: { "retry-after": "3", "cache-control": "no-store" },
              json: { detail: { code: "ART_UNAVAILABLE", message: "" } },
            })
          : route.fulfill({ contentType: "image/png", body: PIXEL });
      }
    );

    await page.goto(`${ORIGIN}/decks`);
    // The wait before the retry is the plain art surface: no broken image, no name, no status text.
    const picture = tile(page, built.deckName).locator("img");
    await expect(tile(page, built.deckName)).toBeVisible();
    await expect.poll(() => asked).toBe(1);
    await expect(picture).toHaveCount(0);
    await expect(
      tile(page, built.deckName).locator('span[aria-hidden="true"]').first()
    ).toBeVisible();
    await expect(tile(page, built.deckName)).not.toContainText("Switch");
    await expect(tile(page, built.deckName)).not.toContainText("unavailable");
    await expect(picture).toHaveAttribute("src", IMAGE_OK, { timeout: 10_000 });
    await expect(picture).toBeVisible();
    await expect
      .poll(() => picture.evaluate((img: HTMLImageElement) => img.naturalWidth))
      .toBeGreaterThan(0);
    expect(asked).toBe(2);
  });
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true });

  test("On a phone the tiles sit two to a row with a 16 px gutter and no sideways scroll", async ({
    page,
  }) => {
    promoteLegalCatalog();
    await signIn(page);
    await stubCost(page);
    const built = await buildLegalDeck(page, "Tiles");
    await emptyDeck(page);
    await emptyDeck(page);
    // The longest Target Format Pill ("Gym Leader Challenge · ✕ Not legal") truncates inside its tile.
    const read = await page.request.get(`${ORIGIN}/api/decks/${built.deckId}`);
    const target = await page.request.put(
      `${ORIGIN}/api/decks/${built.deckId}/deck-list/target-format`,
      {
        headers: { origin: ORIGIN },
        data: {
          target_format: "glc",
          revision: (await read.json()).deck_list.revision,
          idempotency_key: randomUUID(),
        },
      }
    );
    expect(target.status()).toBe(200);

    await page.goto(`${ORIGIN}/decks`);
    const tiles = deckIndex(page).getByRole("listitem");
    await expect(tiles).toHaveCount(3);
    await expect
      .poll(async () => {
        const [a, b, c] = await Promise.all(
          [0, 1, 2].map((n) => tiles.nth(n).boundingBox())
        );
        return {
          sameRow: Math.round(a!.y) === Math.round(b!.y),
          gutter: Math.round(b!.x - (a!.x + a!.width)),
          wrapped: c!.y >= a!.y + a!.height,
        };
      })
      .toEqual({ sameRow: true, gutter: 16, wrapped: true });

    const mine = tile(page, built.deckName);
    await expectTouchTarget(
      mine.getByRole("link", { name: built.deckName, exact: true })
    );
    await expectPageChecks(page, "Decks index tiles, phone");
    await mine.getByRole("link", { name: built.deckName, exact: true }).tap();
    // A phone opens a Deck that lists cards on its Deck tab, where the Want List button is.
    await page.getByRole("tab", { name: /^Deck / }).tap();
    const wantList = page.getByRole("button", {
      name: "Want List",
      exact: true,
    });
    await expectTouchTarget(wantList);
    await wantList.tap();
    await expect(page).toHaveURL(
      `${ORIGIN}/decks/want-list?deck=${built.deckId}`
    );
  });
});

test("Deck layout stays readable through desktop and phone resizing", async ({
  page,
}) => {
  promoteLegalCatalog();
  await signIn(page);
  await stubCost(page);
  const built = await buildLegalDeck(
    page,
    "A long Deck name for checking compact cards and wrapping"
  );
  const published = await page.request.post(
    `${ORIGIN}/api/decks/${built.deckId}/publication`,
    {
      headers: { origin: ORIGIN },
      data: {
        title:
          "A long published Deck title for checking wrapping and readable publication controls",
        idempotency_key: randomUUID(),
      },
    }
  );
  expect(published.status()).toBe(200);
  const decksMain = page.getByRole("main").filter({
    has: page.getByRole("heading", { name: "Decks", level: 1, exact: true }),
  });
  const widths = [1024, 1280, 1440, 1920, 320, 375, 390];
  for (const count of [1, 6, 22]) {
    for (let n = count === 1 ? 1 : count === 6 ? 1 : 6; n < count; n++)
      await emptyDeck(page);
    await page.goto(`${ORIGIN}/decks`);
    await expect(deckIndex(page).getByRole("listitem")).toHaveCount(count);
    await decksMain
      .getByRole("textbox", { name: "Deck name", exact: true })
      .fill("Unsaved Deck name");
    for (const width of widths) {
      await page.setViewportSize({
        width,
        height: width === 1920 ? 1080 : 900,
      });
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              document.documentElement.scrollWidth <=
              document.documentElement.clientWidth
          )
        )
        .toBe(true);
      await expect(
        decksMain.getByRole("textbox", { name: "Deck name", exact: true })
      ).toHaveValue("Unsaved Deck name");
      await expectTouchTarget(
        tile(page, built.deckName).getByRole("link", {
          name: built.deckName,
          exact: true,
        })
      );
      await expect
        .poll(() =>
          decksMain.evaluate((el) =>
            Math.round(el.getBoundingClientRect().width)
          )
        )
        .toBe(Math.min(width, 1536));
      await expect
        .poll(() =>
          tile(page, built.deckName).evaluate((el) => {
            const art = el.firstElementChild!.getBoundingClientRect();
            const link = el.querySelector("a")!.getBoundingClientRect();
            return {
              artWidth: Math.round(art.width),
              horizontal: link.x > art.x + art.width,
            };
          })
        )
        .toMatchObject(
          width > 760
            ? { artWidth: 64, horizontal: true }
            : { horizontal: false }
        );
    }
  }
  for (const [name, route] of [
    ["want-all", "/decks/want-list"],
    ["want-scoped", `/decks/want-list?deck=${built.deckId}`],
  ]) {
    await page.goto(`${ORIGIN}${route}`);
    await expect(
      decksMain
        .getByRole("region", { name: built.deckName, exact: true })
        .getByRole("paragraph")
        .filter({ hasText: /^Basic Grass Energy$/ })
    ).toBeVisible();
    for (const width of widths) {
      await page.setViewportSize({
        width,
        height: width === 1920 ? 1080 : 900,
      });
      if (width > 760) {
        await expect
          .poll(() =>
            decksMain.evaluate((el) =>
              Math.round(el.getBoundingClientRect().width)
            )
          )
          .toBe(Math.min(width, 1536));
        if (name === "want-all") {
          await expect
            .poll(() =>
              decksMain
                .getByRole("complementary", { name: /^Combined total/ })
                .evaluate((el) => Math.round(el.getBoundingClientRect().width))
            )
            .toBe(352);
        } else {
          await expect
            .poll(() =>
              decksMain
                .getByRole("region", { name: /^Want List/ })
                .locator("..")
                .evaluate((el) => Math.round(el.getBoundingClientRect().width))
            )
            .toBe(Math.min(width - 56, 960));
        }
      }
    }
  }
});
