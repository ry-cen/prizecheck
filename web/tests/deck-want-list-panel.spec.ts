import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { startAsNewOwner } from "./support/owner";
import { expectPageChecks } from "./support/page-check";
import { signInAsOwner } from "./support/sign-in";
import { expectTouchTarget } from "./support/touch-target";

// The deck builder's finish-deck flow. Under row 1's cost, four counts add up to the Deck List: In this Deck, Owned
// elsewhere, Lent out and Not owned. While a copy is missing from the Deck, Ways to get missing cards opens the Deck's
// Want List lines in place, with the Want List's own Swap, Undo, Will accept and Friend chips. The panel stays mounted
// once opened, collapsed or not and after the Deck is complete, so a Swap's Undo outlives both. The catalog
// (api/tests/want_list_swap_fixtures.py) has Iono PAL 185 and PAL 254 in one Reprint Group.

const ORIGIN = process.env.TEST_ORIGIN || "http://localhost:5173";
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

type Editions = Record<"PAL 185" | "PAL 254" | "SVE 5" | "SVE 13", string>;

/** The Swap catalog through the real catalog import (it replaces the catalog); returns the Edition ids by key. */
function seedCatalog(): Editions {
  const out = execFileSync(
    ".venv/bin/python",
    [
      "-c",
      "from want_list_swap_fixtures import print_swap_catalog\nprint_swap_catalog()",
    ],
    {
      env: { ...process.env, PYTHONPATH: "api:api/tests" },
      maxBuffer: 64 * 1024 * 1024,
    }
  ).toString();
  return JSON.parse(out.slice(out.lastIndexOf("SWAP") + 4)) as Editions;
}

async function signIn(page: Page) {
  // Card artwork never reaches the network.
  await page.route(/^https:\/\/assets\.tcgdex\.net\//, (route) =>
    route.abort()
  );
  await pool.query("DELETE FROM auth_send_event");
  await startAsNewOwner(pool);
  await signInAsOwner(page, "/decks");
  await expect(
    page.getByRole("navigation", { name: "Main views" })
  ).toBeVisible();
}

