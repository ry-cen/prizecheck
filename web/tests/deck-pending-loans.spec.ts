import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import {
  expect,
  test as base,
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

// Expensive catalog import and multi-account sign-in have setup budgets, separate from behavior assertions.
const test = base.extend<
  {
    loanQuantities: [number, number];
    prepared: Awaited<ReturnType<typeof lending>>;
  },
  { catalog: ReturnType<typeof seedCatalog> }
>({
  catalog: [
    async ({}, use) => {
      await use(seedCatalog());
    },
    { scope: "worker", timeout: 60_000 },
  ],
  loanQuantities: [[2, 2], { option: true }],
  prepared: [
    async ({ page, collectors, loanQuantities }, use) => {
      await use(await lending(page, collectors, ...loanQuantities));
    },
    { timeout: 60_000 },
  ],
});
let catalog: ReturnType<typeof seedCatalog>;
test.beforeAll(async ({ catalog: seeded }) => {
  catalog = seeded;
});

// What a Deck is waiting on from Friends (GET /api/loans/pending, design docs/planning/social-network/
// want-list-pending-loans.md): under each needed line, the copies asked for and the copies a Friend agreed to lend,
// beside the counts and never taken off them. It is read apart from the Want List and again on window focus, the page
// becoming visible, the inbox pulse moving, Loans changing outside the Loans tab and a request this tab sent. It is not
// live: Loan commands move the thread pulse; a Deck List change on another device waits for focus.
//
// Misty W lends (another collector, signed in first); the test's page is Ash K, signing in afterwards as a new
// account. A call through `page.request` stands for another device: it shares the account but tells the tab nothing.

const isPulse = (url: string) => url.includes("/api/threads/pulse");
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
  const ids = catalog;
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
  // Complete the cold Want List load in prepared's existing setup budget.
  await openScoped(page, deck);
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
  loanStep(lender, loan, "accept", {
    lines: [{ edition_id: edition, promised: String(copies) }],
  });

/** Opens the Want List on one Deck and waits for that Deck's pending read. */
async function openScoped(page: Page, deck: string) {
  const pending = page.waitForResponse(
    (response) =>
      isPending(response.url()) &&
      new URL(response.url()).searchParams.get("deck") === deck
  );
  await page.goto(`${ORIGIN}/decks/want-list?deck=${deck}`);
  await pending;
}

test("a Borrow Request sent from the Want List shows under its line without a reload", async ({
  page,
  prepared,
}) => {
  const { deck, deckName } = prepared;
  const lines = needs(page, deckName);
  await expect(lines).toContainText("2 of 2");
  await expect(lines).not.toContainText("Asked Misty W");

  await lines
    .getByRole("list", { name: "Friends who can lend Iono" })
    .getByRole("button", { name: /^Borrow from Misty W · / })
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
  await expect(lines).toContainText("Asked Misty W for 2");
  await expect(
    lines.getByRole("button", { name: /^Borrow from Misty W/ })
  ).toHaveCount(0);
  // Information only: the line still needs both copies.
  await expect(lines).toContainText("2 of 2");
  const toast = page.getByRole("region", { name: "Notifications" });
  await expect(toast).toContainText("Borrow Request sent to Misty W.");
  await toast.getByRole("button", { name: "View", exact: true }).click();
  await expect(page).toHaveURL(/\/loans\/[0-9a-f-]+$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "You asked Misty W for 2 cards"
  );
});

test.describe("answer after a partial acceptance", () => {
  test.use({ loanQuantities: [3, 3] });
  test("a Friend's answer from their own device shows once the inbox pulse moves", async ({
    page,
    prepared,
  }) => {
    const { iono, misty, deck, deckName } = prepared;
    const loan = await request(page, misty, iono, 2, deck);
    await page.clock.install();
    await openScoped(page, deck);
    const lines = needs(page, deckName);
    await expect(lines).toContainText("Asked Misty W for 2");

    await lines
      .getByRole("button", { name: /^Ask for 1 more from Misty W/ })
      .click();
    await page
      .getByRole("button", { name: "Review Borrow Request to Misty W" })
      .click();
    const before = page.getByRole("dialog", {
      name: "Borrow Request to Misty W",
    });
    await expect(
      before.getByRole("button", { name: /^Increase Copies of Iono,/ })
    ).toBeDisabled();
    await before.getByRole("button", { name: "Keep draft" }).click();

    // A partial accept stores an inbox update for Ash, which moves the pulse; no focus is needed.
    await accept(misty, loan, iono, 1);
    const reread = page.waitForResponse((response) =>
      isPending(response.url())
    );
    await page.clock.runFor(61_000);
    await reread;
    await expect(lines).toContainText("Misty W agreed to lend 1");
    await expect(lines).not.toContainText("Asked Misty W");
    await expect(lines).toContainText("3 of 3");
    const selected = lines.getByRole("button", {
      name: /^Ask for 1 more from Misty W/,
    });
    await expect(selected).toBeVisible();
    await expect(selected).toHaveAttribute("aria-pressed", "true");
    // A previously capped draft keeps its quantity, but can now increase to the fresh cap.
    await page
      .getByRole("button", { name: "Review Borrow Request to Misty W" })
      .click();
    const existing = page.getByRole("dialog", {
      name: "Borrow Request to Misty W",
    });
    await expect(
      existing.getByRole("button", { name: /^Increase Copies of Iono,/ })
    ).toBeEnabled();
    await existing
      .getByRole("button", { name: /^Increase Copies of Iono,/ })
      .click();
    await expect(
      existing.getByRole("button", { name: /^Increase Copies of Iono,/ })
    ).toBeDisabled();
    await existing
      .getByRole("button", { name: "Discard", exact: true })
      .click();
    const remainder = lines.getByRole("button", {
      name: /^Ask for 2 more from Misty W/,
    });
    await expect(remainder).toHaveAttribute("aria-pressed", "false");
    await remainder.click();
    await page
      .getByRole("button", { name: "Review Borrow Request to Misty W" })
      .click();
    const draft = page.getByRole("dialog", {
      name: "Borrow Request to Misty W",
    });
    await expect(
      draft.getByRole("button", { name: /^Increase Copies of Iono,/ })
    ).toBeDisabled();
    await expect(
      draft.getByRole("list", { name: "Cards to borrow" })
    ).toContainText("2");
  });
});

test("a write-off moves the thread pulse and refreshes pending quantities without focus", async ({
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

  const beforePulse = await api(page, "GET", "/api/threads/pulse");
  await loanStep(misty, loan, "handover");
  await loanStep(misty, loan, "write-off", {
    lines: [{ edition_id: iono, quantity: "1" }],
  });
  // Every Loan command touches its item, including a write-off with no inbox update.
  const afterPulse = await api(page, "GET", "/api/threads/pulse");
  expect(afterPulse.watermark).not.toBe(beforePulse.watermark);
  const pulse = page.waitForResponse((response) => isPulse(response.url()));
  const reread = page.waitForResponse((response) => isPending(response.url()));
  await page.clock.runFor(61_000);
  await Promise.all([pulse, reread]);
  await expect(lines).toContainText("Misty W agreed to lend 2");
  await expect(lines).toContainText("3 of 3");
});

test("a Deck List change on another device refreshes pending Loans at focus without a thread signal or new Want List pins", async ({
  page,
  collectors,
}) => {
  const { iono, misty, deck, deckName } = await lending(page, collectors, 3, 3);
  await request(page, misty, iono, 3, deck);
  await page.clock.install();
  const initialCost = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/want-list/cost"
  );
  await openScoped(page, deck);
  await (await initialCost).finished();
  const lines = needs(page, deckName);
  await expect(lines).toContainText("Asked Misty W for 3");
  await expect(lines).toContainText("3 of 3");
  const before = await api(page, "GET", "/api/threads/pulse");
  // This changes only the Deck List, not the agreement or its waiting step.
  await setLine(page, deck, iono, 0);
  expect((await api(page, "GET", "/api/threads/pulse")).watermark).toBe(
    before.watermark
  );
  const pulse = page.waitForResponse((response) => isPulse(response.url()));
  await page.clock.runFor(61_000);
  await pulse;
  await expect(lines).toContainText("Asked Misty W for 3");

  let wantReads = 0;
  const wantRead = /\/api\/want-list\?deck=/;
  await page.route(wantRead, (route) => {
    wantReads++;
    return route.continue();
  });
  const reread = page.waitForResponse((response) => isPending(response.url()));
  await focus(page);
  const fresh = await reread;
  expect((await fresh.json()).lines).toEqual([]);
  // Focus reads pending Loans independently. No new Want List or pins arrived.
  await expect(lines).toContainText("3 of 3");
  await expect(lines).not.toContainText("Asked Misty W");
  expect(wantReads).toBe(0);
});

test("receiving the copies on another device clears the line's pending note at the next focus", async ({
  page,
  collectors,
}) => {
  const { iono, misty, deck, deckName } = await lending(page, collectors, 2, 3);
  const loan = await request(page, misty, iono, 2, deck);
  await accept(misty, loan, iono, 2);
  await loanStep(misty, loan, "handover");
  await page.clock.install();
  await openScoped(page, deck);
  const lines = needs(page, deckName);
  await expect(lines).toContainText("Misty W agreed to lend 2");

  // Ash's other device confirms the copies arrived: they are Borrowed Copies now, not on their way.
  await loanStep(page, loan, "handover");
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

test("the missing-cards panel offers only the remainder after asking and no duplicate when covered", async ({
  page,
  collectors,
}) => {
  const { iono, misty, deck, deckName } = await lending(page, collectors, 2, 2);
  await request(page, misty, iono, 1, deck);
  await page.goto(`${ORIGIN}/decks/${deck}`);
  await page.getByRole("button", { name: "Ways to get missing cards" }).click();
  const panel = page.getByRole("region", { name: "Ways to get missing cards" });
  await expect(panel).toContainText("Asked Misty W for 1");
  await panel
    .getByRole("button", { name: /^Ask for 1 more from Misty W/ })
    .click();
  await page
    .getByRole("button", { name: "Review Borrow Request to Misty W" })
    .click();
  const composer = page.getByRole("dialog", {
    name: "Borrow Request to Misty W",
  });
  await expect(composer.getByLabel("For Deck")).toHaveValue(deck);
  await composer.getByRole("button", { name: "Send Borrow Request" }).click();
  await expect(panel).toContainText(
    "Asked Misty W for 1 · Asked Misty W for 1"
  );
  await expect(
    panel.getByRole("button", {
      name: /^(Borrow from|Ask for .* more from) Misty W/,
    })
  ).toHaveCount(0);
  const toast = page.getByRole("region", { name: "Notifications" });
  await expect(toast).toContainText("Borrow Request sent to Misty W.");
  await test.info().attach("missing-cards-panel-after", {
    body: await panel.innerText(),
    contentType: "text/plain",
  });
  await toast.getByRole("button", { name: "View", exact: true }).click();
  await expect(page).toHaveURL(/\/loans\/[0-9a-f-]+$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "You asked Misty W for 1 card"
  );
});

test.describe("different acceptable Editions", () => {
  test.use({ loanQuantities: [2, 4] });
  test("requests for Edition A do not consume Edition B from the same Friend", async ({
    page,
    prepared,
  }) => {
    const { ids, iono, misty, deck, deckName } = prepared;
    await hold(misty, await unsorted(misty), ids["PAL 254"], 2);
    await request(page, misty, iono, 2, deck);
    await openScoped(page, deck);
    const line = needs(page, deckName);
    await line
      .getByRole("radiogroup", { name: /^Will accept for Iono/ })
      .getByRole("radio", { name: "Any card with the same name" })
      .check();
    const offers = line
      .getByRole("list", { name: "Friends who can lend Iono" })
      .getByRole("button");
    await expect(offers).toHaveCount(1);
    await expect(offers).toContainText("Ask for 2 more from Misty W");
    await expect(offers).toContainText("PAL 254");
    await offers.click();
    await page
      .getByRole("button", { name: "Review Borrow Request to Misty W" })
      .click();
    const draft = page.getByRole("dialog", {
      name: "Borrow Request to Misty W",
    });
    await expect(
      draft.getByRole("list", { name: "Cards to borrow" })
    ).toContainText("PAL 254");
    await expect(
      draft.getByRole("button", { name: /^Increase Copies of Iono,/ })
    ).toBeDisabled();
  });
});
