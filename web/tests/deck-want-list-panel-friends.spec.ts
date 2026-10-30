import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { expect, test } from "./support/collectors";
import {
  api,
  befriend,
  createDeck,
  nameCollector,
  ORIGIN,
  seedCatalog,
  setLine,
  unsorted,
} from "./support/loans";
import { expectPageChecks } from "./support/page-check";
import { signInAsOwner } from "./support/sign-in";

// The deck builder's Ways to get missing cards uses the Want List's Friend chips (#251): a chip there asks the Friend
// through the same Borrow Request drafts (#252) as the Want List page, so asking needs no trip to that page. Brock has a
// spare Iono PAL 254, another Printing of the PAL 185 the Deck needs (the Swap catalog,
// api/tests/want_list_swap_fixtures.py). The other collector signs in first, so the test's own page signs in afterwards
// as a new account.

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

test.use({ viewport: { width: 1280, height: 800 } });

test("a Friend chip in the deck builder's panel asks the Friend through the Borrow Request drafts", async ({
  page,
  collectors,
}) => {
  const ids = seedCatalog();
  const brock = await collectors.signIn({ next: "/decks" });
  await nameCollector(brock.page, "Brock S");
  await hold(brock.page, await unsorted(brock.page), ids["PAL 254"], 1);

  await page.route(/^https:\/\/assets\.tcgdex\.net\//, (route) =>
    route.abort()
  );
  await signInAsOwner(page, "/decks");
  await nameCollector(page, "Ash K");
  const deckName = `Charizard ex ${randomUUID().slice(0, 6)}`;
  const deck = await createDeck(page, deckName);
  await setLine(page, deck, ids["PAL 185"], 2);
  await befriend(page, brock.page);

  await page.goto(`${ORIGIN}/decks/${deck}`);
  await page.getByRole("button", { name: "Ways to get missing cards" }).click();
  const panel = page.getByRole("region", { name: "Ways to get missing cards" });
  const chip = panel
    .getByRole("list", { name: "Friends who can lend Iono" })
    .getByRole("button", { name: "Brock S · 1 spare · PAL 254" });
  await expect(chip).toHaveAttribute("aria-pressed", "false");
  await expectPageChecks(page, "the deck builder's panel with Friend chips");

  await chip.click();
  await expect(chip).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("region", { name: "Borrow Request drafts" })
  ).toContainText("1 card");
  // The ask changes no count: the line still needs both copies.
  await expect(
    panel.getByRole("list", { name: `What ${deckName} needs` })
  ).toContainText("2 of 2");
});
