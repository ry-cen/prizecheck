// Ticket #280 (Trading spec "Testing Decisions", Browser): the whole Stage 1 trade between two Friends, in the browser.
// Ash marks a binder For trade. Misty uses Ask to trade from the card popup, then proposes from the two-way row on Find
// trades: cash only is refused until Ash turns on Open to cash offers, then goes through. Ash counters with a card and
// less cash, Misty accepts, and each confirms the swap into a place they choose, Ash with a Deck switch. Ownership has
// moved on both sides, as Collection, the Trade Lists, Misty's Deck and her Trade Wants show. Every Trade screen passes
// the page checks and the UI copy rule. Ash signs in first, the test's page is Misty, at desktop width and at 375 px.
// The catalog is the Swap catalog (api/tests/want_list_swap_fixtures.py).
import { randomInt, randomUUID } from "node:crypto";
import type {
  BrowserContextOptions,
  Locator,
  Page,
  Response,
} from "@playwright/test";
import { expect, test } from "./support/collectors";
import {
  api,
  befriend,
  createDeck,
  hold,
  ORIGIN,
  seedCatalog,
  setLine,
} from "./support/loans";
import { expectPageChecks } from "./support/page-check";
import { signInAsOwner } from "./support/sign-in";
import {
  bodyOf,
  DESKTOP_SIZE,
  forTradeLeaf,
  PHONE_SIZE,
} from "./support/trades";

/** Gives the signed-in collector this Display Name and a new Handle, and returns the Handle. */
async function nameCollector(page: Page, name: string): Promise<string> {
  // Ten random consonants: never a word the name filter refuses.
  const tail = Array.from(
    { length: 10 },
    () => "bcdfghjklmnpqrstvwxz"[randomInt(20)]
  ).join("");
  const handle = `${name.split(" ")[0].toLowerCase()}_${tail}`;
  await api(page, "PUT", "/api/profile/display-name", {
    display_name: name,
    idempotency_key: randomUUID(),
  });
  await api(page, "PUT", "/api/profile/handle", {
    handle,
    idempotency_key: randomUUID(),
  });
  return handle;
}

/** A top-level Storage Leaf that is not For trade; returns its id. */
async function storageLeaf(page: Page, name: string): Promise<string> {
  const created = await api(page, "POST", "/api/location-tree", {
    name,
    parent_id: null,
    parent_version: null,
    idempotency_key: randomUUID(),
  });
  return (created.location as { id: string }).id;
}

/** The Deck's lines through the API, as { edition: quantity }. */
async function deckLines(on: Page, deck: string) {
  return Object.fromEntries(
    (
      (await api(on, "GET", `/api/decks/${deck}`)).deck_list.lines as {
        edition_id: string;
        quantity: string;
      }[]
    ).map((item) => [item.edition_id, item.quantity])
  );
}

const heading = (page: Page) => page.getByRole("heading", { level: 1 });
const toast = (page: Page) =>
  page.getByRole("region", { name: "Notifications" });
const isPhone = (page: Page) => (page.viewportSize()?.width ?? 1280) <= 760;

/** On a phone, selects the builder's pane (the other one is hidden, so out of the accessibility tree). */
async function show(page: Page, pane: "Proposal" | "Cards") {
  if (!isPhone(page)) return;
  await page
    .getByRole("tablist", { name: "Proposal builder" })
    .getByRole("tab", {
      name: pane === "Cards" ? "Cards" : /^Proposal/,
      exact: pane === "Cards",
    })
    .click();
}

/** The library tile that adds `card` (a regex fragment such as "Arven, SVI 166, .+?, Normal") to You get or You give. */
const tile = (scope: Locator, side: "get" | "give", card: string) =>
  scope.getByRole("button", {
    name: new RegExp(`^Add to You ${side}, ${card}, `),
  });
const group = (page: Page, name: string | RegExp) =>
  page.getByRole("group", { name });
