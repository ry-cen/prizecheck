// Ticket #258: Lend Offers (spec "Borrow Requests and Lend Offers", "Web screens"). Misty selects her Iono PAL 185 in
// the Collection and chooses Lend to a Friend…, picks Ash and sends the offer, which reserves the copy. Ash accepts it
// into his Charizard Deck, after Retry reads his Decks again. Misty then offers her Boss's Orders, after Retry reads
// her Friends again, and closes with Done: the selection went with the offer, so the Collection's heading takes focus.
// The API tests cover reserving on send, partial acceptance, declining and withdrawing. The catalog is the Swap
// catalog (api/tests/want_list_swap_fixtures.py).
import { expect, test } from "./support/collectors";
import {
  DESKTOP,
  ORIGIN,
  PHONE,
  befriend,
  createDeck,
  hold,
  nameCollector,
  seedCatalog,
  unsorted,
} from "./support/loans";
import { expectPageChecks } from "./support/page-check";
import { signInAsOwner } from "./support/sign-in";

test("the lender offers selected copies from the Collection, and the borrower accepts them into a Deck", async ({
  page,
  collectors,
}) => {
  // Two collectors in two contexts, a catalog import and page checks at both widths: well over 30 s on a loaded host.
  test.slow();
  const ids = seedCatalog();
  const misty = await collectors.signIn({ next: "/loans" });
  const lender = misty.page;
  await nameCollector(lender, "Misty W");
  await hold(lender, await unsorted(lender), ids["PAL 185"], 1);
  await hold(lender, await unsorted(lender), ids["PAL 172"], 1);

  await page.route(/^https:\/\/assets\.tcgdex\.net\//, (route) =>
    route.abort()
  );
  await signInAsOwner(page, "/loans");
  await nameCollector(page, "Ash K");
  await befriend(page, lender);
  await createDeck(page, "Charizard");
  const title = (on: typeof page) => on.getByRole("heading", { level: 1 });

  // Misty selects her Iono and offers it to Ash.
  await lender.route(/^https:\/\/assets\.tcgdex\.net\//, (route) =>
    route.abort()
  );
  await lender.goto(`${ORIGIN}/`);
  await lender
    .getByRole("region", { name: "Cards" })
    .getByRole("button", { name: /Iono/ })
    .first()
    .click();
  const bar = lender.getByRole("region", { name: "Selection" });
  await bar.getByRole("button", { name: "Actions" }).click();
  await bar.getByRole("button", { name: "Lend to a Friend…" }).click();
  const dialog = lender.getByRole("dialog", { name: "Lend to a Friend" });
  await expect(
    dialog.getByRole("list", { name: "Cards to lend" })
  ).toContainText("1 × Iono");
  const send = dialog.getByRole("button", { name: "Send offer of 1 card" });
  await expect(send).toBeDisabled();
  await dialog
    .getByRole("combobox", { name: "Friend" })
    .selectOption({ label: "Ash K" });
  await expectPageChecks(lender, "offering cards to a Friend");
  await lender.setViewportSize(PHONE);
  await expectPageChecks(lender, "offering cards to a Friend on a phone");
  await lender.setViewportSize(DESKTOP);
  await send.click();
  await expect(dialog).toContainText("Offer sent to Ash K.");
  const open = dialog.getByRole("button", { name: "Open the Loan" });
  await expect(open).toBeFocused();
  await expectPageChecks(lender, "an offer sent");
  await lender.setViewportSize(PHONE);
  await expectPageChecks(lender, "an offer sent on a phone");
  await lender.setViewportSize(DESKTOP);
  await open.click();
  await expect(title(lender)).toHaveText("You offered Ash K 1 card");
  await expect(lender.getByRole("main")).toContainText(
    "Waiting for Ash K to answer"
  );
  const loanPath = new URL(lender.url()).pathname;

  // Ash: the offer needs him; his Decks can't be read at first, and Retry reads them; he takes it into Charizard.
  await page.goto(`${ORIGIN}/loans`);
  await expect(
    page.getByRole("region", { name: "Needs you" }).getByRole("link")
  ).toContainText("Misty W offered to lend you 1 card");
  await page.route(/\/api\/decks(\?.*)?$/, (route) => route.abort(), {
    times: 1,
  });
  await page.goto(`${ORIGIN}${loanPath}`);
  await expect(page.getByRole("main")).toContainText(
    "Your Decks couldn't be loaded."
  );
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(
    page.getByRole("combobox", { name: "Put them in" })
  ).toBeFocused();
  await expect(page.getByRole("main")).not.toContainText(
    "Your Decks couldn't be loaded."
  );
  await expect(
    page.getByRole("group", { name: /^Copies of Iono, .* to borrow$/ })
  ).toContainText("1");
  await page
    .getByRole("combobox", { name: "Put them in" })
    .selectOption({ label: "Charizard" });
  // An offer names no Deck in its facts and links none until it's accepted.
  const offerFacts = page
    .getByRole("main")
    .locator("p")
    .filter({ hasText: /^You're borrowing/ });
  await expect(offerFacts).toHaveCount(1);
  await expect(offerFacts).not.toContainText("For ");
  await expect(
    page.getByRole("main").locator('a[href^="/decks/"]')
  ).toHaveCount(0);
  await expectPageChecks(page, "answering a Lend Offer");
  await page.setViewportSize(PHONE);
  await expectPageChecks(page, "answering a Lend Offer on a phone");
  await page.setViewportSize(DESKTOP);
  await page.getByRole("button", { name: "Accept" }).click();
  await expect(title(page)).toHaveText("Misty W is lending you 1 card");
  await expect(page.getByRole("main")).toContainText("For Charizard");
  await expect(
    page.getByRole("main").getByRole("link", { name: "Charizard", exact: true })
  ).toHaveAttribute("href", /^\/decks\/[0-9a-f-]+$/);
  await lender.reload();
  await expect(title(lender)).toHaveText("You're lending Ash K 1 card");

  // Misty offers her Boss's Orders: her Friends can't be read at first, and Retry reads them. Done after sending
  // leaves the Collection's heading with focus, since Actions went with the selection.
  await lender.goto(`${ORIGIN}/`);
  await lender
    .getByRole("region", { name: "Cards" })
    .getByRole("button", { name: /Boss's Orders/ })
    .first()
    .click();
  await bar.getByRole("button", { name: "Actions" }).click();
  await lender.route(/\/api\/social\/friends$/, (route) => route.abort(), {
    times: 1,
  });
  await bar.getByRole("button", { name: "Lend to a Friend…" }).click();
  const retry = dialog.getByRole("button", { name: "Retry" });
  await expect(retry).toBeVisible();
  await retry.click();
  const friend = dialog.getByRole("combobox", { name: "Friend" });
  await expect(friend).toBeFocused();
  await expect(retry).toHaveCount(0);
  await friend.selectOption({ label: "Ash K" });
  await send.click();
  await expect(dialog).toContainText("Offer sent to Ash K.");
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toBeHidden();
  await expect(lender.locator("#ws-heading")).toBeFocused();

  // She withdraws that offer from its Loan screen: her heading says she did, and Ash's says so, naming the cards.
  await lender.goto(`${ORIGIN}/loans`);
  await lender.getByRole("link", { name: /You offered Ash K 1 card/ }).click();
  await expect(title(lender)).toHaveText("You offered Ash K 1 card");
  const second = new URL(lender.url()).pathname;
  await lender.getByRole("button", { name: "More for this Loan" }).click();
  await lender.getByRole("menuitem", { name: "Withdraw offer" }).click();
  await lender
    .getByRole("group", { name: "Withdraw offer" })
    .getByRole("button", { name: "Withdraw offer" })
    .click();
  await expect(title(lender)).toHaveText("You withdrew your offer to Ash K");
  await page.goto(`${ORIGIN}${second}`);
  await expect(title(page)).toHaveText(
    "Misty W withdrew their offer to lend you 1 card"
  );
});
