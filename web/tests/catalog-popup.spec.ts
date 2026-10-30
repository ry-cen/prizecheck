// Ticket #174: Catalog's CardPopup (spec "Catalog": CardPopup (Browse)). The popup's facts (art and its note, set and
// number, regulation mark, the Card Identity only when it differs from the name, the source, a legality Pill per
// Format), the Edition picker with copies owned and the Unavailable badge, where your copies are, "‹ N / M ›" with
// ‹ › and ← → stepping (into the next page, and through a quiet restart after the collector's own Add), the Add rows
// (Add N puts copies in a Location; there is no Deck List row), the report footer, and the
// shared page check at 1280×800 and 375×812 with the popup open, including the phone's bottom sheet. The gallery
// itself is in catalog-gallery.spec.ts.
import { expect, type Locator, type Page } from "@playwright/test";
import { signInAsOwner } from "./support/sign-in";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { startAsNewOwner } from "./support/owner";
import { expectPageChecks } from "./support/page-check";
import { expectTouchTarget } from "./support/touch-target";
import { test, artUpstream } from "./support/art-upstream";

const ORIGIN = process.env.TEST_ORIGIN || "http://localhost:5173";
function python(code: string) {
  execFileSync(".venv/bin/python", ["-c", code], {
    env: { ...process.env, PYTHONPATH: "api:api/tests" },
  });
}
/** Five tiles (api/tests/test_catalog_browse.py seed_popup): Bulbasaur Normal and Reverse Holo (its Holo is retired),
 * Rare Candy and Switch in Mega Evolution, then Professor's Research (Professor Juniper) in Shining Fates. */
const seedPopup = () =>
  python("from test_catalog_browse import seed_popup\nseed_popup()");
/** 70 Printings, newest set first (seed_gallery): enough for a second page. */
const seedGallery = () =>
  python("from test_catalog_browse import seed_gallery\nseed_gallery()");

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

/** The id of a card's Edition with this finish. */
async function edition(sourceId: string, finish = "normal") {
  const [{ id }] = await sql(
    `SELECT e.id FROM catalog_edition e JOIN catalog_printing p ON p.id=e.printing_id
     WHERE p.source_id=$1 AND e.descriptor->>'finish'=$2`,
    [sourceId, finish]
  );
  return id as string;
}

/** The signed-in owner's Unsorted Storage Leaf. */
async function unsorted(page: Page): Promise<string> {
  const response = await page.request.get(`${ORIGIN}/api/locations`);
  const { locations } = (await response.json()) as {
    locations: { id: string; name: string }[];
  };
  return locations.find((location) => location.name === "Unsorted")!.id;
}

/** Adds copies of one Edition to the owner's Unsorted through the API. */
async function own(page: Page, editionId: string, quantity: number) {
  const added = await page.request.post(`${ORIGIN}/api/holdings`, {
    headers: { origin: ORIGIN },
    data: {
      location_id: await unsorted(page),
      edition_id: editionId,
      quantity: String(quantity),
      idempotency_key: randomUUID(),
    },
  });
  expect(added.status(), await added.text()).toBe(200);
}

const results = (page: Page) =>
  page.getByRole("region", { name: "Catalog results" });
const tiles = (page: Page) => results(page).getByRole("listitem");
const tileButton = (page: Page, index: number) =>
  tiles(page).nth(index).getByRole("button");
