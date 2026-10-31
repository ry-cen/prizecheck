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

// League journey: Ask on a page about one Deck (the Want List scoped to it) starts the Friend's Borrow Request draft
// For that Deck, through the existing deck_id. A draft already started keeps its own For Deck, a different Deck or
// none; the unscoped All Decks Want List starts one with no Deck; the choice survives a reload, stays editable, and the
// sent request carries it. The deck builder's panel is in deck-want-list-panel-friends.spec.ts. Brock lends a spare
// Iono PAL 254 and a Boss's Orders; Misty a spare Iono PAL 254 and a Boss's Orders (the Swap catalog,
// api/tests/want_list_swap_fixtures.py). The Friends sign in first, so the test's own page signs in afterwards.

const tray = (page: Page) =>
  page.getByRole("region", { name: "Borrow Request drafts" });
const composer = (page: Page, friend: string) =>
  page.getByRole("dialog", { name: `Borrow Request to ${friend}` });
const chip = (page: Page, deckName: string, card: string, friend: string) =>
  page
    .getByRole("list", { name: `What ${deckName} needs` })
    .getByRole("list", { name: `Friends who can lend ${card}` })
    .getByRole("button", { name: new RegExp(`^${friend}`) });

/** Opens the composer on the Friend's draft from the tray. */
async function review(page: Page, friend: string) {
  await tray(page)
    .getByRole("button", { name: `Review Borrow Request to ${friend}` })
    .click();
  await expect(composer(page, friend)).toBeVisible();
  return composer(page, friend);
}

/** Closes the composer, keeping the draft. */
async function keep(page: Page, friend: string) {
  await composer(page, friend)
    .getByRole("button", { name: "Keep draft" })
    .click();
  await expect(composer(page, friend)).toBeHidden();
}

test.use({ viewport: { width: 1280, height: 800 } });

test("Ask on a Deck's Want List starts the draft For that Deck and never changes a draft already started", async ({
  page,
  collectors,
}) => {
  test.slow();
  const ids = seedCatalog();
  const s = randomUUID().slice(0, 6);
  const brock = await collectors.signIn({ next: "/decks" });
  await nameCollector(brock.page, "Brock S");
  const brockUnsorted = await unsorted(brock.page);
  await hold(brock.page, brockUnsorted, ids["PAL 254"], 1);
  await hold(brock.page, brockUnsorted, ids["PAL 172"], 1);
  const misty = await collectors.signIn({ next: "/decks" });
  await nameCollector(misty.page, "Misty W");
  const mistyUnsorted = await unsorted(misty.page);
  await hold(misty.page, mistyUnsorted, ids["PAL 254"], 1);
  await hold(misty.page, mistyUnsorted, ids["PAL 172"], 1);

  await page.route(/^https:\/\/assets\.tcgdex\.net\//, (route) =>
    route.abort()
  );
  await signInAsOwner(page, "/decks");
  await nameCollector(page, "Ash K");
  const charizardName = `Charizard ex ${s}`;
  const charizard = await createDeck(page, charizardName);
  await setLine(page, charizard, ids["PAL 185"], 2);
  await setLine(page, charizard, ids["PAL 172"], 1);
  const lugiaName = `Lugia ${s}`;
  const lugia = await createDeck(page, lugiaName);
  await setLine(page, lugia, ids["PAL 185"], 1);
  await befriend(page, brock.page);
  await befriend(page, misty.page);

  // A new draft from the Want List scoped to Charizard is For Charizard, and a reload keeps it.
  await page.goto(`${ORIGIN}/decks/want-list?deck=${charizard}`);
  await chip(page, charizardName, "Iono", "Brock S").click();
  await expect(tray(page)).toContainText("Borrow Request to Brock S");
  let brockDraft = await review(page, "Brock S");
  await expect(brockDraft.getByLabel("For Deck")).toHaveValue(charizard);
  await keep(page, "Brock S");
  await page.reload();
  brockDraft = await review(page, "Brock S");
  await expect(brockDraft.getByLabel("For Deck")).toHaveValue(charizard);

  // No Deck, chosen on purpose, stays when the same page asks the Friend for another card.
  await brockDraft
    .getByLabel("For Deck")
    .selectOption({ label: "No Deck (they go to Unsorted)" });
  await keep(page, "Brock S");
  await chip(page, charizardName, "Boss's Orders", "Brock S").click();
  await expect(tray(page)).toContainText("2 cards");
  brockDraft = await review(page, "Brock S");
  await expect(brockDraft.getByLabel("For Deck")).toHaveValue("");
  await keep(page, "Brock S");

  // Get from Friends on Lugia's Want List: Ask starts Misty's draft For Lugia.
  await page.goto(`${ORIGIN}/decks/want-list?deck=${lugia}`);
  await page
    .getByRole("radiogroup", { name: "Show the Want List as" })
    .getByRole("radio", { name: "Get from Friends" })
    .click();
  await page
    .getByRole("region", { name: "Iono" })
    .getByRole("button", { name: "Ask Misty W for Iono" })
    .click();
  let mistyDraft = await review(page, "Misty W");
  await expect(mistyDraft.getByLabel("For Deck")).toHaveValue(lugia);
  await keep(page, "Misty W");

  // Asking Misty from Charizard's Want List adds the card but leaves her draft For Lugia.
  await page.goto(`${ORIGIN}/decks/want-list?deck=${charizard}`);
  await chip(page, charizardName, "Boss's Orders", "Misty W").click();
  mistyDraft = await review(page, "Misty W");
  await expect(
    mistyDraft
      .getByRole("list", { name: "Cards to borrow" })
      .getByRole("listitem")
  ).toHaveCount(2);
  await expect(mistyDraft.getByLabel("For Deck")).toHaveValue(lugia);

  // Sending it is unchanged: the toast confirms, and the Loan is For Lugia.
  await mistyDraft.getByRole("button", { name: "Send Borrow Request" }).click();
  await expect(mistyDraft).toBeHidden();
  const notifications = page.getByRole("region", { name: "Notifications" });
  await expect(notifications).toContainText("Borrow Request sent to Misty W.");
  await notifications.getByRole("button", { name: "View" }).click();
  await expect(page).toHaveURL(/\/loans\/[0-9a-f-]+$/);
  await expect(page.getByRole("main")).toContainText(
    `You're borrowing · For ${lugiaName}`
  );

  // On All Decks no one Deck is the page's: a new draft has no Deck.
  brockDraft = await review(page, "Brock S");
  await brockDraft.getByRole("button", { name: "Discard" }).click();
  await expect(tray(page)).toHaveCount(0);
  await page.goto(`${ORIGIN}/decks/want-list`);
  await chip(page, charizardName, "Iono", "Brock S").click();
  brockDraft = await review(page, "Brock S");
  await expect(brockDraft.getByLabel("For Deck")).toHaveValue("");
});