const noArtwork = (page: Page) =>
  page.route(/^https:\/\/assets\.tcgdex\.net\//, (route) => route.abort());
const results = (page: Page) =>
  page.getByRole("region", { name: "Catalog results" });
const region = (page: Page, name: "You get" | "You give" | "Cash") =>
  page.getByRole("main").getByRole("region", { name, exact: true });
const bell = (on: Page) => on.getByRole("button", { name: /^Inbox/ });
const drawer = (on: Page) => on.getByRole("dialog", { name: "Inbox" });
const waitingOn = (on: Page) =>
  drawer(on).getByRole("region", { name: "Waiting on you" }).getByRole("link");
const earlierOn = (on: Page) =>
  drawer(on).getByRole("region", { name: "Earlier" });
const confirmDialog = (page: Page, other: string) =>
  page.getByRole("dialog", { name: `Confirm swap with ${other}?` });
const NOTICE = "only records the cash amount you agree on";

/** Opens the Manage locations panel from the sidebar, or on a phone from the Locations drawer. */
async function openManageLocations(on: Page) {
  if (!isPhone(on)) {
    await on
      .getByRole("complementary", { name: "Sidebar" })
      .getByRole("button", { name: "Manage locations", exact: true })
      .click();
    return;
  }
  await on
    .getByRole("banner")
    .getByRole("button", { name: "Open locations", exact: true })
    .click();
  const locations = on.getByRole("dialog", { name: "Locations", exact: true });
  await locations
    .getByRole("button", { name: "Manage locations", exact: true })
    .click();
  await expect(locations).toBeHidden();
}

// The UI copy rule (AGENTS.md): no data-source or provenance name, no fetch, check or refresh wording, no record id,
// and nothing of the other collector's Locations or Decks. Inbox event times ("just now", "5 hours ago") are allowed.
const PROVENANCE =
  /TCGdex|TCGplayer|Cardmarket|\b(?:fetched|checked|refreshed|cached|last updated|as of)\b/i;
const RECORD_ID =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
async function expectCollectorCopy(scope: Locator, otherPlaces: string) {
  await expect(scope).not.toContainText(PROVENANCE);
  await expect(scope).not.toContainText(RECORD_ID);
  await expect(scope).not.toContainText(otherPlaces);
}

/** The whole story at one size. Ash (the other context) signs in first; the test's page is Misty. */
async function story(
  page: Page,
  collectors: {
    signIn: (options?: {
      next?: string;
      contextOptions?: BrowserContextOptions;
    }) => Promise<{ page: Page }>;
  },
  contextOptions: BrowserContextOptions,
  width: string
) {
  // S0. Setup, through the API.
  const ids = seedCatalog();
  const arven = ids["SVI 166"];
  const iono = ids["PAL 185"];
  const ionoAlt = ids["PAL 254"];
  const ashPlace = `Pallet ${randomUUID().slice(0, 6)}`;
  const mistyPlace = `Cerulean ${randomUUID().slice(0, 6)}`;
  const ash = await collectors.signIn({ contextOptions });
  const ashHandle = await nameCollector(ash.page, "Ash K");
  const binder = await storageLeaf(ash.page, `${ashPlace} Binder`);
  const box = await storageLeaf(ash.page, `${ashPlace} Box`);
  await hold(ash.page, binder, arven, 3);
  const ashDeck = await createDeck(ash.page, `${ashPlace} Deck`);
  await setLine(ash.page, ashDeck, ionoAlt, 1);
  await api(ash.page, "PUT", `/api/trade-wants/will-accept/${ionoAlt}`, {
    rule: "identity",
  });

  await noArtwork(page);
  await noArtwork(ash.page);
  await signInAsOwner(page, "/collection");
  const mistyHandle = await nameCollector(page, "Misty W");
  const shelf = await forTradeLeaf(page, `${mistyPlace} Shelf`);
  await hold(page, shelf, iono, 3);
  const mistyDeck = await createDeck(page, `${mistyPlace} Deck`);
  await api(page, "PUT", `/api/trade-wants/${arven}`, { quantity: "3" });
  await befriend(page, ash.page);
  // Everything about Trades that reaches either browser, to check it never names the other side's Locations.
  // Chromium keeps no body for a read the app aborted (a Deck switch reload); only that error is allowed, and each side must still read its Trade.
  const answers: {
    body: Promise<string | null>;
    secretOf: string[];
    against: string;
    url: string;
  }[] = [];
  const listeners = (
    [
      [ash.page, [mistyPlace, shelf, mistyDeck]],
      [page, [ashPlace, binder, box, ashDeck]],
    ] as const
  ).map(([who, theirs]) => {
    const listener = (response: Response) => {
      if (/\/api\/(social\/)?trade/.test(response.url()))
        answers.push({
          body: bodyOf(response),
          secretOf: [...theirs],
          against: theirs[0],
          url: response.url(),
        });
    };
    who.on("response", listener);
    return () => who.off("response", listener);
  });

  const main = page.getByRole("main");
  const ashMain = ash.page.getByRole("main");
  const tradeAddress = new RegExp(`^${ORIGIN}/trades/[0-9a-f-]{36}$`);

  // S1. Ash marks his binder For trade.
  await ash.page.goto(`${ORIGIN}/collection`);
  await expect(heading(ash.page)).toHaveText("All owned");
  await expect(
    ashMain.getByText("3 copies · 1 edition", { exact: true })
  ).toBeVisible();
  await openManageLocations(ash.page);
  const panel = ash.page.getByRole("dialog", {
    name: "Manage locations",
    exact: true,
  });
  await panel
    .getByRole("button", {
      name: `Mark ${ashPlace} Binder For trade`,
      exact: true,
    })
    .click();
  await expect(panel.getByRole("status")).toHaveText(
    `${ashPlace} Binder and everything in it, apart from Decks, are For trade.`
  );
  await expect(
    panel.getByRole("button", {
      name: `Mark ${ashPlace} Binder Not for trade`,
      exact: true,
    })
  ).toBeFocused();
  await expectPageChecks(
    ash.page,
    `Manage locations with a binder marked For trade at ${width}`
  );
  await panel
    .getByRole("button", { name: "Close manage locations", exact: true })
    .click();
  await expect(panel).toBeHidden();
  await ash.page.goto(`${ORIGIN}/trades/list`);
  await expect(
    ashMain
      .getByRole("list", { name: `${ashPlace} Binder` })
      .getByRole("listitem")
      .filter({ hasText: "SVI 166" })
  ).toContainText("×3");
  await expectPageChecks(ash.page, `My Trade List at ${width}`);

  // S2. Misty's starting point.
  await page.goto(`${ORIGIN}/collection`);
  await expect(
    main.getByText("3 copies · 1 edition", { exact: true })
  ).toBeVisible();
  await page.goto(`${ORIGIN}/decks/want-list`);
  const arvenWant = (on: Page) =>
    on.getByRole("region", { name: "Trade Wants" }).getByRole("group", {
      name: /^Arven \(Scarlet & Violet · 166 · Normal\)$/,
    });
  await expect(arvenWant(page)).toHaveText("3");

  // S3. Ask to trade from the card popup.
  await page.goto(`${ORIGIN}/catalog`);
  await results(page)
    .getByRole("button", { name: /^Arven, SVI/ })
    .first()
    .click();
  const popup = page.getByRole("dialog", { name: "Arven" });
  const offering = popup.getByRole("list", {
    name: "Friends with this on their Trade List",
  });
  await expect(offering.getByRole("listitem")).toHaveCount(1);
  await expect(offering).toContainText("Ash K");
  await expect(offering).toContainText("×3");
  await expect(offering).not.toContainText(ashPlace);
  await popup
    .getByRole("button", { name: /^Ask Ash K to trade Arven \(SVI 166\)$/ })
    .click();
  await expect(page).toHaveURL(`${ORIGIN}/trades/new/${ashHandle}`);
  await show(page, "Cards");
  await expect(
    page.getByRole("radio", { name: "Their Trade List" })
  ).toBeChecked();
  await show(page, "Proposal");
  await expect(group(page, "Arven (SVI 166) you get")).toContainText("1");
  await page.goBack();
  await expect(page).toHaveURL(`${ORIGIN}/catalog`);
  await expect(
    page.getByRole("dialog", { name: "Discard this proposal to Ash K?" })
  ).toHaveCount(0);

  // S4. Find trades, with the two-way row.
  await page.goto(`${ORIGIN}/trades`);
  await page.getByRole("tab", { name: "Find trades", exact: true }).click();
  await expect(page).toHaveURL(`${ORIGIN}/trades/find`);
  const matches = page.getByRole("list", { name: "Matches" });
  const rows = matches.getByRole("button", { expanded: false });
  await expect(rows).toHaveCount(1);
  await expect(rows.nth(0)).toContainText("Ash K");
  await expect(rows.nth(0)).toContainText("Two-way match");
  await expect(rows.nth(0)).toContainText(
    "Ash K has 1 card you want and wants 1 of yours"
  );
  await expectCollectorCopy(main, ashPlace);
  await expectPageChecks(page, `Find trades at ${width}`);
  await matches.getByRole("button", { name: /^Ash K/ }).click();
  const fromAsh = page
    .getByRole("list", { name: "You get from Ash K" })
    .getByRole("listitem");
  await expect(fromAsh).toHaveCount(1);
  await expect(fromAsh).toContainText("Arven");
  await expect(fromAsh).toContainText("×3");
  await expect(fromAsh).toContainText("3 wanted");
  await expect(fromAsh).toContainText("For Trade Wants");
  const toAsh = page
    .getByRole("list", { name: "You give Ash K" })
    .getByRole("listitem");
  await expect(toAsh).toHaveCount(1);
  await expect(toAsh).toContainText("Iono");
  await expect(toAsh).toContainText("×3");
  await expect(toAsh).toContainText("1 wanted (1 for Decks)");
  await expectCollectorCopy(main, ashPlace);
  await expectPageChecks(page, `an open two-way row at ${width}`);

  // S5. Propose from the row: cash only, refused.
  await page.getByRole("button", { name: "Propose trade to Ash K" }).click();
  await expect(page).toHaveURL(`${ORIGIN}/trades/new/${ashHandle}`);
  await expect(heading(page)).toHaveText("Trade Proposal to Ash K");
  await show(page, "Proposal");
  await expect(
    page.getByRole("list", { name: "You get", exact: true })
  ).toHaveText("Nothing yet");
  await show(page, "Cards");
  const arvenTile = tile(
    page.getByRole("list", { name: "Ash K's Trade List" }),
    "get",
    "Arven, SVI 166, .+?, Normal"
  );
  await arvenTile.click();
  await expect(arvenTile).toHaveAccessibleName(/1 of 3 in You get/);
  await arvenTile.click();
  await expect(arvenTile).toHaveAccessibleName(/2 of 3 in You get/);
  await expectPageChecks(
    page,
    `the proposal builder from Find trades at ${width}`
  );
  await show(page, "Proposal");
  await expect(group(page, "Arven (SVI 166) you get")).toContainText("2");
  await page.getByRole("radio", { name: "You pay" }).click();
  await expect(main.getByRole("note")).toContainText(NOTICE);
  const amount = page.getByRole("textbox", { name: "Amount in US dollars" });
  await amount.fill("15");
  const send = page.getByRole("button", { name: "Send Trade Proposal" });
  await send.click();
  await expect(main.getByRole("alert")).toHaveText(
    "Ash K isn't open to cash offers, so you can't give only cash. Add a card from your Trade List, or remove the cash."
  );
  await expectCollectorCopy(main, ashPlace);
  await expectPageChecks(page, `a refused cash-only proposal at ${width}`);

  // S6. Ash turns on Open to cash offers.
  await ash.page.goto(`${ORIGIN}/trades/list`);
  const open = ash.page.getByRole("checkbox", { name: "Open to cash offers" });
  await expect(open).not.toBeChecked();
  await open.check();
  await expect(toast(ash.page)).toContainText(
    "Friends can now send you Trade Proposals where one side gives only cash."
  );
  await ash.page.reload();
  await expect(open).toBeChecked();
  await expectPageChecks(
    ash.page,
    `My Trade List with Open to cash offers at ${width}`
  );

  // S7. Misty sends the same proposal.
  await show(page, "Proposal");
  await send.click();
  await expect(toast(page)).toContainText("Trade Proposal sent to Ash K");
  await expect(page).toHaveURL(tradeAddress);
  const proposalAddress = page.url();
  await expect(heading(page)).toHaveText("Waiting for Ash K to answer");
  await expect(region(page, "Cash")).toContainText("You pay Ash K $15.00");
  await expect(main.getByRole("note")).toContainText(NOTICE);
  await expectCollectorCopy(main, ashPlace);
  await expectPageChecks(page, `a sent cash-only proposal at ${width}`);

  // S8. Ash opens it from his inbox.
  await ash.page.goto(`${ORIGIN}/collection`);
  await expect(bell(ash.page)).toHaveAccessibleName("Inbox, 1 waiting");
  await bell(ash.page).click();
  await expect(waitingOn(ash.page)).toHaveText([
    /^Misty W · Answer\s*You give 2 cards · You get nothing · Misty W pays you \$15\.00/,
  ]);
  await expectCollectorCopy(drawer(ash.page), mistyPlace);
  await expectPageChecks(ash.page, `a cash proposal in the inbox at ${width}`);
  await waitingOn(ash.page).click();
  await expect(ash.page).toHaveURL(proposalAddress);
  await expect(heading(ash.page)).toHaveText(
    "Misty W would pay $15.00 for 2 cards"
  );
  await expect(region(ash.page, "Cash")).toContainText(
    "Misty W pays you $15.00"
  );
  await expect(ashMain.getByRole("note")).toContainText(NOTICE);
  await expect(ashMain.getByRole("button", { name: "Accept" })).toBeVisible();
  await expect(
    ashMain.getByRole("button", { name: "Counter", exact: true })
  ).toBeVisible();
  await expect(ashMain.getByRole("button", { name: "Decline" })).toBeVisible();
  await expectCollectorCopy(ashMain, mistyPlace);
  await expectPageChecks(
    ash.page,
    `a cash-only proposal to answer at ${width}`
  );

  // S9. Ash counters with a card and cash.
  await ashMain.getByRole("button", { name: "Counter", exact: true }).click();
  await expect(ash.page).toHaveURL(`${proposalAddress}/counter`);
  await expect(heading(ash.page)).toHaveText("Counter to Misty W");
  await show(ash.page, "Proposal");
  await expect(
    ash.page.getByRole("radio", { name: "Misty W pays" })
  ).toBeChecked();
  await expect(region(ash.page, "You give")).toContainText("Arven");
  const sendCounter = ash.page.getByRole("button", { name: "Send Counter" });
  await expect(sendCounter).toBeDisabled();
  await expect(ashMain).toContainText(
    "Change a card, a quantity or the cash to send a Counter."
  );
  await show(ash.page, "Cards");
  await ash.page.getByRole("radio", { name: "Their Trade List" }).click();
  const ionoTile = tile(
    ash.page.getByRole("list", { name: "Misty W's Trade List" }),
    "get",
    "Iono, PAL 185, .+?, Normal"
  );
  await ionoTile.click();
  await expect(ionoTile).toHaveAccessibleName(/1 of 3 in You get/);
  await show(ash.page, "Proposal");
  await expect(sendCounter).toBeEnabled();
  await expect(region(ash.page, "You get")).toContainText("Iono");
  await ash.page
    .getByRole("textbox", { name: "Amount in US dollars" })
    .fill("5");
  await expect(ashMain.getByRole("note")).toContainText(NOTICE);
  await expectCollectorCopy(ashMain, mistyPlace);
  await expectPageChecks(
    ash.page,
    `a Counter with a card and cash at ${width}`
  );
  await sendCounter.click();
  await expect(toast(ash.page)).toContainText("Counter sent to Misty W");
  await expect(ash.page).toHaveURL(tradeAddress);
  await expect(ash.page).not.toHaveURL(proposalAddress);
  const counterAddress = ash.page.url();
  await expect(heading(ash.page)).toHaveText("Waiting for Misty W to answer");
  await expect(ashMain).toContainText(
    "This is your Counter to Misty W's Trade Proposal."
  );
  await expect(region(ash.page, "Cash")).toContainText(
    "Misty W pays you $5.00"
  );
  await expectCollectorCopy(ashMain, mistyPlace);
  await expectPageChecks(ash.page, `a sent Counter at ${width}`);

  // S10. Misty accepts the Counter.
  await page.goto(`${ORIGIN}/collection`);
  await expect(bell(page)).toHaveAccessibleName("Inbox, 1 waiting");
  await bell(page).click();
  await expect(waitingOn(page)).toHaveText([
    /^Ash K · Answer Counter\s*You give 1 card · You get 2 cards · You pay Ash K \$5\.00/,
  ]);
  await expectCollectorCopy(drawer(page), ashPlace);
  await expectPageChecks(page, `a Counter in the inbox at ${width}`);
  await waitingOn(page).click();
  await expect(page).toHaveURL(counterAddress);
  await expect(heading(page)).toHaveText("Ash K countered your Trade Proposal");
  await expect(main).toContainText("This is a Counter to your Trade Proposal.");
  await expect(region(page, "Cash")).toContainText("You pay Ash K $5.00");
  await expect(main.getByRole("note")).toContainText(NOTICE);
  await expectCollectorCopy(main, ashPlace);
  await main.getByRole("button", { name: "Accept" }).click();
  await expect(toast(page)).toContainText(
    "Accepted. Swap the cards in person, then confirm."
  );
  await expect(heading(page)).toHaveText("Ready to swap with Ash K");
  await expect(main.getByRole("list", { name: "You give" })).toContainText(
    `From ${mistyPlace} Shelf`
  );
  await expect(bell(page)).toHaveAccessibleName("Inbox");
  await expectCollectorCopy(main, ashPlace);
  await expectPageChecks(page, `an accepted Trade at ${width}`);

  // S11. Ash confirms first, into his Box, with the Deck switch.
  await ash.page.goto(`${ORIGIN}/collection`);
  await expect(bell(ash.page)).toHaveAccessibleName("Inbox");
  await bell(ash.page).click();
  await expect(earlierOn(ash.page).getByRole("link")).toHaveText([
    /^New: Misty W accepted your Trade Proposal /,
  ]);
  await expectCollectorCopy(drawer(ash.page), mistyPlace);
  await earlierOn(ash.page).getByRole("link").click();
  await expect(ash.page).toHaveURL(counterAddress);
  await expect(heading(ash.page)).toHaveText("Ready to swap with Misty W");
  await expectCollectorCopy(ashMain, mistyPlace);
  await ashMain.getByRole("button", { name: "Confirm swap" }).click();
  const ashDialog = confirmDialog(ash.page, "Misty W");
  await expect(ashDialog).toContainText(
    `Arven (SVI 166) ×2 · from ${ashPlace} Binder`
  );
  await expect(ashDialog).toContainText("Iono (PAL 185) ×1");
  await expect(ashDialog).toContainText("The swap can't be undone.");
  const destination = ashDialog.getByRole("combobox", {
    name: "Put the cards you get in",
  });
  await expect(destination).toHaveValue("");
  await destination.selectOption({ label: `${ashPlace} Box` });
  const offer = ashDialog.getByRole("checkbox", {
    name: `Use for ${ashPlace} Deck instead of Iono (PAL 254)?`,
  });
  await expect(offer).toBeChecked();
  await expect(
    ashDialog.getByRole("button", { name: "Confirm swap" })
  ).toBeEnabled();
  await expect(ashDialog).toContainText(
    "The Deck's list changes to the card you get: Iono (PAL 185) ×1."
  );
  await expectCollectorCopy(ashDialog, mistyPlace);
  await expectPageChecks(
    ash.page,
    `the Confirm swap dialog with a destination and a Deck switch at ${width}`
  );
  await ashDialog.getByRole("button", { name: "Confirm swap" }).click();
  await expect(toast(ash.page)).toContainText(
    `Swapped. 1 card is in ${ashPlace} Box. ${ashPlace} Deck now uses Iono (PAL 185).`
  );
  await expect(heading(ash.page)).toHaveText(
    "Waiting for Misty W to confirm the swap"
  );
  await expectCollectorCopy(ashMain, mistyPlace);
  await expect
    .poll(() => deckLines(ash.page, ashDeck))
    .toEqual({ [iono]: "1" });

  // S12. Misty confirms into her Deck.
  await page.goto(`${ORIGIN}/collection`);
  await expect(bell(page)).toHaveAccessibleName("Inbox, 1 waiting");
  await bell(page).click();
  await expect(waitingOn(page)).toHaveText([/^Ash K · Confirm swap/]);
  await expectCollectorCopy(drawer(page), ashPlace);
  await expectPageChecks(page, `a swap to confirm in the inbox at ${width}`);
  await waitingOn(page).click();
  await expect(page).toHaveURL(counterAddress);
  await expect(heading(page)).toHaveText("Ash K confirmed the swap");
  await expect(main).toContainText(
    "Ash K confirmed the swap. Confirm yours once you have the cards."
  );
  await expectCollectorCopy(main, ashPlace);
  await expectPageChecks(page, `a half-confirmed Trade at ${width}`);
  await main.getByRole("button", { name: "Confirm swap" }).click();
  const dialog = confirmDialog(page, "Ash K");
  await expect(dialog).toContainText(
    `Iono (PAL 185) ×1 · from ${mistyPlace} Shelf`
  );
  await expect(dialog).toContainText("Arven (SVI 166) ×2");
  await dialog
    .getByRole("combobox", { name: "Put the cards you get in" })
    .selectOption({ label: `${mistyPlace} Deck (Deck)` });
  await expectCollectorCopy(dialog, ashPlace);
  await expectPageChecks(
    page,
    `the Confirm swap dialog with a Deck destination at ${width}`
  );
  await dialog.getByRole("button", { name: "Confirm swap" }).click();
  await expect(toast(page)).toContainText(
    `Swapped. 2 cards are in ${mistyPlace} Deck.`
  );
  await expect(heading(page)).toHaveText("Swapped with Ash K");
  await expect(main.getByRole("button", { name: "Confirm swap" })).toHaveCount(
    0
  );
  await expectCollectorCopy(main, ashPlace);
  await expectPageChecks(page, `a swapped Trade at ${width}`);
  await expect.poll(() => deckLines(page, mistyDeck)).toEqual({ [arven]: "2" });

  // S13. Ash sees the Trade swapped.
  await ash.page.reload();
  await expect(heading(ash.page)).toHaveText("Swapped with Misty W");
  await expectCollectorCopy(ashMain, mistyPlace);
  await bell(ash.page).click();
  await expect(
    earlierOn(ash.page)
      .getByRole("link")
      .filter({ hasText: "Misty W confirmed the swap" })
  ).toHaveCount(1);

  // S14. Ownership has moved, as the UI shows.
  await ash.page.goto(`${ORIGIN}/collection`);
  await expect(
    ashMain.getByText("2 copies · 2 editions", { exact: true })
  ).toBeVisible();
  await ash.page.goto(`${ORIGIN}/trades/list`);
  await expect(
    ashMain
      .getByRole("list", { name: `${ashPlace} Binder` })
      .getByRole("listitem")
      .filter({ hasText: "SVI 166" })
  ).toContainText("×1");
  await ash.page.goto(`${ORIGIN}/friends/${mistyHandle}/trade-list`);
  await expect(
    ashMain
      .getByRole("list", { name: "Iono", exact: true })
      .getByRole("listitem")
      .filter({ hasText: "PAL 185" })
  ).toContainText("×2");
  await expectCollectorCopy(ashMain, mistyPlace);
  await expectPageChecks(
    ash.page,
    `a Friend's Trade List after the swap at ${width}`
  );
  await page.goto(`${ORIGIN}/collection`);
  await expect(
    main.getByText("4 copies · 2 editions", { exact: true })
  ).toBeVisible();
  await page.goto(`${ORIGIN}/trades/list`);
  await expect(
    main
      .getByRole("list", { name: `${mistyPlace} Shelf` })
      .getByRole("listitem")
      .filter({ hasText: "PAL 185" })
  ).toContainText("×2");
  await page.goto(`${ORIGIN}/friends/${ashHandle}/trade-list`);
  await expect(
    main.getByRole("list", { name: "Arven", exact: true })
  ).toContainText("×1");
  await expectCollectorCopy(main, ashPlace);
  await page.goto(`${ORIGIN}/decks/want-list`);
  await expect(arvenWant(page)).toHaveText("1");
  await page.goto(`${ORIGIN}/decks/${mistyDeck}`);
  await expect(heading(page)).toHaveText(`${mistyPlace} Deck`);
  await expect(main).toContainText("2/60");

  // S15. Nothing about these Trades that reached either side names the other side's Locations, by name or by id.
  for (const stop of listeners) stop();
  const readTrade = new Set<string>();
  for (const { body, secretOf, against, url } of answers) {
    const text = await body;
    if (text === null) continue;
    if (/\/api\/social\/trades\/[0-9a-f-]{36}$/.test(url))
      readTrade.add(against);
    for (const item of secretOf) expect(text).not.toContain(item);
  }
  expect([...readTrade].sort()).toEqual([ashPlace, mistyPlace].sort());
}

test.describe("desktop", () => {
  test.use(DESKTOP_SIZE);

  test("two Friends trade in the browser from a For trade binder to both Confirm swaps: a cash offer from the two-way row is refused until cash offers are open, the Counter adds a card and less cash, it is accepted, and the cards have moved in Collection, the Trade Lists, the Deck and Trade Wants", async ({
    page,
    collectors,
  }) => {
    // Two collectors in two contexts, a catalog seed, the whole Trade from both sides and about twenty page checks: well over 30 s on a loaded host.
    test.slow();
    await story(page, collectors, DESKTOP_SIZE, "desktop width");
  });
});

test.describe("phone", () => {
  test.use(PHONE_SIZE);

  test("the same at 375 px, with no sideways scroll and touch-sized controls", async ({
    page,
    collectors,
  }) => {
    // Two collectors in two contexts, a catalog seed, the whole Trade from both sides and about twenty page checks: well over 30 s on a loaded host.
    test.slow();
    await story(page, collectors, PHONE_SIZE, "375 px");
  });
});
