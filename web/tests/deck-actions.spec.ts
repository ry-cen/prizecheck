import { test, expect, type Page } from "@playwright/test";
import { signInAsOwner } from "./support/sign-in";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { exportDialog } from "./support/deck-builder";
import {
  buildLegalDeck,
  hold,
  promoteLegalCatalog,
  type LegalDeck,
} from "./support/legal-deck";
import { expectPageChecks } from "./support/page-check";
import { startAsNewOwner } from "./support/owner";

// The Decks index, the deck builder's Export, Publish and Delete, Buy missing, and Collection's Deck banner (#181).
// The cards come through the real catalog import (support/legal-deck.ts), so the real rules files judge the Deck List:
// legal in Standard, not legal in Gym Leader Challenge (four-ofs).

const ORIGIN = process.env.TEST_ORIGIN || "http://localhost:5173";

async function sql<T>(text: string, values: unknown[] = []): Promise<T[]> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    return (await pool.query(text, values)).rows as T[];
  } finally {
    await pool.end();
  }
}

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

async function publishByApi(page: Page, deckId: string, title: string) {
  const response = await page.request.post(
    `${ORIGIN}/api/decks/${deckId}/publication`,
    {
      headers: { origin: ORIGIN },
      data: { title, idempotency_key: randomUUID() },
    }
  );
  expect(response.status()).toBe(200);
  return (await response.json()).token as string;
}

const header = (page: Page) => ({
  exportButton: page.getByRole("button", { name: "Export", exact: true }),
  publish: page.getByRole("button", { name: /^(Publish|Published · v\d+)$/ }),
  remove: page.getByRole("button", { name: "Delete Deck", exact: true }),
});
/** Chooses the Deck's Target Format ("Gym Leader Challenge") from the deck builder's Target Format menu. */
async function chooseTarget(page: Page, format: string) {
  await page
    .getByRole("group", { name: "Target Format and result" })
    .getByRole("button", { name: /^Target Format: / })
    .click();
  await page
    .getByRole("menu", { name: /^Target Format: / })
    .getByRole("menuitemradio", { name: format, exact: true })
    .click();
}
const deckIndex = (page: Page) =>
  page.getByRole("navigation", { name: "Deck index" });
const published = (page: Page) =>
  page.getByRole("list", { name: "Your Published Decks" });

/** The legal Deck holding three of its Basic Grass Energy, and four Switch in Unsorted (owned elsewhere). */
async function stockedDeck(page: Page): Promise<LegalDeck> {
  const built = await buildLegalDeck(page);
  await hold(built.owner, built.deckId, built.editions.energy, 3);
  const [unsorted] = await sql<{ id: string }>(
    "SELECT id FROM location WHERE owner_id=$1 AND name='Unsorted' AND parent_id IS NULL",
    [built.owner]
  );
  await hold(built.owner, unsorted.id, built.editions.switch, 4);
  return built;
}

