// Ticket #272: Confirm swap (Trading spec "Confirm swap and ownership transfer", prototype verdict variant A: received
// cards go to Unsorted by default, changeable in the confirm dialog). Misty sends Ash a swap and a gift through the
// API. Ash accepts the swap in the browser, and his open screen finds his pick out of date once his Arven moved to
// another box: he uses the suggested picks and confirms, choosing that box for the card he gets. Misty sees that Ash
// confirmed and that nothing of hers moved, then confirms into a Deck, and the Trade is swapped. Her confirm of the
// gift, which gets her nothing, asks nowhere to put cards. Ownership is checked through the API on both sides, and no
// Trade answer either browser receives names the other side's Location. Misty is the owner page at desktop width and
// at 375 px; Ash signs in first. The catalog is the Swap catalog (api/tests/want_list_swap_fixtures.py).
import { randomUUID } from "node:crypto";
import type { BrowserContextOptions, Page } from "@playwright/test";
import { expect, test } from "./support/collectors";
import {
  accountId,
  api,
  befriend,
  createDeck,
  hold,
  nameCollector,
  ORIGIN,
  seedCatalog,
} from "./support/loans";
import { expectPageChecks } from "./support/page-check";
import { signInAsOwner } from "./support/sign-in";
import { bodyOf } from "./support/trades";

/** A top-level Storage Leaf, marked For trade when `forTrade`; returns its id. */
async function leaf(page: Page, name: string, forTrade: boolean) {
  const created = await api(page, "POST", "/api/location-tree", {
    name,
    parent_id: null,
    parent_version: null,
    idempotency_key: randomUUID(),
  });
  const location = created.location as { id: string; version: number };
  if (forTrade)
    await api(page, "PUT", `/api/location-tree/${location.id}/for-trade`, {
      for_trade: true,
      version: location.version,
      idempotency_key: randomUUID(),
    });
  return location.id;
}

/** The copies of each Edition one Location holds, through the API. */
async function held(page: Page, location: string) {
  const body = await api(page, "GET", `/api/holdings/${location}`);
  return Object.fromEntries(
    (body.holdings as { edition_id: string; quantity: string }[]).map(
      (item) => [item.edition_id, item.quantity]
    )
  );
}

/** A Collection Move of `copies` of one Edition from `source` to `destination`, through the API. */
async function move(
  page: Page,
  source: string,
  edition: string,
  copies: number,
  destination: string
) {
  const version = (
    (await api(page, "GET", `/api/holdings/${source}`)).holdings as {
      edition_id: string;
      version: number;
    }[]
  ).find((item) => item.edition_id === edition)!.version;
  const manifest = (
    await api(page, "POST", "/api/moves/manifests", { source_id: source })
  ).id as string;
  await api(page, "PUT", `/api/moves/manifests/${manifest}/items`, {
    items: [
      {
        edition_id: edition,
        quantity: String(copies),
        expected_version: version,
      },
    ],
  });
  await api(page, "POST", `/api/moves/manifests/${manifest}/commit`, {
    destination_id: destination,
    idempotency_key: randomUUID(),
  });
}

/** Misty sends Ash a Trade Proposal through the API; returns its id. */
async function propose(
  page: Page,
  to: string,
  give: [string, number][],
  get: [string, number][]
): Promise<string> {
  const line = ([edition_id, n]: [string, number]) => ({
    edition_id,
    quantity: String(n),
  });
  const trade = await api(page, "POST", "/api/trades", {
    recipient_id: to,
    you_give: give.map(line),
    you_get: get.map(line),
    idempotency_key: randomUUID(),
  });
  return trade.id as string;
}

const heading = (page: Page) => page.getByRole("heading", { level: 1 });
const toast = (page: Page) =>
  page.getByRole("region", { name: "Notifications" });
const more = (page: Page) =>
  page.getByRole("button", { name: "More for this Trade" });
/** The ⋯ menu offers Report (Trading #303) and nothing else: no Withdraw or Cancel Trade is left. */
const expectOnlyReport = async (page: Page) => {
  await more(page).click();
  await expect(page.getByRole("menuitem")).toHaveText(["Report"]);
  await page.keyboard.press("Escape");
};
const confirmDialog = (page: Page, other: string) =>
  page.getByRole("dialog", { name: `Confirm swap with ${other}?` });
