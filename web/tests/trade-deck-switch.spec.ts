// Ticket #279: the Deck switch at Confirm swap. Misty's Deck lists Arven (SVI 166, Reverse Holo) and her Will accept
// for it takes any Edition of the same Card Printing, so when Ash swaps her the plain Arven (SVI 166) her Confirm swap
// dialog offers, ticked, to use it for the Deck instead. In the first Trade she unticks the offer and confirms: the
// Deck keeps asking for the Reverse Holo. In the second she leaves it ticked: the Deck lists the plain Arven, and the
// toast's Undo switch puts the Reverse Holo back. Ash only accepts, through the API. At desktop width and at 375 px.
// The catalog is the Swap catalog (api/tests/want_list_swap_fixtures.py).
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
  setLine,
} from "./support/loans";
import { expectPageChecks } from "./support/page-check";
import { signInAsOwner } from "./support/sign-in";
import {
  DESKTOP_SIZE,
  forTradeLeaf,
  PHONE_SIZE,
  propose,
  tradeStep,
} from "./support/trades";

const heading = (page: Page) => page.getByRole("heading", { level: 1 });
const toast = (page: Page) =>
  page.getByRole("region", { name: "Notifications" });
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
  const arven = ids["SVI 166"];
  const reverse = ids["SVI 166 Reverse Holo"];
  const iono = ids["PAL 185"];
  const secret = `Secret ${randomUUID().slice(0, 6)}`;
  const ash = await collectors.signIn({ contextOptions });
  await nameCollector(ash.page, "Ash K");
  const binder = await forTradeLeaf(ash.page, `${secret} Binder`);
  await hold(ash.page, binder, arven, 2);

  await noArtwork(page);
  await noArtwork(ash.page);
  await signInAsOwner(page, "/collection");
  await nameCollector(page, "Misty W");
  const shelf = await forTradeLeaf(page, `${secret} Shelf`);
  await hold(page, shelf, iono, 2);
  const deck = await createDeck(page, `${secret} Deck`);
  await setLine(page, deck, reverse, 1);
  await api(page, "PUT", `/api/trade-wants/will-accept/${reverse}`, {
    rule: "printing",
  });
  await befriend(page, ash.page);

  const ashId = await accountId(ash.page);
  const first = await propose(page, ashId, [[iono, 1]], [[arven, 1]]);
  const second = await propose(page, ashId, [[iono, 1]], [[arven, 1]]);
  await tradeStep(ash.page, first, "accept");
  await tradeStep(ash.page, second, "accept");

  /** The Deck's lines through the API, as { edition: quantity }. */
  const lines = async () =>
    Object.fromEntries(
      (
        (await api(page, "GET", `/api/decks/${deck}`)).deck_list.lines as {
          edition_id: string;
          quantity: string;
        }[]
      ).map((item) => [item.edition_id, item.quantity])
    );
  const main = page.getByRole("main");
  const dialog = confirmDialog(page, "Ash K");
  const offer = dialog.getByRole("checkbox", {
    name: `Use for ${secret} Deck instead of Arven (SVI 166, Reverse Holo)?`,
  });

  // A: the offer is ticked. Misty unticks it, and her Deck keeps asking for the Reverse Holo.
  await page.goto(`${ORIGIN}/trades/${first}`);
  await main.getByRole("button", { name: "Confirm swap" }).click();
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("heading", { name: "Deck switches" })
  ).toBeVisible();
  await expect(offer).toBeChecked();
  await expect(dialog).toContainText(
    "The Deck's list changes to the card you get: Arven (SVI 166) ×1."
  );
  await expectPageChecks(
    page,
    `the Confirm swap dialog with a Deck switch at ${width}`
  );
  await offer.uncheck();
  await expect(offer).not.toBeChecked();
  await dialog.getByRole("button", { name: "Confirm swap" }).click();
  await expect(toast(page)).toContainText("Swapped. 1 card is in Unsorted.");
  await expect(toast(page)).not.toContainText("Deck now uses");
  await expect(
    toast(page).getByRole("button", { name: /^Undo switch/ })
  ).toHaveCount(0);
  await expect(heading(page)).toHaveText(
    "Waiting for Ash K to confirm the swap"
  );
  await expect.poll(lines).toEqual({ [reverse]: "1" });

  // B: the offer left ticked. The Deck now lists the card she got, and Undo switch puts the Reverse Holo back.
  await page.goto(`${ORIGIN}/trades/${second}`);
  await main.getByRole("button", { name: "Confirm swap" }).click();
  await expect(dialog).toBeVisible();
  await expect(offer).toBeChecked();
  await dialog.getByRole("button", { name: "Confirm swap" }).click();
  await expect(toast(page)).toContainText(
    `Swapped. 1 card is in Unsorted. ${secret} Deck now uses Arven (SVI 166).`
  );
  await expect.poll(lines).toEqual({ [arven]: "1" });
  await expectPageChecks(page, `a Deck switch toast at ${width}`);
  await toast(page).getByRole("button", { name: "Undo switch" }).click();
  await expect(toast(page)).toContainText(
    `${secret} Deck uses Arven (SVI 166, Reverse Holo) again.`
  );
  await expect(
    toast(page).getByRole("button", { name: /^Undo switch/ })
  ).toHaveCount(0);
  await expect.poll(lines).toEqual({ [reverse]: "1" });
}

test.describe("desktop", () => {
  test.use(DESKTOP_SIZE);

  test("Misty unticks a Deck switch at Confirm swap and her Deck keeps the card it asked for, then leaves the next one ticked, sees the Deck use the card she got and undoes it from the toast", async ({
    page,
    collectors,
  }) => {
    // Two collectors in two contexts, a catalog seed, several page loads and page checks: well over 30 s on a loaded host.
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
    // Two collectors in two contexts, a catalog seed, several page loads and page checks: well over 30 s on a loaded host.
    test.slow();
    await story(page, collectors, PHONE_SIZE, "375 px");
  });
});
