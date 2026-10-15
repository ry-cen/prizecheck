// Ticket #173: Catalog as an Edition gallery on the browse route (spec "Catalog"). The smart search and its hint with
// printed set codes, the one filter row (format and type chips, the set picker chip, Owned only), a "?" for a card
// whose Format Standing is unknown, EditionTile's printed code, owned badge and darkened artwork, newest set first,
// infinite scroll (its end, Retry after a failed page, a stale cursor starting again from page one), the status line's
// three states, the page keeping its state across a tab switch, the CardPopup a tile opens (#174; its own behaviour is
// in catalog-popup.spec.ts), My metadata reports in the header, and the shared page check at 1280×800 and 375×812 with
// the dialogs open as well as closed. The collector flows that predate the gallery are in catalog-search.spec.ts.
import { test, expect, type Locator, type Page } from "@playwright/test";
import { signInAsOwner } from "./support/sign-in";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { startAsNewOwner } from "./support/owner";
import { expectPageChecks } from "./support/page-check";
import { expectTouchTarget } from "./support/touch-target";

const ORIGIN = process.env.TEST_ORIGIN || "http://localhost:5173";
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=",
  "base64"
);

function python(code: string) {
  execFileSync(".venv/bin/python", ["-c", code], {
    env: { ...process.env, PYTHONPATH: "api:api/tests" },
  });
}
/** 70 Printings (api/tests/test_catalog_browse.py seed_gallery): 9 assorted cards and 61 "Zubat NN". */
const seedGallery = () =>
  python("from test_catalog_browse import seed_gallery\nseed_gallery()");
const emptyCatalog = () =>
  python("from test_catalog import reset_catalog\nreset_catalog()");

async function sql(statement: string, values: unknown[] = []) {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    return (await pool.query(statement, values)).rows;
  } finally {
    await pool.end();
  }
}

/** Signs in at /catalog as a new owner, who owns nothing yet, and lands on Catalog. */
async function signIn(page: Page) {
  await page.route("https://assets.tcgdex.net/**", (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: PIXEL })
  );
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

/** Adds one copy of a card to the signed-in owner's Unsorted through the API. */
async function own(page: Page, sourceId: string) {
  const [{ id: edition }] = await sql(
    "SELECT e.id FROM catalog_edition e JOIN catalog_printing p ON p.id=e.printing_id WHERE p.source_id=$1",
    [sourceId]
  );
  const headers = { origin: ORIGIN };
  const locations = await page.request.get(`${ORIGIN}/api/locations`);
  const unsorted = (
    (await locations.json()) as { locations: { id: string; name: string }[] }
  ).locations.find((location) => location.name === "Unsorted")!;
  const added = await page.request.post(`${ORIGIN}/api/holdings`, {
    headers,
    data: {
      location_id: unsorted.id,
      edition_id: edition,
      quantity: "1",
      idempotency_key: randomUUID(),
    },
  });
  expect(added.status(), await added.text()).toBe(200);
}

const search = (page: Page) =>
  page.getByRole("searchbox", { name: "Search the catalog" });
const results = (page: Page) =>
  page.getByRole("region", { name: "Catalog results" });
const tiles = (page: Page) => results(page).getByRole("listitem");
const tileButton = (page: Page, index: number) =>
  tiles(page).nth(index).getByRole("button");