test.describe("on a desktop", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("the Decks index lists each Deck with its in-Deck count, cost to complete and Target Format, and links to Discover", async ({
    page,
  }) => {
    promoteLegalCatalog();
    await signIn(page);
    await stubCost(page);
    const built = await stockedDeck(page);
    const emptyName = `Empty ${randomUUID().slice(0, 6)}`;
    const created = await page.request.post(`${ORIGIN}/api/decks`, {
      headers: { origin: ORIGIN },
      data: { name: emptyName, idempotency_key: randomUUID() },
    });
    expect(created.status()).toBe(201);

    await page.goto(`${ORIGIN}/decks`);
    await expect(
      page.getByRole("heading", { level: 1, name: "Decks" })
    ).toBeVisible();
    const row = deckIndex(page)
      .getByRole("listitem")
      .filter({ has: page.getByRole("link", { name: built.deckName }) });
    await expect(row).toContainText("3/60 in Deck");
    await expect(row).toContainText("$12.34 to complete (57/57 priced)");
    await expect(row).toContainText("Standard · ✓ Legal");
    const empty = deckIndex(page)
      .getByRole("listitem")
      .filter({ has: page.getByRole("link", { name: emptyName }) });
    await expect(empty).toContainText("Empty: plan a list");
    await expect(empty).toContainText(/Standard · (✕ Not legal|\? Unknown)/);
    await expect(published(page)).toHaveCount(0);
    await expect(page.getByText("Nothing published yet.")).toBeVisible();
    await expectPageChecks(page, "Decks index");

    // A Deck's name opens its builder.
    await deckIndex(page)
      .getByRole("link", { name: built.deckName, exact: true })
      .click();
    await expect(page).toHaveURL(`${ORIGIN}/decks/${built.deckId}`);
    await expect(
      page.getByRole("heading", { level: 1, name: built.deckName })
    ).toBeVisible();
    await page.getByRole("link", { name: "All Decks" }).click();
    await page.getByRole("link", { name: "Discover decks" }).click();
    await expect(page).toHaveURL(`${ORIGIN}/discover`);
  });

  test("Publish is disabled with its reason until the result is legal, then publishes, lists, republishes and revokes", async ({
    page,
  }) => {
    promoteLegalCatalog();
    await signIn(page);
    await stubCost(page);
    const built = await buildLegalDeck(page);
    await page.goto(`${ORIGIN}/decks/${built.deckId}`);
    const { publish } = header(page);

    // Gym Leader Challenge allows one copy of a card: not legal, so Publish says why and stays disabled.
    await chooseTarget(page, "Gym Leader Challenge");
    await expect(publish).toBeDisabled();
    // The Publish dialog's own copy of the reason stays in its closed dialog, hidden.
    const reason = page
      .getByText(
        /^Publish needs a legal Gym Leader Challenge deck: \d+ issues?$/
      )
      .filter({ visible: true });
    await expect(reason).toBeVisible();
    await expect(publish).toHaveAccessibleDescription(
      (await reason.textContent())!
    );
    await chooseTarget(page, "Standard");
    await expect(publish).toBeEnabled();
    await expect(reason).toHaveCount(0);

    await publish.click();
    const dialog = page.getByRole("dialog", { name: "Publish" });
    await expect(dialog).toContainText("never shows what you own");
    await expectPageChecks(page, "Publish dialog");
    await dialog.getByLabel("Public title").fill("Grass friends");
    await dialog
      .getByRole("button", { name: "Publish Unlisted snapshot" })
      .click();
    const managing = page.getByRole("dialog", { name: "Published Deck" });
    await expect(managing).toContainText(
      "Grass friends · Unlisted · version 1"
    );
    await expect(managing.getByRole("status").last()).toHaveText(
      "Published. Anyone with the link can view the snapshot."
    );
    const link = managing.getByRole("link", { name: "View public snapshot" });
    const href = (await link.getAttribute("href"))!;
    expect(href).toMatch(/^\/published\/[A-Za-z0-9_-]{32}$/);
    const snapshot = await page.request.get(
      `${ORIGIN}/api/public/decks/${href.split("/").at(-1)}`
    );
    expect(snapshot.status()).toBe(200);
    expect((await snapshot.json()).target_format).toBe("standard");

    await managing.getByRole("button", { name: "List in Discover" }).click();
    await expect(managing).toContainText("Grass friends · Listed · version 1");
    await managing.getByRole("button", { name: "Republish snapshot" }).click();
    await expect(managing).toContainText("Grass friends · Listed · version 2");
    await expectPageChecks(page, "Published Deck dialog");
    await page.keyboard.press("Escape");
    await expect(managing).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Published · v2" })
    ).toBeFocused();

    // A published Deck that stops being legal can still be managed: only Republish waits for a legal result.
    await chooseTarget(page, "Gym Leader Challenge");
    const again = page.getByRole("button", { name: "Published · v2" });
    await expect(again).toBeEnabled();
    await again.click();
    await expect(
      managing.getByRole("button", { name: "Republish snapshot" })
    ).toBeDisabled();
    await expect(managing).toContainText(
      /Publish needs a legal Gym Leader Challenge deck: \d+ issues?/
    );
    await managing
      .getByRole("button", { name: "Revoke: Grass friends" })
      .click();
    const confirm = managing.getByRole("group", {
      name: "Revoke Grass friends",
    });
    await expect(
      confirm.getByRole("button", { name: "Revoke for good" })
    ).toBeFocused();
    await confirm.getByRole("button", { name: "Keep it" }).click();
    await expect(
      managing.getByRole("button", { name: "Revoke: Grass friends" })
    ).toBeFocused();
    await managing
      .getByRole("button", { name: "Revoke: Grass friends" })
      .click();
    await confirm.getByRole("button", { name: "Revoke for good" }).click();
    await expect(page.getByRole("dialog", { name: "Publish" })).toContainText(
      "Public link revoked permanently."
    );
    const gone = await page.request.get(
      `${ORIGIN}/api/public/decks/${href.split("/").at(-1)}`
    );
    expect(gone.status()).toBe(404);
  });

  test("Buy missing opens the Mass Entry export on the cards you don't own, with the whole Deck List as an option, and Export opens Live on the whole Deck List", async ({
    page,
  }) => {
    promoteLegalCatalog();
    await signIn(page);
    await stubCost(page);
    const built = await stockedDeck(page);
    await page.goto(`${ORIGIN}/decks/${built.deckId}`);

    // Not owned: 1 Bulbasaur, 4 Rare Candy and 48 Energy; the Switch are owned elsewhere (Gather, not buy).
    const buy = page.getByRole("button", { name: "Buy missing", exact: true });
    await buy.click();
    const dialog = exportDialog(page);
    await expect(
      dialog.getByRole("radio", { name: "TCGplayer Mass Entry" })
    ).toBeChecked();
    const notOwned = dialog.getByRole("radio", {
      name: "Cards you don't own (53)",
    });
    await expect(notOwned).toBeChecked();
    const mass = dialog.getByRole("region", {
      name: "TCGplayer export",
      exact: true,
    });
    await mass
      .getByRole("button", { name: "Prepare TCGplayer export" })
      .click();
    const text = mass.getByLabel("TCGplayer Mass Entry text");
    await expect(text).toContainText("48 Basic Grass Energy");
    const lines = ((await text.textContent()) ?? "").split("\n").sort();
    expect(lines).toEqual([
      "1 Bulbasaur",
      "4 Rare Candy",
      "48 Basic Grass Energy",
    ]);
    await expect(mass).not.toContainText("not 60");
    await expectPageChecks(page, "Buy missing export");

    await dialog
      .getByRole("radio", { name: "The whole Deck List (60)" })
      .check();
    await mass
      .getByRole("button", { name: "Prepare TCGplayer export" })
      .click();
    await expect(text).toContainText("51 Basic Grass Energy");
    expect(((await text.textContent()) ?? "").split("\n").sort()).toEqual([
      "1 Bulbasaur",
      "4 Rare Candy",
      "4 Switch",
      "51 Basic Grass Energy",
    ]);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(buy).toBeFocused();

    // Escape then Enter with no wait reopens the dialog: the close event queued by the Escape must not shut it again.
    await page.keyboard.press("Enter");
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await page.keyboard.press("Enter");
    await expect(dialog).toBeVisible();
    // flake-exempt wait-for-timeout (quiet): a stale close event, if the bug returns, lands after the reopen
    await page.waitForTimeout(300);
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);

    // Export opens on Pokémon TCG Live, which exports the whole Deck List (here every card lacks reviewed Live data).
    await header(page).exportButton.click();
    await expect(
      dialog.getByRole("radio", { name: "Pokémon TCG Live" })
    ).toBeChecked();
    const live = dialog.getByRole("region", {
      name: "Pokémon TCG Live export",
    });
    await live.getByRole("button", { name: "Export to Live" }).click();
    const blockers = live.getByRole("region", { name: "Live export blockers" });
    await expect(blockers.getByRole("listitem")).toHaveCount(4);
    await expect(blockers).toContainText("×51");
    await expectPageChecks(page, "Live export");
    await dialog.getByRole("button", { name: "Close export" }).click();
    await expect(header(page).exportButton).toBeFocused();
  });

  test("Delete asks for the Deck's name, moves its cards to Unsorted and leaves its Published Deck live", async ({
    page,
  }) => {
    promoteLegalCatalog();
    await signIn(page);
    await stubCost(page);
    const built = await stockedDeck(page);
    const token = await publishByApi(page, built.deckId, "Kept live");
    await page.goto(`${ORIGIN}/decks/${built.deckId}`);

    await header(page).remove.click();
    const dialog = page.getByRole("dialog", { name: "Delete Deck" });
    await expect(dialog).toContainText(
      `Deleting ${built.deckName} moves its 3 cards to Unsorted and discards its Deck List.`
    );
    await expect(dialog).toContainText(
      "Any Published Deck made from it stays live until you revoke it"
    );
    const confirm = dialog.getByRole("button", {
      name: "Delete Deck",
      exact: true,
    });
    await expect(confirm).toBeDisabled();
    const field = dialog.getByLabel("Type the Deck name to confirm");
    await field.fill(built.deckName.toUpperCase());
    await expect(confirm).toBeDisabled();
    await field.fill(`  ${built.deckName} `);
    await expect(confirm).toBeEnabled();
    await expectPageChecks(page, "Delete Deck dialog");
    await confirm.click();

    await expect(page).toHaveURL(`${ORIGIN}/decks`);
    await expect(
      page.getByRole("region", { name: "Notifications" })
    ).toContainText(`Deleted ${built.deckName}. 3 cards moved to Unsorted.`);
    await expect(
      deckIndex(page).getByRole("link", { name: built.deckName })
    ).toHaveCount(0);
    const orphan = published(page)
      .getByRole("listitem")
      .filter({ hasText: "Kept live" });
    await expect(orphan).toContainText("Kept live · Unlisted · v1");
    await expect(orphan).toContainText(
      "Its Deck was deleted. It stays live until you revoke it."
    );
    expect(
      (await page.request.get(`${ORIGIN}/api/public/decks/${token}`)).status()
    ).toBe(200);
    const [unsorted] = await sql<{ n: string }>(
      `SELECT coalesce(sum(h.quantity),0) AS n FROM holding h JOIN location l ON l.id=h.location_id
       WHERE l.owner_id=$1 AND l.name='Unsorted' AND l.parent_id IS NULL AND h.edition_id=$2`,
      [built.owner, built.editions.energy]
    );
    expect(Number(unsorted.n)).toBe(3);

    // The orphan is managed from the index: Make Listed, then Revoke in two steps.
    await orphan
      .getByRole("button", { name: "Make Listed: Kept live" })
      .click();
    await expect(orphan).toContainText("Kept live · Listed · v1");
    await expectPageChecks(page, "Decks index with a Published Deck");
    await orphan.getByRole("button", { name: "Revoke: Kept live" }).click();
    await orphan.getByRole("button", { name: "Revoke for good" }).click();
    await expect(page.getByText("Nothing published yet.")).toBeVisible();
    // The revoked row is gone with the focus on it: it lands on the section heading, not <body>.
    await expect(
      page.getByRole("heading", { name: "Published Decks", level: 2 })
    ).toBeFocused();
    expect(
      (await page.request.get(`${ORIGIN}/api/public/decks/${token}`)).status()
    ).toBe(404);
  });

  test("in Collection an open Deck's Holdings sit under a banner with its cost and a link to the deck builder", async ({
    page,
  }) => {
    promoteLegalCatalog();
    await signIn(page);
    await stubCost(page);
    const built = await stockedDeck(page);
    await page.goto(`${ORIGIN}/collection?location=${built.deckId}`);
    await expect(
      page.getByRole("heading", { level: 1, name: built.deckName })
    ).toBeVisible();
    const banner = page.getByRole("region", { name: "Deck banner" });
    await expect(
      banner.getByRole("region", { name: "Estimated Deck Cost" })
    ).toContainText("$15.00 · 60/60 cards priced");
    await expect(banner).toContainText(
      "$15.00 deck (60/60 priced) · $12.34 to complete (57/57 priced)"
    );
    // Exports live on Decks now.
    await expect(
      page.getByRole("button", { name: "Export", exact: true })
    ).toHaveCount(0);
    await expect(page.getByText("3 copies · 1 edition")).toBeVisible();
    await expectPageChecks(page, "Collection Deck banner");
    await banner
      .getByRole("link", { name: "Open in the deck builder" })
      .click();
    await expect(page).toHaveURL(`${ORIGIN}/decks/${built.deckId}`);
    await expect(
      page.getByRole("heading", { level: 1, name: built.deckName })
    ).toBeVisible();
  });
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true });

  test("the Decks index, the builder's header actions and every dialog pass the page check", async ({
    page,
  }) => {
    promoteLegalCatalog();
    await signIn(page);
    await stubCost(page);
    const built = await stockedDeck(page);
    // An unpublished, legal Deck: Publish opens its dialog.
    await page.goto(`${ORIGIN}/decks/${built.deckId}`);
    await header(page).publish.tap();
    await expect(page.getByRole("dialog", { name: "Publish" })).toBeVisible();
    await expectPageChecks(page, "phone Publish dialog");
    await page.getByRole("button", { name: "Close Publish" }).tap();
    await expect(page.getByRole("dialog", { name: "Publish" })).toHaveCount(0);

    const token = await publishByApi(page, built.deckId, "Phone deck");
    await page.goto(`${ORIGIN}/decks`);
    await expect(
      published(page).getByRole("listitem").filter({ hasText: "Phone deck" })
    ).toContainText(`From ${built.deckName}`);
    await expectPageChecks(page, "phone Decks index");

    await deckIndex(page)
      .getByRole("link", { name: built.deckName, exact: true })
      .tap();
    await expect(header(page).publish).toHaveText("Published · v1");
    await expectPageChecks(page, "phone deck builder header");

    await header(page).exportButton.tap();
    await expect(exportDialog(page)).toBeVisible();
    await expectPageChecks(page, "phone export dialog");
    await exportDialog(page)
      .getByRole("button", { name: "Close export" })
      .tap();

    await header(page).publish.tap();
    const managing = page.getByRole("dialog", { name: "Published Deck" });
    await expect(managing).toContainText("Phone deck · Unlisted · version 1");
    await expectPageChecks(page, "phone Published Deck dialog");
    await managing.getByRole("button", { name: "Revoke: Phone deck" }).tap();
    await expect(
      managing.getByRole("button", { name: "Revoke for good" })
    ).toBeVisible();
    await expectPageChecks(page, "phone Revoke confirmation");
    await managing.getByRole("button", { name: "Keep it" }).tap();
    await managing.getByRole("button", { name: "Close Publish" }).tap();

    await page.getByRole("tab", { name: /^Deck / }).tap();
    await page.getByRole("button", { name: "Buy missing" }).tap();
    await expect(
      exportDialog(page).getByRole("radio", { name: /^Cards you don't own/ })
    ).toBeChecked();
    await expectPageChecks(page, "phone Buy missing export");
    await exportDialog(page)
      .getByRole("button", { name: "Close export" })
      .tap();

    await header(page).remove.tap();
    await expect(
      page.getByRole("dialog", { name: "Delete Deck" })
    ).toBeVisible();
    await expectPageChecks(page, "phone Delete Deck dialog");
    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });
});
