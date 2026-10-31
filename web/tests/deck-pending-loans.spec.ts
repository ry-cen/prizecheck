import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import {
  expect,
  test,
  type OtherCollector,
  type OtherCollectorOptions,
} from "./support/collectors";
import {
  accountId,
  api,
  befriend,
  createDeck,
  hold,
  loanStep,
  nameCollector,
  ORIGIN,
  seedCatalog,
  setLine,
  unsorted,
} from "./support/loans";
import { signInAsOwner } from "./support/sign-in";

// What a Deck is waiting on from Friends (GET /api/loans/pending, design docs/planning/social-network/
// want-list-pending-loans.md): under each needed line, the copies asked for and the copies a Friend agreed to lend,
// beside the counts and never taken off them. It is read apart from the Want List and again on window focus, the page
// becoming visible, the inbox pulse moving, Loans changing outside the Loans tab and a request this tab sent. It is not
// live: a change that moves neither (a write-off, the borrower's own step elsewhere) waits for the next focus.
//
// Misty W lends (another collector, signed in first); the test's page is Ash K, signing in afterwards as a new
// account. A call through `page.request` stands for another device: it shares the account but tells the tab nothing.

const isPulse = (url: string) =>
  url.includes("/api/social/conversations/pulse");
const isPending = (url: string) => url.includes("/api/loans/pending");

/** The collector leaves the window and comes straight back: a blur, then a focus, with no time passing in between, so
 * a return right after a read still reads. */
const focus = (page: Page) =>
  page.evaluate(() => {
    window.dispatchEvent(new Event("blur"));
    window.dispatchEvent(new Event("focus"));
  });

const needs = (page: Page, deckName: string) =>
  page.getByRole("list", { name: `What ${deckName} needs` });

test.use({ viewport: { width: 1280, height: 800 } });

/** Misty W holds `copies` Iono PAL 185 and is Ash K's Friend; Ash's new Deck lists `listed` of them. */
async function lending(
  page: Page,
  collectors: {
    signIn: (options?: OtherCollectorOptions) => Promise<OtherCollector>;
  },
  copies: number,
  listed: number
) {
  const ids = seedCatalog();
  const iono = ids["PAL 185"];
  const misty = await collectors.signIn({ next: "/decks" });
  await nameCollector(misty.page, "Misty W");
  await hold(misty.page, await unsorted(misty.page), iono, copies);
  await page.route(/^https:\/\/assets\.tcgdex\.net\//, (route) =>
    route.abort()
  );
  await signInAsOwner(page, "/decks");
  await nameCollector(page, "Ash K");
  const deckName = `Charizard ex ${randomUUID().slice(0, 6)}`;
  const deck = await createDeck(page, deckName);
  await setLine(page, deck, iono, listed);
  await befriend(page, misty.page);
  return { ids, iono, misty: misty.page, deck, deckName };
}

async function request(
  borrower: Page,
  lender: Page,
  edition: string,
  copies: number,
  deckId: string
): Promise<string> {
  const sent = await api(borrower, "POST", "/api/loans", {
    lender_id: await accountId(lender),
    lines: [{ edition_id: edition, quantity: String(copies) }],
    deck_id: deckId,
    idempotency_key: randomUUID(),
  });
  return sent.id as string;
}

const accept = (lender: Page, loan: string, edition: string, copies: number) =>
  loanStep(lender, loan, `/api/loans/${loan}/accept`, {
    lines: [{ edition_id: edition, promised: String(copies) }],
  });

/** Opens the Want List on one Deck and waits for its first pending read and pulse. */
async function openScoped(page: Page, deck: string) {
  const pending = page.waitForResponse((response) => isPending(response.url()));
  const pulse = page.waitForResponse((response) => isPulse(response.url()));
  await page.goto(`${ORIGIN}/decks/want-list?deck=${deck}`);
  await Promise.all([pending, pulse]);
}

