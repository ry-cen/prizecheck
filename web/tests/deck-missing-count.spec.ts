import { randomUUID } from "node:crypto";
import { test, expect } from "./support/collectors";
import { signInAsOwner } from "./support/sign-in";
import {
  befriend,
  createDeck,
  hold,
  lendHandedOver,
  nameCollector,
  ORIGIN,
  seedCatalog,
  setLine,
  unsorted,
} from "./support/loans";
import { forTradeLeaf, propose, tradeStep } from "./support/trades";

for (const viewport of [
  { width: 1280, height: 800 },
  { width: 375, height: 812 },
]) {
  test.describe(`missing counts at ${viewport.width}px`, () => {
    test.use({ viewport });
    test("explains the owned copy promised to a Trade before and after borrowing", async ({
      page,
      collectors,
    }) => {
      const ids = seedCatalog();
      const friend = await collectors.signIn();
      await nameCollector(friend.page, "Sam");
      await hold(friend.page, await unsorted(friend.page), ids["SVE 5"], 15);
      await signInAsOwner(page, "/decks");
      await nameCollector(page, "Jordan");
      await befriend(page, friend.page);
      await hold(
        page,
        await forTradeLeaf(page, "Trade binder"),
        ids["SVE 5"],
        20
      );
      const deck = await createDeck(page, `Weekend ${randomUUID()}`);
      await setLine(page, deck, ids["SVE 5"], 51);
      await page.goto(`${ORIGIN}/decks/${deck}`);
      const initialSummary = page.getByRole("group", {
        name: "Where this Deck's cards are",
      });
      await expect(initialSummary).toContainText("Not owned31");
      await expect(initialSummary).not.toContainText("more copy:");
      await expect(initialSummary).not.toContainText("more copies:");
      await page
        .getByRole("button", { name: "Ways to get missing cards" })
        .click();
      await expect(
        page.getByRole("region", { name: "Ways to get missing cards" })
      ).toContainText("31 of 51");
      const trade = await propose(page, friend.userId, [[ids["SVE 5"], 1]], []);
      await tradeStep(friend.page, trade, "accept");
      for (const borrowed of [0, 15]) {
        if (borrowed)
          await lendHandedOver(friend.page, page, [[ids["SVE 5"], 15]], deck);
        await page.goto(`${ORIGIN}/decks/${deck}`);
        const summary = page.getByRole("group", {
          name: "Where this Deck's cards are",
        });
        await expect(summary).toContainText(`Not owned${31 - borrowed}`);
        await expect(summary).toContainText(
          "Ways to get missing cards counts 1 more copy: a copy you own is promised in a Trade or Loan, or counted for another Deck."
        );
        await page
          .getByRole("button", { name: "Ways to get missing cards" })
          .click();
        await expect(
          page.getByRole("region", { name: "Ways to get missing cards" })
        ).toContainText(`${32 - borrowed} of 51`);
      }
      await tradeStep(page, trade, "confirm-swap");
      await tradeStep(friend.page, trade, "confirm-swap");
      await page.reload();
      const finalSummary = page.getByRole("group", {
        name: "Where this Deck's cards are",
      });
      await expect(finalSummary).toContainText("Not owned17");
      await expect(finalSummary).not.toContainText("more copy:");
      await expect(finalSummary).not.toContainText("more copies:");
      await page
        .getByRole("button", { name: "Ways to get missing cards" })
        .click();
      await expect(
        page.getByRole("region", { name: "Ways to get missing cards" })
      ).toContainText("17 of 51");
    });
  });
}
