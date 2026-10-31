import type { Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { expect, test } from "./support/collectors";
import {
  befriend,
  createDeck,
  hold,
  nameCollector,
  ORIGIN,
  seedCatalog,
  setLine,
  unsorted,
} from "./support/loans";
import { signInAsOwner } from "./support/sign-in";

// Asking from a Deck's page makes a new draft For that Deck (borrow-draft-deck.spec.ts), and a sent request shows
// under that Deck's lines as asked for (deck-pending-loans.spec.ts). Together: Ask, Review and Send with no Deck
// chosen by hand puts the request under the Deck the page is about, at once; and a draft already For another Deck
// keeps that Deck, so its request shows there and never under the page that added a card to it. Misty lends a
// spare Iono PAL 185 and a Boss's Orders PAL 172 (the Swap catalog, api/tests/want_list_swap_fixtures.py); she signs
// in first, so the test's own page signs in afterwards as a new account.

const tray = (page: Page) =>
  page.getByRole("region", { name: "Borrow Request drafts" });
const composer = (page: Page) =>
  page.getByRole("dialog", { name: "Borrow Request to Misty W" });
const needs = (page: Page, deckName: string) =>
  page.getByRole("list", { name: `What ${deckName} needs` });
const chip = (page: Page, deckName: string, card: string) =>
  needs(page, deckName)
    .getByRole("list", { name: `Friends who can lend ${card}` })
    .getByRole("button", { name: /^Misty W/ });
const isPending = (url: string) => url.includes("/api/loans/pending");

async function review(page: Page) {
  await tray(page)
    .getByRole("button", { name: "Review Borrow Request to Misty W" })
    .click();
  await expect(composer(page)).toBeVisible();
  return composer(page);
}

/** Opens the Want List on one Deck once its pending read has answered. */
async function openScoped(page: Page, deck: string) {
  const pending = page.waitForResponse((response) => isPending(response.url()));
  await page.goto(`${ORIGIN}/decks/want-list?deck=${deck}`);
  await pending;
}

/** Sends the open draft as it is, and waits for the pending read the send asks for. */
async function send(page: Page) {
  const reread = page.waitForResponse((response) => isPending(response.url()));
  await composer(page)
    .getByRole("button", { name: "Send Borrow Request" })
    .click();
  await expect(composer(page)).toBeHidden();
  await reread;
}

test.use({ viewport: { width: 1280, height: 800 } });

async function setUp(page: Page, signIn: () => Promise<{ page: Page }>) {
  const ids = seedCatalog();
  const s = randomUUID().slice(0, 6);
  const misty = await signIn();
  await nameCollector(misty.page, "Misty W");
  const mistyUnsorted = await unsorted(misty.page);
  await hold(misty.page, mistyUnsorted, ids["PAL 185"], 2);
  await hold(misty.page, mistyUnsorted, ids["PAL 172"], 1);
  await page.route(/^https:\/\/assets\.tcgdex\.net\//, (route) =>
    route.abort()
  );
  await signInAsOwner(page, "/decks");
  await nameCollector(page, "Ash K");
  await befriend(page, misty.page);
  return { ids, s };
}

test("Ask, Review and Send from a Deck's Want List shows the request under that Deck with no Deck chosen by hand", async ({
  page,
  collectors,
}) => {
  const { ids, s } = await setUp(page, () =>
    collectors.signIn({ next: "/decks" })
  );
  const deckName = `Charizard ex ${s}`;
  const deck = await createDeck(page, deckName);
  await setLine(page, deck, ids["PAL 185"], 2);

  await openScoped(page, deck);
  await expect(needs(page, deckName)).not.toContainText("Asked Misty W");
  await chip(page, deckName, "Iono").click();
  const draft = await review(page);
  // The page's Deck, not a choice made here.
  await expect(draft.getByLabel("For Deck")).toHaveValue(deck);
  await send(page);
  await expect(needs(page, deckName)).toContainText("Asked Misty W for 1");
  await expect(needs(page, deckName)).toContainText("2 of 2");
});

test("a draft already For another Deck keeps it, so its request shows there and not under the page that added a card", async ({
  page,
  collectors,
}) => {
  test.slow();
  const { ids, s } = await setUp(page, () =>
    collectors.signIn({ next: "/decks" })
  );
  const lugiaName = `Lugia ${s}`;
  const lugia = await createDeck(page, lugiaName);
  await setLine(page, lugia, ids["PAL 185"], 1);
  const charizardName = `Charizard ex ${s}`;
  const charizard = await createDeck(page, charizardName);
  await setLine(page, charizard, ids["PAL 185"], 1);
  await setLine(page, charizard, ids["PAL 172"], 1);

  // Misty's draft starts on Lugia's Want List, so it is For Lugia.
  await openScoped(page, lugia);
  await chip(page, lugiaName, "Iono").click();
  let draft = await review(page);
  await expect(draft.getByLabel("For Deck")).toHaveValue(lugia);
  await draft.getByRole("button", { name: "Keep draft" }).click();
  await expect(composer(page)).toBeHidden();

  // Charizard's Want List adds Boss's Orders to the same draft; it stays For Lugia, and is sent as it is.
  await openScoped(page, charizard);
  await chip(page, charizardName, "Boss's Orders").click();
  draft = await review(page);
  await expect(draft.getByLabel("For Deck")).toHaveValue(lugia);
  await send(page);
  // Nothing of it is Charizard's, though Charizard lists both cards.
  await expect(needs(page, charizardName)).not.toContainText("Asked Misty W");

  // Lugia shows the Iono it asked for; it doesn't list Boss's Orders, so that line isn't there to show.
  await openScoped(page, lugia);
  await expect(needs(page, lugiaName)).toContainText("Asked Misty W for 1");
  await expect(page.getByRole("main")).not.toContainText("Boss's Orders");
});
