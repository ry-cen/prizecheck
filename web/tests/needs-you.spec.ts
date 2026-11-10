// #475 / UX blueprint D1: distinguish a waiting step from unread-only chat.
import { randomUUID } from "node:crypto";
import { expect, test } from "./support/collectors";
import {
  ORIGIN,
  accountId,
  api,
  befriend,
  hold,
  nameCollector,
  seedCatalog,
  unsorted,
} from "./support/loans";
import { forTradeLeaf, propose } from "./support/trades";
import { signInAsOwner } from "./support/sign-in";

for (const viewport of [
  { width: 1280, height: 800 },
  { width: 375, height: 812 },
]) {
  test.describe(`${viewport.width} × ${viewport.height}`, () => {
    test.use({ viewport });
    test("waiting steps and unread-only items explain the tab counts; the bell counts steps", async ({
      page,
      collectors,
    }, testInfo) => {
      test.slow(); // Multiple real collectors, catalog import and page loads.
      const ids = seedCatalog();
      const friend = (await collectors.signIn({ contextOptions: { viewport } }))
        .page;
      await nameCollector(friend, "Misty W");
      await signInAsOwner(page, "/collection");
      await nameCollector(page, "Ash K");
      await befriend(page, friend);
      for (const on of [page, friend])
        await on.route(/^https:\/\/assets\.tcgdex\.net\//, (route) =>
          route.abort()
        );
      await hold(
        friend,
        await forTradeLeaf(friend, "Binder"),
        ids["SVI 166"],
        3
      );
      await hold(page, await unsorted(page), ids["PAL 185"], 3);
      const owner = await accountId(page);
      const trade = await propose(friend, owner, [[ids["SVI 166"], 1]], []);
      const loan = (
        await api(friend, "POST", "/api/loans", {
          lender_id: owner,
          lines: [{ edition_id: ids["PAL 185"], quantity: "1" }],
          deck_id: null,
          idempotency_key: randomUUID(),
        })
      ).thread_id as string;
      // This outgoing proposal waits on Misty, so only its incoming chat needs Ash.
      const unread = await propose(
        page,
        await accountId(friend),
        [],
        [[ids["SVI 166"], 1]]
      );
      await api(friend, "POST", `/api/trades/${unread}/messages`, {
        body: "Can we meet Saturday?",
        idempotency_key: randomUUID(),
      });
      await page.goto(`${ORIGIN}/trades`);
      const nav = page.getByRole("navigation", { name: "Main views" });
      const trades = nav.getByRole("button", { name: /^Trades/ });
      const loans = nav.getByRole("button", { name: /^Loans/ });
      await expect(trades).toHaveAccessibleName(
        "Trades, 2 need you: 1 waiting on you, 1 with new messages"
      );
      await expect(loans).toHaveAccessibleName(
        "Loans, 1 need you: 1 waiting on you, 0 with new messages"
      );
      await expect(trades).toContainText("2");
      await expect(loans).toContainText("1");
      const waitingTrade = page
        .getByRole("list", { name: "Needs you Trades" })
        .locator(`a[data-thread="${trade}"]`);
      const unreadTrade = page
        .getByRole("list", { name: "Needs you Trades" })
        .locator(`a[data-thread="${unread}"]`);
      await expect(waitingTrade).toContainText("↗ Accept or counter");
      await expect(unreadTrade).toContainText("● New messages");
      await expect(unreadTrade).not.toContainText("↗");
      const evidence: Record<string, unknown> = {
        viewport,
        trades: await trades.getAttribute("aria-label"),
        loans: await loans.getAttribute("aria-label"),
        waitingTrade: await waitingTrade.innerText(),
        unreadTrade: await unreadTrade.innerText(),
      };
      const bell = page.getByRole("button", { name: /^Inbox/ });
      await expect(bell).toHaveAccessibleName("Inbox, 2 waiting");
      evidence.bell = await bell.getAttribute("aria-label");
      await bell.click();
      const drawer = page.getByRole("dialog", { name: "Inbox", exact: true });
      const waiting = drawer.getByRole("region", { name: "Waiting on you" });
      await expect(waiting.getByRole("link")).toHaveCount(2);
      await expect(waiting).toContainText("Misty W · Answer");
      evidence.drawer = await drawer.innerText();
      await drawer.getByRole("button", { name: "Close Inbox" }).click();
      await waitingTrade.click();
      const tradeAction = page
        .getByRole("main")
        .getByRole("button", { name: "Accept", exact: true });
      await expect(tradeAction).toBeVisible();
      evidence.tradeAction = await tradeAction.boundingBox();
      await loans.click();
      const waitingLoan = page
        .getByRole("list", { name: "Needs you Loans" })
        .locator(`a[data-thread="${loan}"]`);
      await expect(waitingLoan).toContainText("↗ Answer Loan");
      evidence.waitingLoan = await waitingLoan.innerText();
      await waitingLoan.click();
      const loanAction = page
        .getByRole("main")
        .getByRole("button", { name: "Accept", exact: true });
      await expect(loanAction).toBeVisible();
      evidence.loanAction = await loanAction.boundingBox();
      // The waiting Borrow Request's answer is on the first screen, unscrolled.
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
      for (const name of ["Accept", "Decline"]) {
        const button = page
          .getByRole("main")
          .getByRole("button", { name, exact: true });
        await expect(button).toBeInViewport();
        const box = await button.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.y).toBeGreaterThanOrEqual(0);
        expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
      }
      evidence.loanDecline = await page
        .getByRole("main")
        .getByRole("button", { name: "Decline", exact: true })
        .boundingBox();
      // A refused Accept shows its reason on the same screen as the button.
      await page.route(/\/api\/loans\/[^/]+\/accept$/, (route) =>
        route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({
            detail: {
              code: "NOT_ENOUGH_COPIES",
              available: "0",
              edition_id: ids["PAL 185"],
            },
          }),
        })
      );
      await loanAction.click();
      const refusal = page.getByRole("main").getByRole("alert");
      await expect(refusal).toContainText("You have only 0 of");
      await expect(refusal).toBeInViewport();
      // Keep the recorded geometry as evidence alongside the assertions above.
      console.log("NEEDS_YOU_EVIDENCE " + JSON.stringify(evidence));
      await testInfo.attach("needs-you-evidence", {
        body: JSON.stringify(evidence, null, 2),
        contentType: "application/json",
      });
    });
  });
}
