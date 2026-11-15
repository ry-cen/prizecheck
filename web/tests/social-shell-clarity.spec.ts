import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { expect, test } from "./support/collectors";
import {
  accountId,
  api,
  befriend,
  hold,
  lendHandedOver,
  loanStep,
  loanView,
  nameCollector,
  ORIGIN,
  seedCatalog,
  unsorted,
} from "./support/loans";
import {
  DESKTOP_SIZE,
  PHONE_SIZE,
  forTradeLeaf,
  propose,
  tradeStep,
} from "./support/trades";

const heading = (page: Page) => page.getByRole("heading", { level: 1 });
const toast = (page: Page) =>
  page.getByRole("region", { name: "Notifications" });
async function confirm(page: Page, name: string) {
  const region = page.getByRole("region", {
    name: `Confirm swap with ${name}`,
  });
  await region
    .getByRole("button", { name: "Confirm swap", exact: true })
    .click();
  await region
    .getByRole("group", { name: "Confirm swap", exact: true })
    .getByRole("button", { name: "Confirm swap", exact: true })
    .click();
}

for (const [size, contextOptions] of [
  ["desktop", DESKTOP_SIZE],
  ["phone", PHONE_SIZE],
] as const) {
  test(`Loan activity adds context and colliding rows open their own Loan on ${size}`, async ({
    collectors,
  }) => {
    const ids = seedCatalog();
    const { page: lender } = await collectors.signIn({ contextOptions });
    const { page: borrower } = await collectors.signIn({ contextOptions });
    await nameCollector(lender, "Misty W");
    await nameCollector(borrower, "Ash K");
    await befriend(lender, borrower);
    await hold(lender, await unsorted(lender), ids["PAL 185"], 2);
    const first = await lendHandedOver(lender, borrower, [[ids["PAL 185"], 1]]);
    const second = await lendHandedOver(lender, borrower, [
      [ids["PAL 185"], 1],
    ]);
    const loans = await Promise.all([
      loanView(borrower, first),
      loanView(borrower, second),
    ]);
    const at = new Date();
    at.setHours(12, 0, 0, 0);
    await collectors.pool.query(
      "UPDATE thread SET last_activity_at=$1 WHERE id=$2",
      [at, loans[0].thread_id]
    );
    await collectors.pool.query(
      "UPDATE thread SET last_activity_at=$1 WHERE id=$2",
      [new Date(at.getTime() + 60000), loans[1].thread_id]
    );
    await borrower.goto(`${ORIGIN}/loans`);
    const rows = loans.map((loan) =>
      borrower.locator(`a[href="/loans/${loan.thread_id}"]`)
    );
    for (const row of rows) await expect(row).toContainText("Last activity");
    await expect(rows[0]).not.toHaveText(await rows[1].innerText(), {
      useInnerText: true,
    });
    await collectors.pool.query(
      "UPDATE thread SET last_activity_at=$1 WHERE id=ANY($2::uuid[])",
      [at, loans.map((loan) => loan.thread_id)]
    );
    await borrower.reload();
    await expect(rows[0]).toHaveText(await rows[1].innerText(), {
      useInnerText: true,
    });
    for (const loan of loans) {
      await borrower.locator(`a[href="/loans/${loan.thread_id}"]`).click();
      await expect(borrower).toHaveURL(`${ORIGIN}/loans/${loan.thread_id}`);
      await expect(heading(borrower)).toHaveText(
        "You have 1 card of Misty W's"
      );
      await borrower.goto(`${ORIGIN}/loans`);
    }
  });

  test(`one-card handover and lender return confirmation use the singular on ${size}`, async ({
    collectors,
  }) => {
    const ids = seedCatalog();
    const { page: lender } = await collectors.signIn({ contextOptions });
    const { page: borrower } = await collectors.signIn({ contextOptions });
    await nameCollector(lender, "Misty W");
    await nameCollector(borrower, "Ash K");
    await befriend(lender, borrower);
    await hold(lender, await unsorted(lender), ids["PAL 185"], 1);
    const sent = await api(borrower, "POST", "/api/loans", {
      lender_id: await accountId(lender),
      lines: [{ edition_id: ids["PAL 185"], quantity: "1" }],
      deck_id: null,
      return_by: null,
      idempotency_key: randomUUID(),
    });
    await loanStep(lender, sent.id, "accept", {
      lines: [{ edition_id: ids["PAL 185"], promised: "1" }],
    });
    await loanStep(lender, sent.id, "handover");
    await borrower.goto(`${ORIGIN}/loans/${sent.thread_id}`);
    await borrower
      .getByRole("button", { name: "Yes, I have it", exact: true })
      .click();
    await expect(heading(borrower)).toHaveText("You have 1 card of Misty W's");
    await borrower
      .getByRole("button", { name: "All back", exact: true })
      .click();
    await lender.goto(`${ORIGIN}/loans/${sent.thread_id}`);
    await expect(
      lender.getByRole("button", { name: "Yes, it's back", exact: true })
    ).toBeVisible();
    await lender
      .getByRole("button", { name: "Yes, it's back", exact: true })
      .click();
    await expect(heading(lender)).toHaveText("Your Loan to Ash K ended");
  });

  test(`first Confirm swap waits and the second completes on ${size}`, async ({
    collectors,
  }) => {
    const ids = seedCatalog();
    const { page: giver } = await collectors.signIn({ contextOptions });
    const { page: receiver } = await collectors.signIn({ contextOptions });
    await nameCollector(giver, "Misty W");
    await nameCollector(receiver, "Ash K");
    await befriend(giver, receiver);
    const shelf = await forTradeLeaf(giver, "Swap shelf");
    await hold(giver, shelf, ids["PAL 185"], 1);
    const destination = await unsorted(receiver);
    const trade = await propose(
      giver,
      await accountId(receiver),
      [[ids["PAL 185"], 1]],
      []
    );
    await tradeStep(receiver, trade, "accept");
    await receiver.goto(`${ORIGIN}/trades/${trade}`);
    await confirm(receiver, "Misty W");
    await expect(toast(receiver)).toContainText(
      "You confirmed the swap. 1 card is in Unsorted."
    );
    await expect(heading(receiver)).toHaveText(
      "Waiting for Misty W to confirm the swap"
    );
    const received = await api(receiver, "GET", `/api/holdings/${destination}`);
    expect(received.holdings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ edition_id: ids["PAL 185"], quantity: "1" }),
      ])
    );
    await giver.goto(`${ORIGIN}/trades/${trade}`);
    await confirm(giver, "Ash K");
    await expect(toast(giver)).toContainText(
      "Swapped. The cards you gave left your Collection."
    );
  });
}
