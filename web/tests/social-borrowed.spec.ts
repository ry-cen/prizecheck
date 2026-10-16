// Ticket #254: Borrowed Copies across the app (spec "Inventory touch-points"). Ash borrows two Iono PAL 185 from his
// Friend Misty for his Deck, whose line lists one (request, accept and both handover confirmations through the API, as
// #252's and #253's specs cover). The Deck's line rises to two and reads "2 from Misty W"; his Collection counts only
// his own Boss's Orders, and its Borrowed entry lists the Iono where they are. He moves one to Unsorted from that list,
// and the Deck's line then reads "1 from Misty W". The catalog is the Swap catalog
// (api/tests/want_list_swap_fixtures.py).
import { randomUUID } from "node:crypto";
import { expect, test } from "./support/collectors";
import {
  DESKTOP,
  ORIGIN,
  PHONE,
  befriend,
  createDeck,
  hold,
  lendHandedOver,
  nameCollector,
  seedCatalog,
  setLine,
  unsorted,
} from "./support/loans";
import { expectPageChecks } from "./support/page-check";
import { signInAsOwner } from "./support/sign-in";

test("borrowed copies fill the borrower's Deck, labelled with their lender, and move only from the Borrowed list", async ({
  page,
  collectors,
}) => {
  // Two collectors in two contexts, a catalog import and page checks at both widths: well over 30 s on a loaded host.
  test.slow();
  const ids = seedCatalog();
  const s = randomUUID().slice(0, 6);
  const misty = await collectors.signIn({ next: "/loans" });
  const lender = misty.page;
  await nameCollector(lender, "Misty W");
  await hold(lender, await unsorted(lender), ids["PAL 185"], 2);

  await page.route(/^https:\/\/assets\.tcgdex\.net\//, (route) =>
    route.abort()
  );
  await signInAsOwner(page, "/collection");
  await nameCollector(page, "Ash K");
  const deckName = `Charizard ex ${s}`;
  const charizard = await createDeck(page, deckName);
  await setLine(page, charizard, ids["PAL 185"], 1);
  const ashUnsorted = await unsorted(page);
  await hold(page, ashUnsorted, ids["PAL 172"], 1);
  await befriend(page, lender);
  await lendHandedOver(lender, page, [[ids["PAL 185"], 2]], charizard);

  // The Deck: both copies are in it, the line rose to two as for owned copies, and it says whose they are.
  await page.goto(`${ORIGIN}/decks/${charizard}`);
  await expect(
    page
      .getByRole("button", {
        name: /^Iono,.*copy 2 of 2: in this Deck; 2 from Misty W$/,
      })
      .first()
  ).toBeVisible();

  // The Collection counts only Ash's own copies; the Borrowed entry lists Misty's, where they are.
  await page.goto(`${ORIGIN}/collection`);
  const main = page.getByRole("main");
  await expect(main).toContainText("1 copy · 1 edition");
  await expect(main).not.toContainText("Iono");
  const sidebar = page.getByRole("complementary", { name: "Sidebar" });
  await expect(sidebar.getByRole("button", { name: /^Borrowed/ })).toHaveText(
    /Borrowed\s*2/
  );
  await sidebar.getByRole("button", { name: /^Borrowed/ }).click();
  const borrowed = page.getByRole("dialog", { name: "Borrowed" });
  const rows = borrowed
    .getByRole("list", { name: "Borrowed cards" })
    .getByRole("listitem");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText(`2 from Misty W · In ${deckName}`);
  await expectPageChecks(page, "the Borrowed list");

  // Move one to Unsorted: the list shows each place.
  await rows
    .first()
    .getByRole("button", { name: `Move Iono from ${deckName}` })
    .click();
  const form = borrowed.getByRole("form", { name: "Move Iono" });
  await form.getByRole("combobox", { name: "Move to" }).selectOption({
    label: "Unsorted",
  });
  await form.getByRole("button", { name: "Decrease Copies" }).click();
  await expectPageChecks(page, "moving a borrowed card");
  await form.getByRole("button", { name: "Move", exact: true }).click();
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: "In Unsorted" })).toContainText(
    "1 from Misty W"
  );
  await expect(rows.filter({ hasText: `In ${deckName}` })).toContainText(
    "1 from Misty W"
  );
  await borrowed.getByRole("button", { name: "Close Borrowed" }).click();

  // On a phone the entry is in the locations drawer.
  await page.setViewportSize(PHONE);
  await page.getByRole("button", { name: "Open locations" }).click();
  await page.getByRole("button", { name: /^Borrowed/ }).click();
  await expect(rows).toHaveCount(2);
  await expectPageChecks(page, "the Borrowed list on a phone");
  await borrowed.getByRole("button", { name: "Close Borrowed" }).click();
  await page.setViewportSize(DESKTOP);

  // The Deck keeps the one still in it.
  await page.goto(`${ORIGIN}/decks/${charizard}`);
  await expect(
    page
      .getByRole("button", {
        name: /^Iono,.*copy 2 of 2: not owned; 1 from Misty W$/,
      })
      .first()
  ).toBeVisible();
});
