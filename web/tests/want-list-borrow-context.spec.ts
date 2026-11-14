import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import {
  expect,
  test as base,
  type OtherCollectorOptions,
  type OtherCollector,
} from "./support/collectors";
import {
  accountId,
  api,
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

// Borrow context on the Want List (Opus m4 F-M1; owner: warn and allow). All Decks shows each Deck's pending requests
// under its section and offers only the remainder; a chip under a section starts the draft For that Deck; the Borrow
// Request composer warns, without blocking, before asking a Friend again for a Card Edition an open request already
// covers, whatever that request's Deck. All Decks reads the borrower-wide GET /api/loans/waiting; the Get from Friends
// view starts a draft For the card's one Deck, otherwise No Deck. Misty W lends Iono PAL 185 and Boss's Orders PAL 172
// (the Swap catalog); she signs in first, so the test's own page signs in afterwards as Ash K.

const test = base.extend<object, { catalog: ReturnType<typeof seedCatalog> }>({
  catalog: [
    async ({}, use) => {
      await use(seedCatalog());
    },
    { scope: "worker" },
  ],
});
let catalog: ReturnType<typeof seedCatalog>;
test.beforeAll(async ({ catalog: seeded }) => {
  catalog = seeded;
});

const isWaiting = (url: string) => url.includes("/api/loans/waiting");
const isPending = (url: string) => url.includes("/api/loans/pending");
const needs = (page: Page, deckName: string) =>
  page.getByRole("list", { name: `What ${deckName} needs` });
const tray = (page: Page) =>
  page.getByRole("region", { name: "Borrow Request drafts" });
const composer = (page: Page) =>
  page.getByRole("dialog", { name: "Borrow Request to Misty W" });
const asks = /^(Borrow from|Ask for .* more from) Misty W/;
const borrowFrom = /^Borrow from Misty W/;
const WARNING =
  "Some of these cards are already asked for. Sending asks Misty W again.";

async function review(page: Page) {
  await tray(page)
    .getByRole("button", { name: "Review Borrow Request to Misty W" })
    .click();
  await expect(composer(page)).toBeVisible();
  return composer(page);
}

async function setup(
  page: Page,
  collectors: {
    signIn: (options?: OtherCollectorOptions) => Promise<OtherCollector>;
  },
  held: { iono: number; boss?: number; arven?: number }
) {
  const iono = catalog["PAL 185"];
  const boss = catalog["PAL 172"];
  const arven = catalog["SVI 166"];
  const misty = await collectors.signIn({ next: "/decks" });
  await nameCollector(misty.page, "Misty W");
  const place = await unsorted(misty.page);
  await hold(misty.page, place, iono, held.iono);
  if (held.boss) await hold(misty.page, place, boss, held.boss);
  if (held.arven) await hold(misty.page, place, arven, held.arven);
  await page.route(/^https:\/\/assets\.tcgdex\.net\//, (route) =>
    route.abort()
  );
  await signInAsOwner(page, "/decks");
  await nameCollector(page, "Ash K");
  await befriend(page, misty.page);
  return { iono, boss, arven, misty: misty.page };
}

async function deckWith(
  page: Page,
  label: string,
  lines: [string, number][]
): Promise<{ id: string; name: string }> {
  const name = `${label} ${randomUUID().slice(0, 6)}`;
  const id = await createDeck(page, name);
  for (const [edition, quantity] of lines)
    await setLine(page, id, edition, quantity);
  return { id, name };
}

async function request(
  borrower: Page,
  lender: Page,
  edition: string,
  copies: number,
  deckId: string | null
) {
  await api(borrower, "POST", "/api/loans", {
    lender_id: await accountId(lender),
    lines: [{ edition_id: edition, quantity: String(copies) }],
    ...(deckId ? { deck_id: deckId } : {}),
    idempotency_key: randomUUID(),
  });
}

async function openAllDecks(page: Page) {
  const waiting = page.waitForResponse((response) => isWaiting(response.url()));
  await page.goto(`${ORIGIN}/decks/want-list`);
  await waiting;
}

async function friendsView(page: Page) {
  await page
    .getByRole("radiogroup", { name: "Show the Want List as" })
    .getByRole("radio", { name: "Get from Friends" })
    .click();
}

/** Get from Friends on All Decks: Ask to borrow one card from Misty W. */
const askCard = (page: Page, card: string) =>
  page
    .getByRole("region", { name: card })
    .getByRole("button", { name: `Ask to borrow ${card} from Misty W` })
    .click();

async function waitingLines(page: Page) {
  return (await api(page, "GET", "/api/loans/waiting")).lines as {
    deck_id: string | null;
    copies: string;
  }[];
}

/** The F-M1 flow: a request of 2 For A, then "Ask for 1 more" under A, up to the composer's warning. */
async function askAgain(page: Page, collectors: Parameters<typeof setup>[1]) {
  const { iono, misty } = await setup(page, collectors, { iono: 3 });
  const a = await deckWith(page, "Charizard ex", [[iono, 3]]);
  await request(page, misty, iono, 2, a.id);
  await openAllDecks(page);
  await expect(needs(page, a.name)).toContainText("Asked Misty W for 2");
  await needs(page, a.name)
    .getByRole("button", { name: /^Ask for 1 more from Misty W/ })
    .click();
  const draft = await review(page);
  await expect(draft.getByLabel("For Deck")).toHaveValue(a.id);
  await expect(draft).toContainText(`Asked Misty W for 2 · ${a.name}`);
  await expect(draft).toContainText(WARNING);
  return { draft, a, iono };
}

test.describe("desktop", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("All Decks shows each Deck's own requests under its section and offers only the remainder", async ({
    page,
    collectors,
  }) => {
    const { iono, misty } = await setup(page, collectors, { iono: 3 });
    const a = await deckWith(page, "Charizard ex", [[iono, 3]]);
    const b = await deckWith(page, "Gardevoir ex", [[iono, 2]]);
    await request(page, misty, iono, 3, a.id);
    await openAllDecks(page);
    await expect(needs(page, a.name)).toContainText("Asked Misty W for 3");
    await expect(
      needs(page, a.name).getByRole("button", { name: asks })
    ).toHaveCount(0);
    await expect(needs(page, b.name)).not.toContainText("Asked Misty W");
    await expect(
      needs(page, b.name).getByRole("button", { name: borrowFrom })
    ).toBeVisible();
  });

  test("a section's Ask starts the draft For its Deck and the composer warns before asking again", async ({
    page,
    collectors,
  }) => {
    const { draft, a } = await askAgain(page, collectors);
    const send = draft.getByRole("button", { name: "Send Borrow Request" });
    await expect(send).toBeEnabled();
    await send.click();
    await expect(draft).toBeHidden();
    await expect(
      page.getByRole("region", { name: "Notifications" })
    ).toContainText("Borrow Request sent to Misty W.");
    await expect(needs(page, a.name)).toContainText(
      "Asked Misty W for 2 · Asked Misty W for 1"
    );
    const lines = await waitingLines(page);
    expect(lines).toHaveLength(2);
    expect(lines.every((line) => line.deck_id === a.id)).toBe(true);
  });

  test("an earlier request to Unsorted shows under no Deck, but the composer still warns", async ({
    page,
    collectors,
  }) => {
    const { iono, misty } = await setup(page, collectors, { iono: 3 });
    const a = await deckWith(page, "Charizard ex", [[iono, 3]]);
    await request(page, misty, iono, 2, null);
    await openAllDecks(page);
    await expect(needs(page, a.name)).not.toContainText("Asked");
    await needs(page, a.name).getByRole("button", { name: borrowFrom }).click();
    const draft = await review(page);
    await expect(draft.getByLabel("For Deck")).toHaveValue(a.id);
    await expect(draft).toContainText("Asked Misty W for 2 · Unsorted");
    await draft.getByRole("button", { name: "Send Borrow Request" }).click();
    await expect(
      page.getByRole("region", { name: "Notifications" })
    ).toContainText("Borrow Request sent to Misty W.");
    const lines = await waitingLines(page);
    expect(lines.filter((line) => line.deck_id === null)).toHaveLength(1);
    expect(lines.filter((line) => line.deck_id === a.id)).toHaveLength(1);
  });

  test("a failed check for earlier requests still lets the collector send", async ({
    page,
    collectors,
  }) => {
    const { iono, misty } = await setup(page, collectors, { iono: 3 });
    const a = await deckWith(page, "Charizard ex", [[iono, 3]]);
    await request(page, misty, iono, 2, null);
    const pending = page.waitForResponse(
      (response) =>
        isPending(response.url()) &&
        new URL(response.url()).searchParams.get("deck") === a.id
    );
    await page.goto(`${ORIGIN}/decks/want-list?deck=${a.id}`);
    await pending;
    await page.route("**/api/loans/waiting", (route) =>
      route.fulfill({ status: 500 })
    );
    await needs(page, a.name).getByRole("button", { name: borrowFrom }).click();
    const draft = await review(page);
    await expect(draft).toContainText(
      "Couldn't check what you've already asked Misty W for."
    );
    await expect(
      draft.getByRole("button", { name: "Send Borrow Request" })
    ).toBeEnabled();
    await page.unroute("**/api/loans/waiting");
    await draft
      .getByRole("button", { name: "Retry checking earlier requests" })
      .click();
    await expect(draft).toContainText("Asked Misty W for 2 · Unsorted");
    await expect(draft).toContainText(WARNING);
  });

  test("a Get from Friends card one Deck needs starts the draft For that Deck, and one several Decks need starts it with No Deck", async ({
    page,
    collectors,
  }) => {
    const { iono, boss, misty } = await setup(page, collectors, {
      iono: 3,
      boss: 1,
    });
    void misty;
    const a = await deckWith(page, "Charizard ex", [
      [iono, 2],
      [boss, 1],
    ]);
    await deckWith(page, "Gardevoir ex", [[iono, 1]]);
    await openAllDecks(page);
    await friendsView(page);
    await page
      .getByRole("region", { name: "Boss's Orders" })
      .getByRole("button", { name: "Ask to borrow Boss's Orders from Misty W" })
      .click();
    let draft = await review(page);
    await expect(draft.getByLabel("For Deck")).toHaveValue(a.id);
    await draft.getByRole("button", { name: "Discard" }).click();
    await page
      .getByRole("region", { name: "Iono" })
      .getByRole("button", { name: "Ask to borrow Iono from Misty W" })
      .click();
    draft = await review(page);
    await expect(draft.getByLabel("For Deck")).toHaveValue("");
    await draft.getByRole("button", { name: "Discard" }).click();
  });

  // Owner correction (Revision 4): For Deck follows every card in the draft. It used to keep the first card's guess.
  test("a card several Decks need joins a draft and leaves it with No Deck until the collector chooses", async ({
    page,
    collectors,
  }) => {
    const { iono, boss } = await setup(page, collectors, { iono: 3, boss: 1 });
    await deckWith(page, "Charizard ex", [
      [iono, 2],
      [boss, 1],
    ]);
    await deckWith(page, "Gardevoir ex", [[iono, 1]]);
    await openAllDecks(page);
    await friendsView(page);
    await askCard(page, "Boss's Orders");
    await askCard(page, "Iono");
    const draft = await review(page);
    await expect(
      draft.getByRole("list", { name: "Cards to borrow" }).getByRole("listitem")
    ).toHaveCount(2);
    await expect(draft.getByLabel("For Deck")).toHaveValue("");
  });

  test("two cards with the same one Deck go For that Deck, and different one Decks go For none", async ({
    page,
    collectors,
  }) => {
    const { boss, arven } = await setup(page, collectors, {
      iono: 1,
      boss: 1,
      arven: 1,
    });
    const a = await deckWith(page, "Charizard ex", [
      [boss, 1],
      [arven, 1],
    ]);
    await deckWith(page, "Gardevoir ex", [[catalog["PAL 185"], 1]]);
    await openAllDecks(page);
    await friendsView(page);
    await askCard(page, "Boss's Orders");
    await askCard(page, "Arven");
    let draft = await review(page);
    await expect(draft.getByLabel("For Deck")).toHaveValue(a.id);
    await draft.getByRole("button", { name: "Discard" }).click();
    await page.reload();
    await friendsView(page);
    await askCard(page, "Iono");
    await askCard(page, "Boss's Orders");
    draft = await review(page);
    await expect(draft.getByLabel("For Deck")).toHaveValue("");
  });

  test("a chosen Deck or No Deck is kept as cards change, and the default returns when the odd card goes", async ({
    page,
    collectors,
  }) => {
    const { iono, boss, arven } = await setup(page, collectors, {
      iono: 3,
      boss: 1,
      arven: 1,
    });
    const a = await deckWith(page, "Charizard ex", [
      [iono, 2],
      [boss, 1],
      [arven, 1],
    ]);
    const b = await deckWith(page, "Gardevoir ex", [[iono, 1]]);
    await openAllDecks(page);
    await friendsView(page);
    await askCard(page, "Boss's Orders");
    let draft = await review(page);
    await expect(draft.getByLabel("For Deck")).toHaveValue(a.id);
    // A manual choice of a Deck stays when a card that would otherwise make it No Deck joins, and after a reload.
    await draft.getByLabel("For Deck").selectOption(b.id);
    await draft.getByRole("button", { name: "Keep draft" }).click();
    await askCard(page, "Iono");
    await page.reload();
    draft = await review(page);
    await expect(draft.getByLabel("For Deck")).toHaveValue(b.id);
    // A manual No Deck stays when another card with the same one Deck joins.
    await draft.getByLabel("For Deck").selectOption("");
    await draft.getByRole("button", { name: "Keep draft" }).click();
    await friendsView(page);
    await askCard(page, "Arven");
    draft = await review(page);
    await expect(draft.getByLabel("For Deck")).toHaveValue("");
    await draft.getByRole("button", { name: "Discard" }).click();

    // With no choice, taking the card several Decks need out of the draft brings the Deck back.
    await askCard(page, "Boss's Orders");
    await askCard(page, "Iono");
    draft = await review(page);
    await expect(draft.getByLabel("For Deck")).toHaveValue("");
    await draft.getByRole("button", { name: /^Remove Iono/ }).click();
    await expect(draft.getByLabel("For Deck")).toHaveValue(a.id);
  });

  test("Get from Friends on All Decks shows what is already asked for and offers only the remainder", async ({
    page,
    collectors,
  }) => {
    const { iono, boss, misty } = await setup(page, collectors, {
      iono: 3,
      boss: 1,
    });
    const a = await deckWith(page, "Charizard ex", [
      [iono, 2],
      [boss, 1],
    ]);
    await deckWith(page, "Gardevoir ex", [[iono, 1]]);
    await request(page, misty, iono, 2, a.id);
    await openAllDecks(page);
    await friendsView(page);
    const card = page.getByRole("region", { name: "Iono" });
    await expect(card).toContainText("Asked Misty W for 2");
    await card
      .getByRole("button", { name: "Ask to borrow Iono from Misty W" })
      .click();
    const draft = await review(page);
    await expect(
      draft.getByRole("button", { name: /^Increase Copies of Iono/ })
    ).toBeDisabled();
    await expect(draft).toContainText(`Asked Misty W for 2 · ${a.name}`);
  });

  test("a covered card under one Deck still sends when asked for under another", async ({
    page,
    collectors,
  }) => {
    const { iono, boss, misty } = await setup(page, collectors, {
      iono: 3,
      boss: 1,
    });
    const a = await deckWith(page, "Charizard ex", [
      [iono, 3],
      [boss, 1],
    ]);
    const b = await deckWith(page, "Gardevoir ex", [[iono, 2]]);
    await request(page, misty, iono, 3, a.id);
    await openAllDecks(page);
    await needs(page, a.name)
      .getByRole("list", { name: "Friends who can lend Boss's Orders" })
      .getByRole("button", { name: borrowFrom })
      .click();
    await needs(page, b.name).getByRole("button", { name: borrowFrom }).click();
    const draft = await review(page);
    // Boss's Orders names Charizard and Iono's chip names Gardevoir, so no one Deck: the collector chooses Charizard.
    await expect(draft.getByLabel("For Deck")).toHaveValue("");
    await draft.getByLabel("For Deck").selectOption(a.id);
    await expect(draft).toContainText(`Asked Misty W for 3 · ${a.name}`);
    const send = draft.getByRole("button", { name: "Send Borrow Request" });
    await expect(send).toBeEnabled();
    await send.click();
    await expect(
      page.getByRole("region", { name: "Notifications" })
    ).toContainText("Borrow Request sent to Misty W.");
  });
});

test.describe("phone", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("a card several Decks need leaves the draft with No Deck", async ({
    page,
    collectors,
  }) => {
    const { iono, boss } = await setup(page, collectors, { iono: 3, boss: 1 });
    await deckWith(page, "Charizard ex", [
      [iono, 2],
      [boss, 1],
    ]);
    await deckWith(page, "Gardevoir ex", [[iono, 1]]);
    await openAllDecks(page);
    await friendsView(page);
    await askCard(page, "Boss's Orders");
    await askCard(page, "Iono");
    const draft = await review(page);
    await expect(draft.getByLabel("For Deck")).toHaveValue("");
  });

  test("the warning and Send fit the screen and the page does not scroll sideways", async ({
    page,
    collectors,
  }) => {
    const { draft, a } = await askAgain(page, collectors);
    const send = draft.getByRole("button", { name: "Send Borrow Request" });
    await send.scrollIntoViewIfNeeded();
    await expect(draft.getByText(WARNING)).toBeVisible();
    await expect(send).toBeInViewport();
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth - window.innerWidth
        )
      )
      .toBeLessThanOrEqual(0);
    await draft.getByRole("button", { name: "Keep draft" }).click();
    await expect(needs(page, a.name)).toContainText("Asked Misty W for 2");
  });
});