test("a Borrow Request sent from the Want List shows under its line without a reload", async ({
  page,
  collectors,
}) => {
  const { deck, deckName } = await lending(page, collectors, 2, 2);
  await openScoped(page, deck);
  const lines = needs(page, deckName);
  await expect(lines).toContainText("2 of 2");
  await expect(lines).not.toContainText("Asked Misty W");

  await lines
    .getByRole("list", { name: "Friends who can lend Iono" })
    .getByRole("button", { name: /^Misty W · / })
    .click();
  await page
    .getByRole("region", { name: "Borrow Request drafts" })
    .getByRole("button", { name: "Review Borrow Request to Misty W" })
    .click();
  const composer = page.getByRole("dialog", {
    name: "Borrow Request to Misty W",
  });
  await composer.getByLabel("For Deck").selectOption({ label: deckName });
  const reread = page.waitForResponse((response) => isPending(response.url()));
  await composer.getByRole("button", { name: "Send Borrow Request" }).click();
  await reread;
  await expect(lines).toContainText("Asked Misty W for 1");
  // Information only: the line still needs both copies.
  await expect(lines).toContainText("2 of 2");
});

test("a Friend's answer from their own device shows once the inbox pulse moves", async ({
  page,
  collectors,
}) => {
  const { iono, misty, deck, deckName } = await lending(page, collectors, 3, 3);
  const loan = await request(page, misty, iono, 2, deck);
  await page.clock.install();
  await openScoped(page, deck);
  const lines = needs(page, deckName);
  await expect(lines).toContainText("Asked Misty W for 2");

  // A partial accept stores an inbox update for Ash, which moves the pulse; no focus is needed.
  await accept(misty, loan, iono, 1);
  const reread = page.waitForResponse((response) => isPending(response.url()));
  await page.clock.runFor(61_000);
  await reread;
  await expect(lines).toContainText("Misty W agreed to lend 1");
  await expect(lines).not.toContainText("Asked Misty W");
  await expect(lines).toContainText("3 of 3");
});

test("a write-off moves no pulse, so it shows at the next focus", async ({
  page,
  collectors,
}) => {
  const { iono, misty, deck, deckName } = await lending(page, collectors, 3, 3);
  const loan = await request(page, misty, iono, 3, deck);
  await accept(misty, loan, iono, 3);
  await page.clock.install();
  await openScoped(page, deck);
  const lines = needs(page, deckName);
  await expect(lines).toContainText("Misty W agreed to lend 3");

  await loanStep(misty, loan, `/api/loans/${loan}/handover`);
  await loanStep(misty, loan, `/api/loans/${loan}/write-off`, {
    lines: [{ edition_id: iono, quantity: "1" }],
  });
  // A pulse runs and finds nothing new: the write-off stored no inbox update, and nothing reads the pending again.
  const pulse = page.waitForResponse((response) => isPulse(response.url()));
  await page.clock.runFor(61_000);
  await pulse;
  await expect(lines).toContainText("Misty W agreed to lend 3");

  const reread = page.waitForResponse((response) => isPending(response.url()));
  await focus(page);
  await reread;
  await expect(lines).toContainText("Misty W agreed to lend 2");
});

test("receiving the copies on another device clears the line's pending note at the next focus", async ({
  page,
  collectors,
}) => {
  const { iono, misty, deck, deckName } = await lending(page, collectors, 2, 3);
  const loan = await request(page, misty, iono, 2, deck);
  await accept(misty, loan, iono, 2);
  await loanStep(misty, loan, `/api/loans/${loan}/handover`);
  await page.clock.install();
  await openScoped(page, deck);
  const lines = needs(page, deckName);
  await expect(lines).toContainText("Misty W agreed to lend 2");

  // Ash's other device confirms the copies arrived: they are Borrowed Copies now, not on their way.
  await loanStep(page, loan, `/api/loans/${loan}/handover`);
  const reread = page.waitForResponse((response) => isPending(response.url()));
  await focus(page);
  await reread;
  await expect(lines).not.toContainText("agreed to lend");
});