/** A tile by the start of its accessible name: "Name, Set Number, Set name, Variant, …". */
const tile = (page: Page, start: string): Locator =>
  results(page).getByRole("button", {
    name: new RegExp(`^${start.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
  });
const status = (page: Page) => page.getByRole("main").getByRole("status");
/** A browse request that starts a walk (no cursor), not the popup's read of one Printing. */
const isWalkStart = (url: string) => {
  const parsed = new URL(url);
  return (
    parsed.pathname === "/api/catalog/editions" &&
    !parsed.searchParams.has("cursor") &&
    !parsed.searchParams.has("printing_id")
  );
};
const popup = (page: Page) => page.getByRole("dialog");
const position = (page: Page) =>
  popup(page).getByRole("group", { name: "Step through the results" });
const editions = (page: Page) =>
  popup(page).getByRole("group", { name: "Editions" }).getByRole("button");
const addRow = (page: Page) =>
  popup(page).getByRole("group", { name: "Add to Collection" });

test.describe("desktop", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("the card popup answers everything about a card, steps through the results and opens the report flows", async ({
    page,
  }) => {
    seedPopup();
    await signIn(page);
    await own(page, await edition("me01-001", "reverse"), 2);
    await page.reload();
    await expect(tiles(page)).toHaveCount(5);
    const bulbasaur = tile(page, "Bulbasaur, MEG 001, Mega Evolution, Normal");
    await bulbasaur.click();
    const card = page.getByRole("dialog", { name: "Bulbasaur" });
    await expect(position(page)).toContainText("1 / 5");
    await expect(
      position(page).getByRole("button", { name: "Previous card" })
    ).toBeDisabled();

    // The facts.
    await expect(
      card.getByRole("img", { name: "Bulbasaur card art" })
    ).toBeVisible();
    await expect(card).not.toContainText("Artwork belongs to the Printing");
    await expect(card).toContainText("Mega Evolution (MEG) · #001");
    await expect(card).toContainText("Regulation mark I");
    await expect(card).not.toContainText("Card Identity");
    // The third-party catalog source is not named.
    await expect(card).not.toContainText("TCGdex");
    await expect(card).not.toContainText("me01-001");
    await expect(
      card.getByRole("list", { name: "Legality" }).getByRole("listitem")
    ).toHaveText(["Standard: Legal", "Expanded: Legal", "GLC: Legal"]);

    // The Editions: each with its Variant, copies owned and price; the retired Holo comes last, Unavailable, with no
    // price (and no tile).
    await expect(editions(page)).toHaveText([
      /^Normal\s*Not owned/,
      /^Reverse Holo\s*2 owned/,
      /^Holo\s*Not owned.*Unavailable$/,
    ]);
    await expect(editions(page).first()).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    await expect(card).toContainText("You don't own this Edition yet.");
    await editions(page).nth(1).click();
    await expect(editions(page).nth(1)).toHaveAttribute("aria-pressed", "true");
    await expect(card).toContainText("2 copies owned");
    await expect(
      card.getByRole("list", { name: "Copies by location" })
    ).toHaveText(["2 in Unsorted"]);
    await editions(page).nth(2).click();
    await expect(card).toContainText(
      "This Edition is unavailable, so it can't be added."
    );
    await expect(
      addRow(page).getByRole("button", { name: "Add 1" })
    ).toBeDisabled();
    await expectPageChecks(page, "Catalog, card popup open");

    // ← → step through the tiles while focus isn't in a control that uses the arrows; › and ‹ do the same.
    await page.keyboard.press("ArrowRight");
    await expect(position(page)).toContainText("2 / 5");
    await expect(editions(page).nth(1)).toHaveAttribute("aria-pressed", "true");
    await position(page).getByRole("button", { name: "Next card" }).click();
    await expect(position(page)).toContainText("3 / 5");
    await expect(
      page.getByRole("dialog", { name: "Rare Candy" })
    ).toBeVisible();
    await page.keyboard.press("ArrowLeft");
    await expect(position(page)).toContainText("2 / 5");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect(position(page)).toContainText("5 / 5");
    const research = page.getByRole("dialog", {
      name: "Professor's Research (Professor Juniper)",
    });
    // The Card Identity shows when it differs from the name.
    await expect(research).toContainText("Card Identity: Professor's Research");
    await expect(
      position(page).getByRole("button", { name: "Next card" })
    ).toBeDisabled();
    // An arrow inside a select belongs to the select.
    await addRow(page).getByRole("combobox", { name: "Location" }).focus();
    await page.keyboard.press("ArrowLeft");
    await expect(position(page)).toContainText("5 / 5");

    // The footer opens today's report flows, one at a time, each taking focus.
    const footerEdition = research.getByRole("button", {
      name: "Report this Edition",
    });
    await footerEdition.click();
    await expect(footerEdition).toHaveAttribute("aria-expanded", "true");
    const report = research.getByRole("region", {
      name: "Report card metadata",
    });
    await expect(report).toBeVisible();
    await expect(
      report
        .locator("label", { hasText: "What needs fixing" })
        .locator("select")
    ).toBeFocused();
    await expectPageChecks(page, "Catalog, card popup with a report open");
    await research
      .getByRole("button", { name: "Report a missing Edition" })
      .click();
    await expect(report).toHaveCount(0);
    await expect(
      research.getByRole("region", { name: "Missing-card reports" })
    ).toBeVisible();
    await expectPageChecks(
      page,
      "Catalog, card popup with the missing-Edition report open"
    );
    await research
      .getByRole("button", { name: "Report Printing metadata" })
      .click();
    await expect(
      research.getByRole("button", { name: "Report Printing metadata" })
    ).toHaveAttribute("aria-expanded", "true");
    await expect(report).toBeVisible();

    // Closing after stepping returns focus to the tile of the card shown.
    await page.keyboard.press("Escape");
    await expect(popup(page)).toHaveCount(0);
    await expect(
      tile(page, "Professor's Research (Professor Juniper),")
    ).toBeFocused();
  });

  test("Add N puts copies in a Location, and the popup offers no Deck List row even when a Deck exists", async ({
    page,
  }) => {
    seedPopup();
    await signIn(page);
    const created = await page.request.post(`${ORIGIN}/api/decks`, {
      headers: { origin: ORIGIN },
      data: { name: "Popup deck", idempotency_key: randomUUID() },
    });
    expect(created.status()).toBe(201);
    await page.reload();

    await tile(page, "Switch, MEG 130").click();
    const card = page.getByRole("dialog", { name: "Switch" });
    await expect(
      addRow(page).getByRole("combobox", { name: "Location" })
    ).toHaveValue(await unsorted(page));
    const more = addRow(page).getByRole("button", {
      name: "Increase Copies to add",
    });
    await more.click();
    await more.click();
    await addRow(page).getByRole("button", { name: "Add 3" }).click();
    await expect(card.getByText("Added 3 copies to Unsorted.")).toBeVisible();
    await expect(card).toContainText("3 copies owned");
    await expect(editions(page).first()).toContainText("3 owned");
    await expect(
      addRow(page).getByRole("button", { name: "Add 1" })
    ).toBeVisible();

    // Planning a Deck List copy happens in the deck builder, not here.
    await expect(
      popup(page).getByRole("group", { name: "Plan in a Deck List" })
    ).toHaveCount(0);
    await expect(card.getByRole("button", { name: "Plan 1" })).toHaveCount(0);

    // The tile behind shows the new count at once.
    await page.keyboard.press("Escape");
    await expect(tile(page, "Switch, MEG 130")).toHaveAccessibleName(
      "Switch, MEG 130, Mega Evolution, Normal, 3 owned"
    );
  });

  test("picking another Edition keeps the typed report and the Add count, and the report follows the pick (#174)", async ({
    page,
  }) => {
    seedPopup();
    await signIn(page);
    await tile(page, "Bulbasaur, MEG 001, Mega Evolution, Normal").click();
    const card = page.getByRole("dialog", { name: "Bulbasaur" });
    await expect(editions(page)).toHaveCount(3);
    await card.getByRole("button", { name: "Report this Edition" }).click();
    const report = card.getByRole("region", { name: "Report card metadata" });
    const note = report.getByLabel("Note");
    const reported = report.getByLabel("Card Edition");
    await expect(reported.locator("option:checked")).toHaveText("Normal");
    await note.fill("The price match looks wrong");
    await addRow(page)
      .getByRole("button", { name: "Increase Copies to add" })
      .click();
    await expect(
      addRow(page).getByRole("button", { name: "Add 2" })
    ).toBeVisible();

    await editions(page).nth(1).click();
    await expect(editions(page).nth(1)).toHaveAttribute("aria-pressed", "true");
    await expect(note).toHaveValue("The price match looks wrong");
    await expect(reported.locator("option:checked")).toHaveText("Reverse Holo");
    await expect(
      addRow(page).getByRole("button", { name: "Add 2" })
    ).toBeVisible();
  });

  test("stepping reaches the next page, and the collector's own Add restarts the walk quietly in place", async ({
    page,
  }) => {
    seedGallery();
    await signIn(page);
    await expect(tiles(page)).toHaveCount(60);
    // An Add from the popup moves the owner revision, so the walk's next page answers 409.
    await tileButton(page, 0).click();
    await addRow(page).getByRole("button", { name: "Add 1" }).click();
    await expect(
      popup(page).getByText(/^Added 1 copy to Unsorted\./)
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(tileButton(page, 0)).toHaveAccessibleName(/1 owned$/);

    // Opening a tile near the end asks for the next page ahead of the steps. Its 409 starts the walk again from page
    // one, as deep as it was, with no "Your collection changed" notice, and the popup keeps its place.
    const restart = page.waitForRequest((request) =>
      isWalkStart(request.url())
    );
    await tileButton(page, 57).click();
    await expect(position(page)).toContainText("58 / 70");
    await restart;
    await expect(tiles(page)).toHaveCount(70);
    await expect(position(page)).toContainText("58 / 70");
    await expect(tileButton(page, 0)).toHaveAccessibleName(/1 owned$/);
    const next = position(page).getByRole("button", { name: "Next card" });
    await next.click();
    await next.click();
    await next.click();
    await expect(position(page)).toContainText("61 / 70");
    await page.keyboard.press("Escape");
    await expect(tileButton(page, 60)).toBeFocused();
    // The restart was the collector's own doing, so the status line says nothing about it.
    await expect(status(page)).not.toContainText("collection changed");
  });

  test("a card opened from a report link still shows its facts and report footer when the browse read fails", async ({
    page,
  }) => {
    seedPopup();
    await signIn(page);
    const normal = await edition("me01-001");
    const [{ printing_id: printing }] = await sql(
      "SELECT printing_id FROM catalog_edition WHERE id=$1",
      [normal]
    );
    // Only the popup's read of one Printing fails (a standings rebuild, a 503); the gallery behind it still loads.
    await page.route(
      (url) =>
        url.pathname === "/api/catalog/editions" &&
        url.searchParams.has("printing_id"),
      (route) =>
        route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ code: "CATALOG_UNAVAILABLE" }),
        })
    );
    await page.goto(`${ORIGIN}/catalog?printing=${printing}&edition=${normal}`);
    await expect(popup(page)).toBeVisible();
    await expect(popup(page)).toContainText("Mega Evolution (me01) · #001");
    await expect(popup(page)).toContainText("Regulation mark unavailable");
    await expect(popup(page)).toContainText("Legality unavailable");
    await expect(popup(page)).not.toContainText("Card details are unavailable");
    await expect(editions(page).first()).toContainText("Copies owned unknown");
    await expect(
      popup(page).getByRole("button", { name: "Report a missing Edition" })
    ).toBeVisible();
    // The report link's form is open under the footer, and picking another Edition moves it there.
    await expect(
      popup(page).getByRole("button", { name: "Report this Edition" })
    ).toHaveAttribute("aria-expanded", "true");
    await expect(
      popup(page)
        .locator("label", { hasText: "What needs fixing" })
        .locator("select")
    ).toBeFocused();
  });
});

test.describe("phone", () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true });

  test("on a phone the card popup is a bottom sheet that passes the page check", async ({
    page,
  }) => {
    seedPopup();
    await signIn(page);
    await tile(page, "Bulbasaur, MEG 001, Mega Evolution, Normal").tap();
    const card = page.getByRole("dialog", { name: "Bulbasaur" });
    await expect(card).toContainText("Regulation mark I");
    // A bottom sheet: the full width, resting on the bottom edge.
    await expect
      .poll(() =>
        card.evaluate((element) => {
          const box = element.getBoundingClientRect();
          return [
            Math.round(box.left),
            Math.round(box.width),
            Math.round(box.bottom),
          ];
        })
      )
      .toEqual([0, 375, 812]);
    await expectPageChecks(page, "Catalog on a phone, card popup open");
    await expectTouchTarget(
      position(page).getByRole("button", { name: "Next card" })
    );
    await expectTouchTarget(
      addRow(page).getByRole("button", { name: "Add 1" })
    );
    await expectTouchTarget(
      card.getByRole("button", { name: "Report this Edition" }),
      ["height"]
    );
    // The report forms open inside the sheet, and pass the page check there too.
    await card.getByRole("button", { name: "Report this Edition" }).tap();
    await expect(
      card.getByRole("region", { name: "Report card metadata" })
    ).toBeVisible();
    await expectPageChecks(
      page,
      "Catalog on a phone, card popup with a report open"
    );
    await card.getByRole("button", { name: "Report a missing Edition" }).tap();
    await expect(
      card.getByRole("region", { name: "Missing-card reports" })
    ).toBeVisible();
    await expectPageChecks(
      page,
      "Catalog on a phone, card popup with the missing-Edition report open"
    );
    await position(page).getByRole("button", { name: "Next card" }).tap();
    await expect(position(page)).toContainText("2 / 5");
    await card.getByRole("button", { name: "Close card details" }).tap();
    await expect(popup(page)).toHaveCount(0);
  });
});