/** A tile by the start of its accessible name: "Name, Set Number, Variant, …". */
const tile = (page: Page, start: string): Locator =>
  results(page).getByRole("button", {
    name: new RegExp(`^${start.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
  });
const isBrowse = (url: string) =>
  new URL(url).pathname === "/api/catalog/editions";
const filters = (page: Page) => page.getByRole("group", { name: "Filters" });
const chip = (page: Page, name: string) =>
  filters(page).getByRole("button", { name, exact: true });
const status = (page: Page) => page.getByRole("main").getByRole("status");
const mainTab = (page: Page, name: string) =>
  page
    .getByRole("navigation", { name: "Main views" })
    .getByRole("button", { name, exact: true });

test.describe("desktop", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("Catalog is an Edition gallery with a smart search, one filter row and the status line", async ({
    page,
  }) => {
    seedGallery();
    await signIn(page);
    await expect(status(page)).toContainText("70 Printings · last pulled");
    await expect(status(page)).not.toContainText("TCGdex");
    await expect(results(page)).toContainText("Showing 60 of 70 cards");
    await expect(tiles(page)).toHaveCount(60);
    await expect(page.getByRole("complementary")).toHaveCount(0); // no sidebar
    // Newest set first, in collector number order: Mega Evolution leads (dated by the rules files here).
    await expect(tileButton(page, 0)).toHaveAccessibleName(
      /^Bulbasaur, MEG 001,/
    );
    await expect(tileButton(page, 1)).toHaveAccessibleName(
      /^Rare Candy, MEG 125,/
    );
    await expect(tileButton(page, 2)).toHaveAccessibleName(/^Switch, MEG 130,/);
    // An unowned Edition says so, and its artwork is darkened.
    const bulbasaur = tile(page, "Bulbasaur, MEG 001, Mega Evolution, Normal");
    await expect(bulbasaur).toHaveAccessibleName(
      "Bulbasaur, MEG 001, Mega Evolution, Normal, not owned"
    );
    await expect(bulbasaur).toContainText("MEG 001 · Normal");
    await expect
      .poll(() =>
        bulbasaur
          .locator("img")
          .evaluate((image) => getComputedStyle(image).filter)
      )
      .toContain("brightness");
    await expect(tile(page, "Switch, MEG 130")).toContainText(
      "Artwork unavailable"
    );
    await expectPageChecks(page, "Catalog");

    // Infinite scroll: nearing the end of the gallery loads the next page, and the end says so.
    await expect(results(page)).not.toContainText("cards shown");
    await tiles(page).last().scrollIntoViewIfNeeded();
    await expect(tiles(page)).toHaveCount(70);
    await expect(results(page)).toContainText("All 70 cards shown");

    // The page keeps its rows and search across a tab switch.
    await mainTab(page, "Collection").click();
    await expect(page).toHaveURL(/\/collection$/);
    await mainTab(page, "Catalog").click();
    await expect(tiles(page)).toHaveCount(70);

    // Smart search: a known set ID and a number, otherwise the words anywhere in a name (accents and
    // punctuation don't count), or close spellings when no name has them.
    // The hint under the box names the search that ran; it is the box's description.
    await expect(search(page)).toHaveAccessibleDescription(
      "Type a card name, or a set code and number such as PAL 185."
    );
    await search(page).fill("meg 1");
    await expect(search(page)).toHaveAccessibleDescription(
      "Set and number: Mega Evolution (MEG) number 1."
    );
    await expect(tiles(page)).toHaveCount(1);
    await expect(tileButton(page, 0)).toHaveAccessibleName(/^Bulbasaur,/);
    await search(page).fill("zub");
    await expect(search(page)).toHaveAccessibleDescription(
      "Name: cards whose name contains “zub”."
    );
    await expect(results(page)).toContainText("Showing 60 of 61 cards");
    await search(page).fill("ubat");
    await expect(search(page)).toHaveAccessibleDescription(
      "Name: cards whose name contains “ubat”."
    );
    await expect(results(page)).toContainText("Showing 60 of 61 cards");
    await search(page).fill("fixture pokemon");
    await expect(tiles(page)).toHaveCount(1);
    await expect(tileButton(page, 0)).toHaveAccessibleName(/^Fixture Pokémon,/);
    await search(page).fill("zubta");
    await expect(search(page)).toHaveAccessibleDescription(
      "No exact matches. Showing close spellings of “zubta”."
    );
    await expect(results(page)).toContainText("Showing 60 of 61 cards");
    await search(page).fill("nothing like this");
    await expect(results(page)).toContainText("No cards match this search.");
    await search(page).fill("");
    await expect(results(page)).toContainText("Showing 60 of 70 cards");

    // A format chip hides only cards that aren't legal; an unknown card stays, with a "?".
    await chip(page, "Standard").click();
    await expect(chip(page, "Standard")).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    await expect(chip(page, "Any format")).toHaveAttribute(
      "aria-pressed",
      "false"
    );
    await search(page).fill("fixture p");
    const unknown = tile(page, "Fixture Pokémon, me06 3");
    await expect(unknown).toHaveAccessibleName(/Standard legality unknown$/);
    await expect(unknown).toContainText("?");
    await expectPageChecks(page, "Catalog, Standard, an unknown card");
    await search(page).fill("giratina");
    await expect(results(page)).toContainText("No cards match this search.");
    await chip(page, "Any format").click();
    await expect(tiles(page)).toHaveCount(1);
    await expect(tiles(page).getByText("?", { exact: true })).toHaveCount(0);

    // Type chips; a Trainer with no Trainer Type (Switch) matches none of them.
    await search(page).fill("");
    await chip(page, "Item").click();
    await expect(tiles(page)).toHaveCount(3);
    await expect(tile(page, "Switch,")).toHaveCount(0);
    await chip(page, "Item").click();
    await expect(chip(page, "Item")).toHaveAttribute("aria-pressed", "false");

    // The set picker, styled as a chip, lists the catalog's sets.
    await chip(page, "Any set").click();
    const picker = page.getByRole("dialog", { name: "Choose a set" });
    await expect(picker).toBeVisible();
    await expect(
      picker.getByRole("searchbox", { name: "Filter sets" })
    ).toBeFocused();
    await expectPageChecks(page, "Catalog, set picker open");
    await picker.getByRole("searchbox", { name: "Filter sets" }).fill("mega");
    await picker.getByRole("button", { name: /^Mega Evolution/ }).click();
    await expect(picker).toBeHidden();
    await expect(chip(page, "Set: Mega Evolution")).toBeFocused();
    // Collector number order within a set.
    await expect(tiles(page)).toHaveCount(3);
    await expect(tileButton(page, 0)).toHaveAccessibleName(/^Bulbasaur,/);
    await expect(tileButton(page, 1)).toHaveAccessibleName(/^Rare Candy,/);
    await expect(tileButton(page, 2)).toHaveAccessibleName(/^Switch,/);

    // Owned only, and the owned badge.
    await chip(page, "Owned only").click();
    await expect(results(page)).toContainText("No cards match this search.");
    await own(page, "me01-130");
    await chip(page, "Owned only").click();
    await chip(page, "Owned only").click();
    await expect(tiles(page)).toHaveCount(1);
    await expect(tile(page, "Switch, MEG 130")).toHaveAccessibleName(
      "Switch, MEG 130, Mega Evolution, Normal, 1 owned"
    );
    await expect(tile(page, "Switch, MEG 130")).toContainText("×1");
  });

  test("a tile opens the card popup, a stale page starts again from page one, and a failed page offers Retry", async ({
    page,
  }) => {
    seedGallery();
    await signIn(page);
    const bulbasaur = tile(page, "Bulbasaur, MEG 001");
    await bulbasaur.click();
    // The CardPopup (#174) replaced the interim details dialog.
    const details = page.getByRole("dialog", { name: "Bulbasaur" });
    await expect(details).toContainText("Mega Evolution (MEG) · #001");
    await expect(details).toContainText("Regulation mark I");
    // The Card Identity shows only when it differs from the name.
    await expect(details).not.toContainText("Card Identity");
    await expect(details).toContainText(
      "Artwork belongs to the Printing and does not prove an Edition finish."
    );
    await expect(
      details.getByRole("button", { name: "Report this Edition" })
    ).toHaveCount(1);
    await expectPageChecks(page, "Catalog, card popup open");
    await page.keyboard.press("Escape");
    await expect(details).toBeHidden();
    await expect(bulbasaur).toBeFocused();
    // My metadata reports opens from the page header: nothing sits below an endless gallery.
    const reports = page.getByRole("button", { name: "My metadata reports" });
    await reports.click();
    await expect(
      page
        .getByRole("dialog", { name: "My metadata reports" })
        .getByRole("region", { name: "My metadata reports" })
    ).toBeVisible();
    await expectPageChecks(page, "Catalog, my metadata reports open");
    await page.keyboard.press("Escape");
    await expect(reports).toBeFocused();

    // "changed, refreshed": the catalog moved under an open walk, so the next page's 409 starts again from page one.
    await sql("UPDATE catalog_state SET revision=revision+1");
    const restart = page.waitForRequest(
      (request) =>
        isBrowse(request.url()) &&
        !new URL(request.url()).searchParams.has("cursor")
    );
    await tiles(page).last().scrollIntoViewIfNeeded();
    await restart;
    await expect(status(page)).toContainText(
      "Catalog changed. Results refreshed from page one."
    );
    await expect(tiles(page)).toHaveCount(70);

    // A failed page shows Retry at the end of the gallery and loads nothing more until it is pressed. Focus reaching
    // the last tile (the keyboard path) asks for the next page, and loading never moves focus.
    await page.reload();
    await expect(tiles(page)).toHaveCount(60);
    let failing = true;
    await page.route(
      (url) => isBrowse(url.href) && url.searchParams.has("cursor"),
      (route) =>
        failing
          ? route.fulfill({
              status: 500,
              contentType: "application/json",
              body: "{}",
            })
          : route.continue()
    );
    await tileButton(page, 59).focus();
    const failure = results(page).getByRole("alert");
    await expect(failure).toContainText(
      "Catalog search is temporarily unavailable. Please retry."
    );
    await expect(tileButton(page, 59)).toBeFocused();
    await expect(tiles(page)).toHaveCount(60);
    failing = false;
    await failure.getByRole("button", { name: "Retry" }).click();
    await expect(tiles(page)).toHaveCount(70);
    await expect(results(page)).toContainText("All 70 cards shown");
    await expect(failure).toHaveCount(0);
  });

  test("before the first import the status line says the catalog is unavailable", async ({
    page,
  }) => {
    emptyCatalog();
    await signIn(page);
    await expect(status(page)).toHaveText(
      "Catalog unavailable until the first complete import."
    );
    await expect(results(page)).toHaveCount(0);
    await expectPageChecks(page, "Catalog, unavailable");
  });
});

test.describe("phone", () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true });

  test("on a phone the gallery, the filter row, the set picker and the card popup pass the page check", async ({
    page,
  }) => {
    seedGallery();
    await signIn(page);
    await expect(tiles(page)).toHaveCount(60);
    await expectTouchTarget(search(page), ["height"]);
    await expectPageChecks(page, "Catalog on a phone");
    // The filter row scrolls inside itself: its last chip starts out of view and the page never scrolls sideways.
    const row = filters(page);
    await expect
      .poll(() =>
        row.evaluate((element) => element.scrollWidth > element.clientWidth)
      )
      .toBe(true);
    await chip(page, "Owned only").scrollIntoViewIfNeeded();
    await expectTouchTarget(chip(page, "Owned only"));
    await chip(page, "Any set").tap();
    const picker = page.getByRole("dialog", { name: "Choose a set" });
    await expect(picker).toBeVisible();
    await expectPageChecks(page, "Catalog on a phone, set picker open");
    await picker.getByRole("button", { name: "Close set picker" }).tap();
    await expect(picker).toBeHidden();
    await tile(page, "Bulbasaur, MEG 001").tap();
    const details = page.getByRole("dialog", { name: "Bulbasaur" });
    await expect(details).toContainText("Regulation mark I");
    await expectPageChecks(page, "Catalog on a phone, card popup open");
    await details.getByRole("button", { name: "Close card details" }).tap();
    await page.getByRole("button", { name: "My metadata reports" }).tap();
    await expect(
      page.getByRole("dialog", { name: "My metadata reports" })
    ).toBeVisible();
    await expectPageChecks(
      page,
      "Catalog on a phone, my metadata reports open"
    );
  });
});
