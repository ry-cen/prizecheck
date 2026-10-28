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
import { artUpstream } from "./support/art-upstream";

const ORIGIN = process.env.TEST_ORIGIN || "http://localhost:5173";
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
    await expect(results(page)).toContainText("Showing 60 of 70 cards");
    // One count only: the results line, not a Printing count in the status line.
    await expect(status(page)).toHaveText("");
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
      "Artwork unavailable",
      { timeout: 15_000 }
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
    await picker.getByRole("button", { name: /^Mega Evolution\s+MEG/ }).click();
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

  test("the set picker groups sets into era folders, newest first, and opens the chosen set's folder", async ({
    page,
  }) => {
    seedGallery();
    await signIn(page);
    const folder = (era: string) =>
      page
        .getByRole("dialog", { name: "Choose a set" })
        .getByRole("button", { name: new RegExp(`^${era} \\d+ sets?$`) });
    const picker = page.getByRole("dialog", { name: "Choose a set" });
    const folderSets = (era: string) =>
      picker.getByRole("list", { name: era, exact: true }).getByRole("button");
    await chip(page, "Any set").click();
    await expect(picker).toBeVisible();

    // Any set leads, outside the folders; the folders run newest era first, the sets with no era last, all closed.
    await expect(
      picker
        .getByRole("list", { name: "Sets", exact: true })
        .getByRole("button")
        .first()
    ).toHaveAccessibleName("Any set");
    await expect(picker.getByRole("button", { expanded: false })).toHaveText([
      /^Mega Evolution\s*2 sets$/,
      /^Scarlet & Violet\s*2 sets$/,
      /^Sword & Shield\s*1 set$/,
      /^Black & White\s*1 set$/,
      /^Other sets\s*1 set$/,
    ]);
    await expect(picker.getByRole("button", { expanded: true })).toHaveCount(0);
    await expect(
      picker.getByRole("button", { name: /^Paldea Evolved/ })
    ).toHaveCount(0);

    // A folder opens and closes, with newest release first inside it; the keyboard works too.
    await folder("Scarlet & Violet").click();
    await expect(folder("Scarlet & Violet")).toHaveAttribute(
      "aria-expanded",
      "true"
    );
    await expect(folderSets("Scarlet & Violet")).toHaveText([
      /^Paldea Evolved/,
      /^Scarlet & Violet/,
    ]);
    await folder("Scarlet & Violet").click();
    await expect(folder("Scarlet & Violet")).toHaveAttribute(
      "aria-expanded",
      "false"
    );
    await folder("Black & White").focus();
    await page.keyboard.press("Enter");
    await expect(folderSets("Black & White")).toHaveText([/^Dragons Exalted/]);

    // A folder opened by hand does not flip the other way once a filter is typed; clearing the filter closes them all.
    await folder("Scarlet & Violet").click();
    const filterBox = picker.getByRole("searchbox", { name: "Filter sets" });
    await filterBox.fill("paldea");
    await expect(folder("Scarlet & Violet")).toHaveAttribute(
      "aria-expanded",
      "true"
    );
    await expect(folderSets("Scarlet & Violet")).toHaveText([
      /^Paldea Evolved/,
    ]);
    await filterBox.fill("");
    await expect(picker.getByRole("button", { expanded: true })).toHaveCount(0);
    await expect(picker.getByRole("button", { expanded: false })).toHaveCount(
      5
    );

    // Typing opens the folders that still have a match and hides the others; a set inside one can be chosen.
    await picker.getByRole("searchbox", { name: "Filter sets" }).fill("delta");
    await expect(picker.getByRole("button", { expanded: false })).toHaveCount(
      0
    );
    await expect(picker.getByRole("button", { expanded: true })).toHaveText([
      /^Mega Evolution\s*1 set$/,
    ]);
    await expect(folderSets("Mega Evolution")).toHaveText([/^Delta Reign/]);
    await folderSets("Mega Evolution").first().click();
    await expect(picker).toBeHidden();
    await expect(chip(page, "Set: Delta Reign")).toBeFocused();

    // Reopened, only the chosen set's folder is open.
    await chip(page, "Set: Delta Reign").click();
    await expect(picker.getByRole("button", { expanded: true })).toHaveText([
      /^Mega Evolution\s*2 sets$/,
    ]);
    await expect(picker.getByRole("button", { expanded: false })).toHaveCount(
      4
    );
    await expect(
      picker.getByRole("button", { name: /^Delta Reign/ })
    ).toHaveAttribute("aria-pressed", "true");
    await picker.getByRole("button", { name: "Close set picker" }).click();
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
    await expect(details).not.toContainText("Artwork belongs to the Printing");
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

  test("a restart that brings back fewer rows puts keyboard focus on the last tile, in this gallery's own list (#196)", async ({
    page,
  }) => {
    seedGallery();
    await signIn(page);
    await expect(tiles(page)).toHaveCount(60);
    // The second page arrives with a cursor that has more to give, so 70 rows are shown and the walk is still open.
    // Every later cursor read answers 409: the walk starts again, and the refill that follows fails, so page one's 60
    // rows are all that come back.
    let cursorReads = 0;
    let release!: () => void;
    const focused = new Promise<void>((resolve) => (release = resolve));
    await page.route(
      (url) => isBrowse(url.href) && url.searchParams.has("cursor"),
      async (route) => {
        cursorReads += 1;
        if (cursorReads > 1) {
          // Held until the keyboard is on the 70th tile, so the read cannot answer before then.
          await focused;
          await route.fulfill({
            status: 409,
            contentType: "application/json",
            body: JSON.stringify({ detail: { code: "CATALOG_CHANGED" } }),
          });
          return;
        }
        const response = await route.fetch();
        const body = (await response.json()) as { next_cursor: string | null };
        await route.fulfill({
          response,
          json: { ...body, next_cursor: "more" },
        });
      }
    );
    await tileButton(page, 59).focus();
    await expect(tiles(page)).toHaveCount(70);
    await tileButton(page, 69).focus();
    release();
    await expect(status(page)).toContainText(
      "Catalog changed. Results refreshed from page one."
    );
    await expect(tiles(page)).toHaveCount(60);
    await expect(tileButton(page, 59)).toBeFocused();
  });

  test("the live region announces the end of the list once, not each page (#196)", async ({
    page,
  }) => {
    seedGallery();
    await signIn(page);
    await expect(tiles(page)).toHaveCount(60);
    const live = results(page).locator('[aria-live="polite"]');
    await expect(live).toHaveText("");

    // A page loading is shown but not announced.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    await page.route(
      (url) => isBrowse(url.href) && url.searchParams.has("cursor"),
      async (route) => {
        await gate;
        await route.continue();
      }
    );
    await tiles(page).last().scrollIntoViewIfNeeded();
    await expect(results(page).getByText("Loading more cards…")).toBeVisible();
    await expect(live).toHaveText("");
    release();
    await expect(tiles(page)).toHaveCount(70);
    await expect(live).toHaveText("All 70 cards shown");
    await expect(live.getByText("Loading more cards…")).toHaveCount(0);
  });

  test("the set picker reads the set list again when it is opened after a while (#196)", async ({
    page,
  }) => {
    await page.clock.install();
    seedGallery();
    await signIn(page);
    let reads = 0;
    await page.route("**/api/catalog/sets", (route) => {
      reads += 1;
      return route.continue();
    });
    const picker = page.getByRole("dialog", { name: "Choose a set" });
    const open = async () => {
      await chip(page, "Any set").click();
      await expect(picker).toBeVisible();
      await expect(picker.getByRole("searchbox")).toBeFocused();
      await expect(picker.getByRole("button").first()).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(picker).toBeHidden();
    };
    await open();
    expect(reads).toBe(1);
    // Reopened at once, the list is fresh and is not read again.
    await open();
    expect(reads).toBe(1);
    // Long after, opening shows the list it has and reads it again.
    await page.clock.fastForward("10:00");
    await chip(page, "Any set").click();
    await expect(picker.getByRole("button").first()).toBeVisible();
    await expect.poll(() => reads).toBe(2);
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
    await expectTouchTarget(
      picker.getByRole("button", { name: /^Mega Evolution \d+ sets?$/ }),
      ["height"]
    );
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
