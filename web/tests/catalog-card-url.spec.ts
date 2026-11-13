// An open Catalog card lives in the address (S14c): opening pushes `card` and `edition`, a reload or a shared link
// reopens it, Back closes it and Forward reopens it, and picking an Edition or stepping replaces. Closing a card the
// collector opened goes back once; closing one entered directly replaces the address. Collection's Add cards writes
// nothing. Everything holds at 1280×800 and at 375×812 with touch, where the dialog is the bottom sheet.
import { expect, type Locator, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { signInAsOwner } from "./support/sign-in";
import { startAsNewOwner } from "./support/owner";
import { test, artUpstream } from "./support/art-upstream";

const ORIGIN = process.env.TEST_ORIGIN || "http://localhost:5173";
function python(code: string) {
  execFileSync(".venv/bin/python", ["-c", code], {
    env: { ...process.env, PYTHONPATH: "api:api/tests" },
  });
}
/** Bulbasaur Normal and Reverse Holo (three Editions, the Holo retired), Rare Candy, Switch, Professor's Research. */
const seedPopup = () =>
  python("from test_catalog_browse import seed_popup\nseed_popup()");
/** 70 Printings: enough for a scrolling gallery. */
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
async function signIn(page: Page) {
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
/** A card's Printing id and the id of its Edition with this finish. */
async function ids(sourceId: string, finish = "normal") {
  const [row] = await sql(
    `SELECT p.id AS printing, e.id AS edition FROM catalog_edition e JOIN catalog_printing p ON p.id=e.printing_id
     WHERE p.source_id=$1 AND e.descriptor->>'finish'=$2`,
    [sourceId, finish]
  );
  return { printing: row.printing as string, edition: row.edition as string };
}
const BULBASAUR = "me01-001";
const results = (page: Page) =>
  page.getByRole("region", { name: "Catalog results" });
const tile = (page: Page, start: string): Locator =>
  results(page).getByRole("button", { name: new RegExp(`^${start}`) });
const NORMAL = "Bulbasaur, MEG 001, Mega Evolution, Normal";
const REVERSE = "Bulbasaur, MEG 001, Mega Evolution, Reverse Holo";
const popup = (page: Page) => page.getByRole("dialog", { name: "Bulbasaur" });
const editions = (page: Page) =>
  page
    .getByRole("dialog")
    .getByRole("group", { name: "Editions" })
    .getByRole("button");
const here = (page: Page) => {
  const url = new URL(page.url());
  return url.pathname + url.search;
};
const historyLength = (page: Page) => page.evaluate(() => history.length);
/** Counts the popstate events this document sees, so a double Back shows. */
const countPops = (page: Page) =>
  page.addInitScript(() => {
    (window as unknown as { pops: number }).pops = 0;
    window.addEventListener("popstate", () => {
      (window as unknown as { pops: number }).pops += 1;
    });
  });
const pops = (page: Page) =>
  page.evaluate(() => (window as unknown as { pops: number }).pops);

for (const viewport of [
  { width: 1280, height: 800 },
  { width: 375, height: 812 },
]) {
  test.describe(`${viewport.width}×${viewport.height}`, () => {
    test.use({ viewport, hasTouch: viewport.width === 375 });
    const press = (locator: Locator) =>
      viewport.width === 375 ? locator.tap() : locator.click();

    test("open writes card and edition, and a reload or a shared link reopens it", async ({
      page,
      context,
    }) => {
      seedPopup();
      await signIn(page);
      const reverse = await ids(BULBASAUR, "reverse");
      await page.goto(`${ORIGIN}/catalog?q=Bulbasaur&format=standard`);
      await expect(tile(page, REVERSE)).toBeVisible();
      const before = await historyLength(page);
      await press(tile(page, REVERSE));
      await expect(popup(page)).toBeVisible();
      const address = `/catalog?q=Bulbasaur&format=standard&card=${reverse.printing}&edition=${reverse.edition}`;
      expect(here(page)).toBe(address);
      expect(await historyLength(page)).toBe(before + 1);

      await page.reload();
      await expect(popup(page)).toBeVisible();
      await expect(editions(page).nth(1)).toHaveAttribute(
        "aria-pressed",
        "true"
      );
      expect(here(page)).toBe(address);

      const shared = await context.newPage();
      await shared.setViewportSize(viewport);
      await shared.goto(`${ORIGIN}${address}`);
      await expect(popup(shared)).toBeVisible();
      await expect(editions(shared).nth(1)).toHaveAttribute(
        "aria-pressed",
        "true"
      );
    });

    test("Back closes the card, keeps the results' scroll and focus, Forward reopens it, and a second Back leaves", async ({
      page,
    }) => {
      seedGallery();
      await signIn(page);
      await page.goto(`${ORIGIN}/collection`);
      await page.goto(`${ORIGIN}/catalog`);
      const items = results(page).getByRole("listitem");
      await expect(items).toHaveCount(60);
      const target = items.nth(30).getByRole("button");
      await target.scrollIntoViewIfNeeded();
      const scroll = await page.evaluate(() => window.scrollY);
      expect(scroll).toBeGreaterThan(0);
      const catalog = here(page);
      await press(target);
      const card = page.getByRole("dialog");
      await expect(card).toBeVisible();
      expect(here(page)).not.toBe(catalog);

      await page.goBack();
      await expect(card).toHaveCount(0);
      expect(here(page)).toBe(catalog);
      expect(await page.evaluate(() => window.scrollY)).toBe(scroll);
      await expect(target).toBeFocused();

      await page.goForward();
      await expect(card).toBeVisible();
      expect(here(page)).not.toBe(catalog);
      await page.goBack();
      await expect(card).toHaveCount(0);
      await page.goBack();
      await expect(page).toHaveURL(/\/collection$/);
    });

    test("picking an Edition and stepping replace the address", async ({
      page,
    }) => {
      seedPopup();
      await signIn(page);
      const normal = await ids(BULBASAUR);
      const reverse = await ids(BULBASAUR, "reverse");
      await page.goto(`${ORIGIN}/catalog`);
      await press(tile(page, NORMAL));
      await expect(popup(page)).toBeVisible();
      const card = page.getByRole("dialog");
      await card.getByRole("button", { name: "Report this Edition" }).click();
      const note = card
        .getByRole("region", { name: "Report card metadata" })
        .getByLabel("Note");
      await note.fill("The price match looks wrong");
      const length = await historyLength(page);

      await press(editions(page).nth(1));
      await expect(editions(page).nth(1)).toHaveAttribute(
        "aria-pressed",
        "true"
      );
      await expect
        .poll(() => here(page))
        .toContain(`card=${normal.printing}&edition=${reverse.edition}`);
      expect(await historyLength(page)).toBe(length);
      await expect(note).toHaveValue("The price match looks wrong");

      // The picked Reverse Holo is also the next tile, so › moves on to it, then to Rare Candy.
      const next = card.getByRole("button", { name: "Next card" });
      await press(next);
      await expect(editions(page).nth(1)).toHaveAttribute(
        "aria-pressed",
        "true"
      );
      await press(next);
      await expect(
        page.getByRole("dialog", { name: "Rare Candy" })
      ).toBeVisible();
      expect(here(page)).not.toContain(normal.printing);
      expect(here(page)).toContain("card=");
      expect(await historyLength(page)).toBe(length);
    });

    test("closing a pushed card goes back once; closing a direct card replaces", async ({
      page,
    }) => {
      seedPopup();
      await countPops(page);
      await signIn(page);
      const normal = await ids(BULBASAUR);
      await page.goto(`${ORIGIN}/collection`);
      await page.goto(`${ORIGIN}/catalog?q=Bulbasaur`);
      await press(tile(page, NORMAL));
      await expect(popup(page)).toBeVisible();
      const popsBefore = await pops(page);
      // A double close: the button, then Escape, before the address moves.
      await page.getByRole("button", { name: "Close card details" }).click();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      expect(here(page)).toBe("/catalog?q=Bulbasaur");
      expect((await pops(page)) - popsBefore).toBe(1);

      await page.goto(
        `${ORIGIN}/catalog?q=Bulbasaur&card=${normal.printing}&edition=${normal.edition}`
      );
      await expect(popup(page)).toBeVisible();
      const length = await historyLength(page);
      const direct = await pops(page);
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      expect(here(page)).toBe("/catalog?q=Bulbasaur");
      expect(await historyLength(page)).toBe(length);
      expect(await pops(page)).toBe(direct);
    });

    test("malformed and stale card links are cleaned up", async ({ page }) => {
      seedPopup();
      await signIn(page);
      const normal = await ids(BULBASAUR);
      const reverse = await ids(BULBASAUR, "reverse");
      const open = (query: string) => page.goto(`${ORIGIN}/catalog?${query}`);

      await open(`q=Bulbasaur&card=abc&edition=${normal.edition}`);
      await expect(tile(page, NORMAL)).toBeVisible();
      await expect.poll(() => here(page)).toBe("/catalog?q=Bulbasaur");
      await expect(page.getByRole("dialog")).toHaveCount(0);

      await open(`q=Bulbasaur&edition=${normal.edition}`);
      await expect.poll(() => here(page)).toBe("/catalog?q=Bulbasaur");
      await expect(page.getByRole("dialog")).toHaveCount(0);

      // A bad Edition with a valid card: the card opens on its default Edition.
      await open(`q=Bulbasaur&card=${normal.printing}&edition=nope`);
      await expect(popup(page)).toBeVisible();
      await expect(editions(page).first()).toHaveAttribute(
        "aria-pressed",
        "true"
      );
      await expect
        .poll(() => here(page))
        .toBe(
          `/catalog?q=Bulbasaur&card=${normal.printing}&edition=${normal.edition}`
        );

      // A card with no Edition ends on its default Edition's address.
      await open(`q=Bulbasaur&card=${reverse.printing}`);
      await expect(popup(page)).toBeVisible();
      await expect
        .poll(() => here(page))
        .toBe(
          `/catalog?q=Bulbasaur&card=${reverse.printing}&edition=${normal.edition}`
        );

      // A well-formed Edition the Printing doesn't have.
      await open(`q=Bulbasaur&card=${normal.printing}&edition=${randomUUID()}`);
      await expect(popup(page)).toBeVisible();
      await expect
        .poll(() => here(page))
        .toBe(
          `/catalog?q=Bulbasaur&card=${normal.printing}&edition=${normal.edition}`
        );

      // A well-formed card nobody has.
      await open(`q=Bulbasaur&card=${randomUUID()}`);
      await expect(
        page
          .getByRole("dialog")
          .getByText("Card details are unavailable. Please retry.")
      ).toBeVisible();
      const length = await historyLength(page);
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      expect(here(page)).toBe("/catalog?q=Bulbasaur");
      expect(await historyLength(page)).toBe(length);
    });

    test("the report link opens the report and becomes a card address", async ({
      page,
    }) => {
      seedPopup();
      await signIn(page);
      const reverse = await ids(BULBASAUR, "reverse");
      await page.goto(
        `${ORIGIN}/catalog?printing=${reverse.printing}&edition=${reverse.edition}`
      );
      const card = page.getByRole("dialog", { name: "Bulbasaur" });
      await expect(
        card.getByRole("region", { name: "Report card metadata" })
      ).toBeVisible();
      await expect
        .poll(() => here(page))
        .toBe(`/catalog?card=${reverse.printing}&edition=${reverse.edition}`);
      await page.reload();
      await expect(card).toBeVisible();
      await expect(
        card.getByRole("region", { name: "Report card metadata" })
      ).toHaveCount(0);
    });
  });
}

test.describe("desktop", () => {
  test.use({ viewport: { width: 1280, height: 800 } });
  test("Collection's Add cards writes no card to the address", async ({
    page,
  }) => {
    seedPopup();
    await signIn(page);
    const response = await page.request.post(`${ORIGIN}/api/location-tree`, {
      headers: { origin: ORIGIN },
      data: {
        name: "Card URL box",
        parent_id: null,
        parent_version: null,
        idempotency_key: randomUUID(),
      },
    });
    expect(response.status(), await response.text()).toBe(201);
    const { location } = (await response.json()) as {
      location: { id: string };
    };
    await page.goto(`${ORIGIN}/collection?location=${location.id}`);
    await page.getByRole("button", { name: "Add cards", exact: true }).click();
    const dialog = page.getByRole("dialog", {
      name: "Add cards to Card URL box",
    });
    await expect(dialog).toBeVisible();
    const address = here(page);
    await dialog
      .getByRole("region", { name: "Catalog results" })
      .getByRole("button", { name: new RegExp(`^${NORMAL}`) })
      .click();
    await expect(page.getByRole("dialog", { name: "Bulbasaur" })).toBeVisible();
    expect(here(page)).toBe(address);
    expect(here(page)).not.toContain("card=");
  });
});

test.describe("phone enlarged image", () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true });
  test("Escape, Back, Forward and a breakpoint flip leave the history and the page sound", async ({
    page,
  }) => {
    seedPopup();
    await signIn(page);
    await page.goto(`${ORIGIN}/catalog?q=Bulbasaur`);
    await tile(page, NORMAL).tap();
    const card = page.getByRole("dialog", { name: "Bulbasaur" });
    const enlarge = card.getByRole("button", {
      name: "View larger image of Bulbasaur",
    });
    const open = async () => {
      await expect(enlarge).toBeEnabled();
      await enlarge.tap();
      await expect(page.getByRole("dialog")).toHaveCount(2);
    };
    const address = here(page);
    const length = await historyLength(page);

    await open();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(1);
    expect(here(page)).toBe(address);
    expect(await historyLength(page)).toBe(length);

    await open();
    await page.goBack();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(await page.evaluate(() => document.body.style.overflow)).not.toBe(
      "hidden"
    );
    await tile(page, NORMAL).tap();
    await expect(card).toBeVisible();
    await page.goBack();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // Forward reopens the card without the enlarged image.
    await page.goForward();
    await expect(card).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(1);

    await open();
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.getByRole("dialog")).toHaveCount(1);
    await page.setViewportSize({ width: 375, height: 812 });
    await expect(page.getByRole("dialog")).toHaveCount(1);
  });
});