const noArtwork = (page: Page) =>
  page.route(/^https:\/\/assets\.tcgdex\.net\//, (route) => route.abort());

/** The whole story at one size. */
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
  const ids = seedCatalog();
  const iono = ids["PAL 185"];
  const arven = ids["SVI 166"];
  const secret = `Secret ${randomUUID().slice(0, 6)}`;
  const ash = await collectors.signIn({ contextOptions });
  await nameCollector(ash.page, "Ash K");
  const ashBinder = await leaf(ash.page, `${secret} Binder`, true);
  const ashBox = await leaf(ash.page, `${secret} Box`, false);
  await hold(ash.page, ashBinder, arven, 2);

  await noArtwork(page);
  await noArtwork(ash.page);
  await signInAsOwner(page, "/collection");
  await nameCollector(page, "Misty W");
  const shelf = await leaf(page, `${secret} Shelf`, true);
  await hold(page, shelf, iono, 3);
  const deck = await createDeck(page, `${secret} Deck`);
  await befriend(page, ash.page);
  // Everything about Trades that reaches either browser, to check it never names the other side's Locations.
  const answers: { body: Promise<string | null>; secretOf: string[] }[] = [];
  for (const [who, theirs] of [
    [ash.page, [`${secret} Shelf`, shelf, `${secret} Deck`, deck]],
    [page, [`${secret} Binder`, ashBinder, `${secret} Box`, ashBox]],
  ] as const)
    who.on("response", (response) => {
      if (/\/api\/(social\/)?trade/.test(response.url()))
        answers.push({ body: bodyOf(response), secretOf: [...theirs] });
    });

  const ashId = await accountId(ash.page);
  const swap = await propose(page, ashId, [[iono, 1]], [[arven, 1]]);
  const gift = await propose(page, ashId, [[iono, 1]], []);

  // A: Ash accepts the swap. His screen tells him to swap in person, then confirm, and says where his Arven comes from.
  await ash.page.goto(`${ORIGIN}/trades/${swap}`);
  const ashMain = ash.page.getByRole("main");
  await ashMain.getByRole("button", { name: "Accept" }).click();
  await expect(heading(ash.page)).toHaveText("Ready to swap with Misty W");
  await expect(toast(ash.page)).toContainText(
    "Accepted. Swap the cards in person, then confirm."
  );
  await expect(ashMain).toContainText(
    "Swap the cards in person, then confirm."
  );
  await expect(ashMain.getByRole("list", { name: "You give" })).toContainText(
    `From ${secret} Binder`
  );
  await expect(more(ash.page)).toHaveCount(1);

  // B: both Arven move to Ash's Box while his screen is open. His Confirm swap finds the pick out of date, and the
  // screen reads the Trade and his picks again.
  await move(ash.page, ashBinder, arven, 2, ashBox);
  let stalePickConfirmations = 0;
  ash.page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      request.url().endsWith(`/api/trades/${swap}/confirm-swap`)
    )
      stalePickConfirmations++;
  });
  await ashMain.getByRole("button", { name: "Confirm swap" }).click();
  const ashDialog = confirmDialog(ash.page, "Misty W");
  await expect(ashDialog).toBeVisible();
  await expect(
    ashDialog.getByRole("combobox", { name: "Put the cards you get in" })
  ).toHaveValue("");
  await ashDialog.getByRole("button", { name: "Confirm swap" }).click();
  await expect(ashDialog).toBeHidden();
  expect(stalePickConfirmations).toBe(1);
  await expect(ashMain.getByRole("alert")).toHaveText(
    "A pick is out of date. Use the suggested picks first."
  );
  await expect(ashMain).toContainText("A pick is out of date.");
  await expect(ashMain.getByRole("list", { name: "You give" })).toContainText(
    `${secret} Binder has none now · take it from ${secret} Box`
  );
  await expect(
    ashMain.getByRole("button", { name: "Confirm swap" })
  ).toHaveCount(0);
  await expectPageChecks(ash.page, `an out-of-date pick at ${width}`);
  await ashMain.getByRole("button", { name: "Use suggested picks" }).click();
  await expect(toast(ash.page)).toContainText("Picks updated");
  await expect(heading(ash.page)).toBeFocused();
  await expect(ashMain.getByRole("list", { name: "You give" })).toContainText(
    `From ${secret} Box`
  );

  await page.goto(`${ORIGIN}/trades/${swap}`);
  await expect(heading(page)).toHaveText("Ready to swap with Ash K");
  // Keep consent open so focus refresh cannot hide the stale-revision regression.
  const dialog = confirmDialog(page, "Ash K");
  await page
    .getByRole("main")
    .getByRole("button", { name: "Confirm swap" })
    .click();
  await expect(dialog).toBeVisible();
  const confirmations: {
    revision: number;
    idempotency_key: string;
    destination_id: string | null;
    deck_switches: object[];
  }[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      request.url().endsWith(`/api/trades/${swap}/confirm-swap`)
    )
      confirmations.push(request.postDataJSON());
  });

  // C: Ash confirms, putting Misty's Iono in his Box.
  await ashMain.getByRole("button", { name: "Confirm swap" }).click();
  await expect(ashDialog).toContainText(
    `Arven (SVI 166) ×1 · from ${secret} Box`
  );
  await expect(ashDialog).toContainText("Iono (PAL 185) ×1");
  await expect(ashDialog).toContainText("The swap can't be undone.");
  await expectPageChecks(ash.page, `the confirm dialog at ${width}`);
  await ashDialog
    .getByRole("combobox", { name: "Put the cards you get in" })
    .selectOption({ label: `${secret} Box` });
  await ashDialog.getByRole("button", { name: "Confirm swap" }).click();
  await expect(toast(ash.page)).toContainText(
    `Swapped. 1 card is in ${secret} Box.`
  );
  await expect(heading(ash.page)).toHaveText(
    "Waiting for Misty W to confirm the swap"
  );
  await expect(heading(ash.page)).toBeFocused();
  await expect(
    ashMain.getByRole("button", { name: "Confirm swap" })
  ).toHaveCount(0);
  await expectOnlyReport(ash.page);
  expect(await held(ash.page, ashBox)).toEqual({ [arven]: "1", [iono]: "1" });

  // D: Misty's screen was open before Ash confirmed; confirming must recover from its stale revision.
  const main = page.getByRole("main");
  expect(await held(page, shelf)).toEqual({ [iono]: "3" });

  // E: Misty confirms into her Deck: the Trade is swapped, and the Deck lists the Arven it now holds.
  await dialog
    .getByRole("combobox", { name: "Put the cards you get in" })
    .selectOption({ label: `${secret} Deck (Deck)` });
  await dialog.getByRole("button", { name: "Confirm swap" }).click();
  await expect(toast(page)).toContainText(
    `Swapped. 1 card is in ${secret} Deck.`
  );
  await expect(heading(page)).toHaveText("Swapped with Ash K");
  expect(confirmations).toHaveLength(2);
  expect(confirmations[1].revision).toBe(confirmations[0].revision + 1);
  expect(confirmations[0].destination_id).toBe(deck);
  expect(confirmations[1].destination_id).toBe(deck);
  expect(confirmations[1].deck_switches).toEqual(
    confirmations[0].deck_switches
  );
  expect(confirmations[1].idempotency_key).toBe(
    confirmations[0].idempotency_key
  );
  await expect(main.getByRole("button", { name: "Confirm swap" })).toHaveCount(
    0
  );
  expect(await held(page, shelf)).toEqual({ [iono]: "2" });
  expect(await held(page, deck)).toEqual({ [arven]: "1" });
  const lines = (await api(page, "GET", `/api/decks/${deck}`)).deck_list
    .lines as { edition_id: string; quantity: string }[];
  expect(lines.map((item) => [item.edition_id, item.quantity])).toEqual([
    [arven, "1"],
  ]);
  await ash.page.reload();
  await expect(heading(ash.page)).toHaveText("Swapped with Misty W");

  // A changed cash term in the refreshed answer requires review, even when the other side confirmed.
  // Stock a fresh Arven in Ash's For trade Binder: his remaining copy is in the unlisted Box after the first swap.
  await hold(ash.page, ashBinder, arven, 1);
  const review = await propose(page, ashId, [[iono, 1]], [[arven, 1]]);
  const offered = await api(ash.page, "GET", `/api/social/trades/${review}`);
  const accepted = await api(ash.page, "POST", `/api/trades/${review}/accept`, {
    revision: offered.revision,
    idempotency_key: randomUUID(),
  });
  await page.goto(`${ORIGIN}/trades/${review}`);
  await main.getByRole("button", { name: "Confirm swap" }).click();
  await expect(dialog).toBeVisible();
  await api(ash.page, "POST", `/api/trades/${review}/confirm-swap`, {
    revision: accepted.revision,
    idempotency_key: randomUUID(),
  });
  const changedPath = `**/api/social/trades/${review}`;
  await page.route(changedPath, async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      json: {
        ...(await response.json()),
        cash: { cents: "200", payer: "you" },
      },
    });
  });
  let reviewConfirmations = 0;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      request.url().endsWith(`/api/trades/${review}/confirm-swap`)
    )
      reviewConfirmations++;
  });
  await dialog.getByRole("button", { name: "Confirm swap" }).click();
  await expect(main.getByRole("alert")).toHaveText(
    "This Trade has changed. Check it and try again."
  );
  await expect(dialog).toBeHidden();
  await expect(heading(page)).toHaveText("Ash K confirmed the swap");
  expect(reviewConfirmations).toBe(1);
  await page.unroute(changedPath);

  // F: Ash accepts the gift through the API. Misty's confirm gets her nothing, so it asks nowhere to put cards.
  const read = await api(ash.page, "GET", `/api/social/trades/${gift}`);
  await api(ash.page, "POST", `/api/trades/${gift}/accept`, {
    revision: read.revision,
    idempotency_key: randomUUID(),
  });
  await page.goto(`${ORIGIN}/trades/${gift}`);
  await expect(heading(page)).toHaveText("Ready to give Ash K 1 card");
  await main.getByRole("button", { name: "Confirm swap" }).click();
  await expect(dialog).toContainText("Iono (PAL 185) ×1");
  await expect(dialog.getByRole("combobox")).toHaveCount(0);
  await expectPageChecks(page, `the confirm dialog of a gift at ${width}`);
  await dialog.getByRole("button", { name: "Confirm swap" }).click();
  await expect(toast(page)).toContainText(
    "Swapped. The cards you gave left your Collection."
  );
  await expect(heading(page)).toHaveText(
    "Waiting for Ash K to confirm the swap"
  );
  expect(await held(page, shelf)).toEqual({ [iono]: "1" });

  // Nothing about these Trades that reached either side names the other side's Locations, by name or by id.
  const readBy = new Set<string>();
  for (const { body, secretOf } of answers) {
    const text = await body;
    if (text === null) continue;
    readBy.add(secretOf[0]);
    for (const item of secretOf) expect(text).not.toContain(item);
  }
  expect(readBy.size).toBe(2);
}

test.describe("desktop", () => {
  const size = { viewport: { width: 1280, height: 800 } };
  test.use(size);

  test("both sides confirm a swap for their own Collections, the first after fixing an out-of-date pick, and a gift's giver confirms with nowhere to choose", async ({
    page,
    collectors,
  }) => {
    // Two collectors in two contexts, a catalog seed, many page loads and page checks: well over 30 s on a loaded host.
    test.slow();
    await story(page, collectors, size, "desktop width");
  });
});

test.describe("phone", () => {
  const size = {
    viewport: { width: 375, height: 812 },
    isMobile: true,
    hasTouch: true,
  };
  test.use(size);

  test("the same at 375 px, with no sideways scroll and touch-sized controls", async ({
    page,
    collectors,
  }) => {
    // Two collectors in two contexts, a catalog seed, many page loads and page checks: well over 30 s on a loaded host.
    test.slow();
    await story(page, collectors, size, "375 px");
  });
});
