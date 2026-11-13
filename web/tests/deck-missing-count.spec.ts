import type { Response, Route } from "@playwright/test";
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
    for (const outcome of ["delayed", "failed"] as const) {
      test(`does not explain an old acquisition count after removing an unowned copy (${outcome} read)`, async ({
        collectors,
      }) => {
        const ids = seedCatalog();
        const owner = await collectors.signIn({ contextOptions: { viewport } });
        const active = owner.page;
        const deck = await createDeck(active, `Unowned ${randomUUID()}`);
        await setLine(active, deck, ids["SVE 5"], 2);
        const deckUrl = `${ORIGIN}/api/decks/${deck}`;
        const initialDeckResponse = active.waitForResponse(
          (response) =>
            response.url() === deckUrl && response.request().method() === "GET"
        );
        const initialCostResponse = active.waitForResponse(
          (response) =>
            response.url() === `${deckUrl}/cost` &&
            response.request().method() === "GET"
        );
        await active.goto(`${ORIGIN}/decks/${deck}`);
        const [deckResponse, costResponse] = await Promise.all([
          initialDeckResponse,
          initialCostResponse,
        ]);
        expect(deckResponse.ok()).toBe(true);
        expect(costResponse.ok()).toBe(true);
        const [initialDeck, initialCost] = await Promise.all([
          deckResponse.json(),
          costResponse.json(),
        ]);
        expect(initialCost.deck_list_revision).toBe(
          initialDeck.deck_list.revision
        );
        expect(initialCost.owner_revision).toBe(initialDeck.owner_revision);
        expect(initialCost.settings_revision).toBe(
          initialDeck.settings_revision
        );
        const summary = active.getByRole("group", {
          name: "Where this Deck's cards are",
        });
        await expect(summary).toContainText("Not owned2");
        // The matching cost response must also have reached React before editing: an older in-flight
        // cost can otherwise observe the edit and trigger a competing full Deck read.
        const costLine = summary.locator("..").locator(":scope > p");
        await expect(costLine).toContainText(/deck|Deck/);
        await active.getByRole("radio", { name: "List", exact: true }).click();
        let release!: () => void;
        let arrived!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const requested = new Promise<void>((resolve) => {
          arrived = resolve;
        });
        let handling: Promise<void> | undefined;
        const holdRead = async (route: Route) => {
          // Only the first full Deck GET after the edit belongs to this gate.
          if (route.request().method() !== "GET" || handling) {
            await route.fallback();
            return;
          }
          handling = (async () => {
            if (outcome === "failed")
              await route.fulfill({
                status: 503,
                contentType: "application/json",
                body: "{}",
              });
            else {
              await gate;
              await route.continue();
            }
          })();
          arrived();
          await handling;
        };
        await active.route(deckUrl, holdRead);
        let editedRevision: number | undefined;
        let refreshed: Promise<Response> | undefined;
        try {
          const editResponse = active.waitForResponse(
            (response) =>
              response.url() === `${deckUrl}/deck-list/changes` &&
              response.request().method() === "POST"
          );
          await active.getByRole("button", { name: /^Remove one / }).click();
          const edit = await editResponse;
          expect(edit.ok()).toBe(true);
          editedRevision = (await edit.json()).deck_list.revision;
          expect(editedRevision).toBeGreaterThan(
            initialDeck.deck_list.revision
          );
          await requested;
          await expect(summary).toContainText("Not owned1");
          if (outcome === "failed")
            await expect(
              active
                .getByRole("status")
                .filter({ hasText: "This Deck couldn't be loaded" })
            ).toBeVisible();
          await expect(summary).not.toContainText("more copy:");
          if (outcome === "delayed")
            refreshed = active.waitForResponse(
              (response) =>
                response.url() === deckUrl &&
                response.request().method() === "GET"
            );
        } finally {
          release();
          // Removing interception while continue is pending can auto-handle the paused request.
          await handling;
          await active.unroute(deckUrl, holdRead);
        }
        if (outcome === "delayed") {
          const response = await refreshed!;
          expect(response.ok()).toBe(true);
          expect((await response.json()).deck_list.revision).toBe(
            editedRevision
          );
          await expect(summary).toContainText("Not owned1");
          await expect(summary).not.toContainText("more copy:");
        }
      });
    }
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