async function api(
  page: Page,
  method: "GET" | "POST",
  path: string,
  data?: object
) {
  const response = await page.request.fetch(`${ORIGIN}${path}`, {
    method,
    headers: { origin: ORIGIN },
    data,
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

async function setLine(
  page: Page,
  deckId: string,
  edition: string,
  quantity: number
) {
  const detail = await api(page, "GET", `/api/decks/${deckId}`);
  await api(page, "POST", `/api/decks/${deckId}/deck-list/changes`, {
    revision: detail.deck_list.revision,
    idempotency_key: randomUUID(),
    changes: [{ edition_id: edition, quantity: String(quantity) }],
  });
}

/** The Deck List as {Edition id: quantity}. */
async function deckList(page: Page, deckId: string) {
  const detail = await api(page, "GET", `/api/decks/${deckId}`);
  return Object.fromEntries(
    (detail.deck_list.lines as { edition_id: string; quantity: string }[]).map(
      (line) => [line.edition_id, line.quantity]
    )
  );
}

/**
 * A Deck whose one missing card a Swap completes: it holds one PAL 254 beyond its Deck List (a Spare Copy) and lists
 * one Iono PAL 185, which it doesn't hold.
 */
async function lastGap(page: Page, ids: Editions) {
  const name = `Finish ${randomUUID().slice(0, 6)}`;
  const created = await api(page, "POST", "/api/decks", {
    name,
    idempotency_key: randomUUID(),
  });
  const deck = created.location.id as string;
  // A copy arriving in a Deck lists it (migration 031); taking the line off leaves the copy as surplus.
  await api(page, "POST", "/api/holdings", {
    location_id: deck,
    edition_id: ids["PAL 254"],
    quantity: "1",
    idempotency_key: randomUUID(),
  });
  await setLine(page, deck, ids["PAL 254"], 0);
  await setLine(page, deck, ids["PAL 185"], 1);
  return { name, deck };
}

const hold = (
  page: Page,
  location: string,
  edition: string,
  quantity: number
) =>
  api(page, "POST", "/api/holdings", {
    location_id: location,
    edition_id: edition,
    quantity: String(quantity),
    idempotency_key: randomUUID(),
  });

async function shelf(page: Page) {
  const created = await api(page, "POST", "/api/location-tree", {
    name: `Shelf ${randomUUID().slice(0, 6)}`,
    parent_id: null,
    parent_version: null,
    idempotency_key: randomUUID(),
  });
  return created.location.id as string;
}

async function newDeck(page: Page, prefix: string) {
  const name = `${prefix} ${randomUUID().slice(0, 6)}`;
  const created = await api(page, "POST", "/api/decks", {
    name,
    idempotency_key: randomUUID(),
  });
  return { name, deck: created.location.id as string };
}

/** Text at 200%: every font size token doubled, the rest of the layout as it is. */
async function doubleText(page: Page) {
  await page.addStyleTag({
    content: `:root, :root * { ${[
      ["2xs", 10],
      ["xs", 11],
      ["sm", 12],
      ["control", 13],
      ["md", 14],
      ["lg", 18],
      ["xl", 24],
    ]
      .map(
        ([name, px]) => `--font-size-${name}: ${Number(px) * 2}px !important;`
      )
      .join(" ")} }`,
  });
}

/** The element's text fits it: nothing is cut off sideways. */
async function expectNoClipping(locator: ReturnType<Page["locator"]>) {
  const { scroll, client } = await locator.evaluate((element) => ({
    scroll: element.scrollWidth,
    client: element.clientWidth,
  }));
  expect(scroll, "text cut off sideways").toBeLessThanOrEqual(client + 1);
}

const readiness = (page: Page) =>
  page.getByRole("group", { name: "Where this Deck's cards are" });
const toggle = (page: Page) =>
  page.getByRole("button", { name: "Ways to get missing cards" });
const panel = (page: Page) =>
  page.getByRole("region", { name: "Ways to get missing cards" });
const notifications = (page: Page) =>
  page.getByRole("region", { name: "Notifications" });
const swapButton = (page: Page) =>
  page.getByRole("button", {
    name: "Swap 1 Iono Paldea Evolved 185 for PAL 254",
  });

test.afterAll(async () => {
  await pool.end();
});

test.describe("on a desktop", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("the four counts add up, the panel's Swap completes the Deck, and its Undo survives the panel collapsing and the Deck completing", async ({
    page,
  }) => {
    const ids = seedCatalog();
    await signIn(page);
    const { name, deck } = await lastGap(page, ids);
    await page.goto(`${ORIGIN}/decks/${deck}`);

    await expect(readiness(page)).toContainText("In this Deck0");
    await expect(readiness(page)).toContainText("Owned elsewhere0");
    await expect(readiness(page)).toContainText("Lent out0");
    await expect(readiness(page)).toContainText("Not owned1");
    // The Want List keeps its own page and row 1's actions keep their names.
    await expect(
      page.getByRole("button", { name: "Want List", exact: true })
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Buy missing", exact: true })
    ).toBeVisible();

    // Nothing is read until the panel opens.
    await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");
    await expect(panel(page)).toBeHidden();
    await toggle(page).click();
    await expect(toggle(page)).toHaveAttribute("aria-expanded", "true");
    await expect(panel(page)).toContainText(
      "Counted as Every Deck built at once."
    );
    const needs = panel(page)
      .getByRole("list", { name: `What ${name} needs` })
      .getByRole("listitem");
    await expect(needs).toHaveCount(1);
    await expect(needs).toContainText("1 of 1");
    await expectPageChecks(
      page,
      "the deck builder's Ways to get missing cards"
    );

    // The Swap completes the Deck: the readiness says so, and the panel stays with nothing to get.
    await swapButton(page).click();
    await expect(notifications(page)).toContainText(
      `Swapped 1 Iono for PAL 254 in ${name}.`
    );
    await expect(page.getByText("Every card is in this Deck.")).toBeVisible();
    await expect(panel(page)).toContainText(
      "Nothing to get, counted as Every Deck built at once."
    );
    expect(await deckList(page, deck)).toEqual({ [ids["PAL 254"]]: "1" });

    // Collapsing keeps the panel mounted, so the toast's Undo stays.
    await toggle(page).click();
    await expect(panel(page)).toBeHidden();
    const undo = notifications(page).getByRole("button", { name: "Undo" });
    await expect(undo).toBeVisible();
    await undo.click();
    await expect(notifications(page)).toContainText(
      `Undone: Swapped 1 Iono for PAL 254 in ${name}.`
    );
    // The builder reads the Deck again: the counts and the reopened panel follow the restored Deck List.
    await expect(readiness(page)).toContainText("Not owned1");
    expect(await deckList(page, deck)).toEqual({ [ids["PAL 185"]]: "1" });
    await toggle(page).click();
    await expect(needs).toContainText("1 of 1");
    await expect(swapButton(page)).toBeVisible();
  });

  for (const inFlight of [false, true]) {
    test(`Swap Undo survives the phone breakpoint${inFlight ? " while the command is in flight" : ""}`, async ({
      page,
    }) => {
      const ids = seedCatalog();
      await signIn(page);
      const { deck } = await lastGap(page, ids);
      await page.goto(`${ORIGIN}/decks/${deck}`);
      await toggle(page).click();
      await expect(swapButton(page)).toBeVisible();

      const panelId = await panel(page).getAttribute("id");
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let started!: () => void;
      const commandStarted = new Promise<void>((resolve) => {
        started = resolve;
      });
      if (inFlight) {
        await page.route(
          `**/api/decks/${deck}/deck-list/changes`,
          async (route) => {
            started();
            await held;
            await route.continue();
          },
          { times: 1 }
        );
      }
      await swapButton(page).click();
      const undo = notifications(page).getByRole("button", { name: "Undo" });
      if (inFlight) await commandStarted;
      else await expect(undo).toBeVisible();
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(page.getByRole("tab", { name: /Deck/ })).toHaveAttribute(
        "aria-selected",
        "true"
      );
      const librarySearch = page.getByRole("searchbox", {
        name: "Search the library",
        includeHidden: true,
      });
      await expect(librarySearch).toHaveCount(1);
      await expect(librarySearch).toBeHidden();
      await page.setViewportSize({ width: 1280, height: 800 });
      await expect(librarySearch).toBeVisible();
      release();
      await expect(undo).toBeVisible();
      await expect(page.getByText("Every card is in this Deck.")).toBeVisible();
      await expect(toggle(page)).toHaveAttribute("aria-expanded", "true");
      await expect(panel(page)).toHaveAttribute("id", panelId!);
      await undo.click();
      await expect(readiness(page)).toContainText("Not owned1");
      expect(await deckList(page, deck)).toEqual({ [ids["PAL 185"]]: "1" });
      await expect(swapButton(page)).toBeVisible();
    });
  }

  test("a failed read says so in the panel, and Retry reads again", async ({
    page,
  }) => {
    const ids = seedCatalog();
    await signIn(page);
    const { name, deck } = await lastGap(page, ids);
    // The first read of this Deck's Want List fails; later ones go through.
    let failures = 1;
    await page.route(/\/api\/want-list\?deck=/, (route) => {
      if (failures-- > 0) return route.fulfill({ status: 500, body: "{}" });
      return route.continue();
    });
    await page.goto(`${ORIGIN}/decks/${deck}`);
    await toggle(page).click();
    await expect(panel(page)).toContainText(
      "What this Deck needs couldn't be loaded."
    );
    // The rest of the builder is unaffected.
    await expect(readiness(page)).toContainText("Not owned1");
    await panel(page).getByRole("button", { name: "Retry" }).click();
    await expect(
      panel(page)
        .getByRole("list", { name: `What ${name} needs` })
        .getByRole("listitem")
    ).toContainText("1 of 1");
    await expect(panel(page)).not.toContainText("couldn't be loaded");
  });

  test("Will accept in the panel widens the Swap hint in place", async ({
    page,
  }) => {
    const ids = seedCatalog();
    await signIn(page);
    // Basic Psychic Energy SVE 13 and SVE 5 share a name and no Reprint Group.
    const { name, deck } = await newDeck(page, "Gardevoir ex");
    await setLine(page, deck, ids["SVE 13"], 4);
    await hold(page, await shelf(page), ids["SVE 5"], 2);
    await page.goto(`${ORIGIN}/decks/${deck}`);
    await toggle(page).click();
    const line = panel(page)
      .getByRole("list", { name: `What ${name} needs` })
      .getByRole("listitem");
    await expect(line).toContainText("4 of 4");
    await expect(line).not.toContainText("You own a card with the same name");

    await panel(page)
      .getByRole("combobox", {
        name: /^Will accept for Basic Psychic Energy \(Scarlet & Violet Energies · 013 /,
      })
      .selectOption({ label: "Any card with the same name" });
    await expect(line).toContainText(
      "↻ You own a card with the same name (sve 005) × 2"
    );
    await expect(
      panel(page).getByRole("button", {
        name: "Swap 2 Basic Psychic Energy Scarlet & Violet Energies 013 for sve 005",
      })
    ).toBeVisible();
    // Will accept changes no count.
    await expect(line).toContainText("4 of 4");
    await expect(readiness(page)).toContainText("Not owned4");
  });

  test("Gather moves a counted spare into the Deck, and the open panel follows the Deck's new read", async ({
    page,
  }) => {
    const ids = seedCatalog();
    await signIn(page);
    // 2 Iono PAL 185 listed, none in the Deck, one loose on a Shelf: the Want List counts it as a spare.
    const { name, deck } = await newDeck(page, "Gather");
    await setLine(page, deck, ids["PAL 185"], 2);
    await hold(page, await shelf(page), ids["PAL 185"], 1);
    await page.goto(`${ORIGIN}/decks/${deck}`);
    await expect(readiness(page)).toContainText("Owned elsewhere1");
    await toggle(page).click();
    const line = panel(page)
      .getByRole("list", { name: `What ${name} needs` })
      .getByRole("listitem");
    await expect(line).toContainText("1 of 2");
    await expect(line).toContainText("Have 1 spare");

    // Gather changes the Holdings, not the Deck List: the panel reads again on the Deck read's owner revision.
    await page.getByRole("button", { name: "Gather 1", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Gather cards you own" });
    await dialog.getByRole("button", { name: "Confirm all" }).click();
    await expect(dialog).toBeHidden();
    await expect(readiness(page)).toContainText("In this Deck1");
    await expect(readiness(page)).toContainText("Owned elsewhere0");
    await expect(line).toContainText("1 of 2");
    await expect(line).toContainText("Have 1 in this Deck");
  });
});

for (const width of [375, 320]) {
  test.describe(`on a ${width} px phone`, () => {
    test.use({ viewport: { width, height: 740 }, hasTouch: true });

    test("the counts and the open panel fit without sideways scroll, also with text at 200%", async ({
      page,
    }) => {
      const ids = seedCatalog();
      await signIn(page);
      const { deck } = await lastGap(page, ids);
      await page.goto(`${ORIGIN}/decks/${deck}`);
      // A Deck that lists cards opens on its Deck tab on a phone; the tap keeps it there.
      await page.getByRole("tab", { name: /^Deck / }).tap();
      await expect(readiness(page)).toContainText("Not owned1");
      await expectTouchTarget(toggle(page));
      await toggle(page).tap();
      await expect(swapButton(page)).toBeVisible();
      await expectPageChecks(page, `the open panel on a ${width} px phone`);
      await page.screenshot({
        path: test.info().outputPath(`panel-${width}.png`),
        fullPage: true,
      });

      await doubleText(page);
      await page.screenshot({
        path: test.info().outputPath(`panel-${width}-text-200.png`),
        fullPage: true,
      });
      // The elements wider than the screen are recorded first, to tell this panel's parts from the rest of the builder;
      // then this panel's own parts must fit, and then the whole page must pass the page checks as at normal size.
      const wide = await page.evaluate(() =>
        [...document.querySelectorAll("body *")]
          .filter((element) => {
            const box = element.getBoundingClientRect();
            return box.width > 0 && box.right > window.innerWidth + 1;
          })
          .filter(
            (element) =>
              ![...element.children].some(
                (child) =>
                  child.getBoundingClientRect().right > window.innerWidth + 1
              )
          )
          .map(
            (element) =>
              `${element.tagName.toLowerCase()} "${(element.textContent ?? "").trim().slice(0, 40)}" ${Math.round(element.getBoundingClientRect().right)} px`
          )
      );
      test.info().annotations.push({
        type: "wider than the screen at 200% text",
        description: wide.join(" | ") || "none",
      });
      for (const part of [readiness(page), toggle(page), panel(page)]) {
        const box = (await part.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
      }
      await expectNoClipping(toggle(page));
      await expectNoClipping(swapButton(page));
      await expectPageChecks(
        page,
        `the open panel on a ${width} px phone with text at 200%`
      );
    });
  });
}