test("a failed refresh keeps the last answer and says it may be out of date", async ({
  page,
  collectors,
}) => {
  const { iono, misty, deck, deckName } = await lending(page, collectors, 2, 2);
  await request(page, misty, iono, 1, deck);
  await page.clock.install();
  await openScoped(page, deck);
  const lines = needs(page, deckName);
  await expect(lines).toContainText("Asked Misty W for 1");

  await page.route(/\/api\/loans\/pending/, (route) =>
    route.fulfill({ status: 503, body: "" })
  );
  await focus(page);
  const cue = page.getByRole("status").filter({
    hasText: "Requests to Friends may be out of date.",
  });
  await expect(cue).toBeVisible();
  // Never shown as nothing asked for.
  await expect(lines).toContainText("Asked Misty W for 1");

  await page.unroute(/\/api\/loans\/pending/);
  await cue.getByRole("button", { name: "Retry" }).click();
  await expect(cue).toBeHidden();
  await expect(lines).toContainText("Asked Misty W for 1");
});

test("each Deck shows only its own requests, All Decks shows none and the lender never sees them", async ({
  page,
  collectors,
}) => {
  const { iono, misty, deck, deckName } = await lending(page, collectors, 3, 2);
  const otherName = `Gardevoir ex ${randomUUID().slice(0, 6)}`;
  const other = await createDeck(page, otherName);
  await setLine(page, other, iono, 2);
  await request(page, misty, iono, 1, deck);
  await request(page, misty, iono, 2, other);

  await openScoped(page, deck);
  await expect(needs(page, deckName)).toContainText("Asked Misty W for 1");
  await expect(needs(page, deckName)).not.toContainText("for 2");
  await openScoped(page, other);
  await expect(needs(page, otherName)).toContainText("Asked Misty W for 2");
  await expect(needs(page, otherName)).not.toContainText("for 1");

  await page.goto(`${ORIGIN}/decks/want-list`);
  await expect(needs(page, deckName)).toBeVisible();
  await expect(page.getByRole("main")).not.toContainText("Asked Misty W");

  // Misty's own Deck listing the same card reads nothing of Ash's requests.
  const mistyName = `Misty deck ${randomUUID().slice(0, 6)}`;
  const mistyDeck = await createDeck(misty, mistyName);
  await setLine(misty, mistyDeck, iono, 5);
  await openScoped(misty, mistyDeck);
  await expect(needs(misty, mistyName)).toBeVisible();
  await expect(misty.getByRole("main")).not.toContainText("Asked");
  await expect(misty.getByRole("main")).not.toContainText("agreed to lend");
});

test("editing the same Deck to a card a request already waits on shows the request with the new line", async ({
  page,
  collectors,
}) => {
  const { ids, misty, deck, deckName } = await lending(page, collectors, 2, 2);
  const alternate = ids["PAL 254"];
  await hold(misty, await unsorted(misty), alternate, 1);
  // Asked for a card the Deck List doesn't name yet: nothing shows for it.
  await request(page, misty, alternate, 1, deck);

  await page.goto(`${ORIGIN}/decks/${deck}`);
  await page.getByRole("button", { name: "Ways to get missing cards" }).click();
  const panel = page.getByRole("region", { name: "Ways to get missing cards" });
  const lines = panel.getByRole("list", { name: `What ${deckName} needs` });
  await expect(lines).toContainText("2 of 2");
  await expect(lines).not.toContainText("Asked Misty W");

  // The Deck List gains the card elsewhere and the builder hears of it (the in-app signal Replace list's Undo uses):
  // its pins move, the panel reads the Want List again, and the pending read follows the same pins.
  await setLine(page, deck, alternate, 1);
  const reread = page.waitForResponse((response) => isPending(response.url()));
  await page.evaluate((id) => {
    window.dispatchEvent(
      new CustomEvent("prizecheck:deck-list-changed", { detail: id })
    );
  }, deck);
  await reread;
  await expect(lines).toContainText("Asked Misty W for 1");
  await expect(lines).toContainText("1 of 1");
});
