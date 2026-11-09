import { randomUUID } from "node:crypto";
import { test as base, expect } from "./support/collectors";
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
import { forTradeLeaf, propose, tradeView } from "./support/trades";
import { signInAsOwner } from "./support/sign-in";
import type { Page } from "@playwright/test";

const test = base.extend<
  { pair: { lender: Page } },
  { catalog: ReturnType<typeof seedCatalog> }
>({
  catalog: [
    async ({}, use) => {
      await use(seedCatalog());
    },
    { scope: "worker", timeout: 60_000 },
  ],
  pair: [
    async ({ page, collectors }, use) => {
      const lender = (await collectors.signIn({ next: "/loans" })).page;
      await nameCollector(lender, "Misty W");
      await signInAsOwner(page, "/loans");
      await nameCollector(page, "Ash K");
      await befriend(page, lender);
      await use({ lender });
    },
    { timeout: 60_000 },
  ],
});

test("current Trade cards retain their direction after a counter", async ({
  page,
  pair: { lender },
  catalog,
}) => {
  for (const on of [page, lender]) {
    const shelf = await forTradeLeaf(on, "Trade cards");
    await hold(on, shelf, catalog["PAL 185"], 2);
    await hold(on, shelf, catalog["SVI 166"], 2);
  }
  const id = await propose(
    page,
    await accountId(lender),
    [[catalog["PAL 185"], 1]],
    [[catalog["SVI 166"], 1]]
  );
  await page.goto(`${ORIGIN}/trades`);
  const row = page.locator(`a[data-thread="${id}"]`);
  const info = test.info();
  await expect(row).toContainText("You give 1 Iono · You get 1 Arven");
  await info.attach("trade-row-before-counter", {
    body: await row.innerText(),
    contentType: "text/plain",
  });
  const offer = await tradeView(lender, id);
  await api(lender, "POST", `/api/trades/${id}/offer`, {
    offer_id: offer.offer_id,
    revision: offer.revision,
    idempotency_key: randomUUID(),
    you_give: [{ edition_id: catalog["PAL 185"], quantity: "1" }],
    you_get: [{ edition_id: catalog["SVI 166"], quantity: "1" }],
  });
  await page.reload();
  await expect(row).toContainText("You give 1 Arven · You get 1 Iono");
  await expect(row).not.toContainText("→");
  await info.attach("trade-row-after-counter", {
    body: await row.innerText(),
    contentType: "text/plain",
  });
});

for (const outcome of ["Returned", "Written off"] as const) {
  test(`${outcome} remains clear to both Loan participants after a chat`, async ({
    page,
    pair: { lender },
    catalog,
  }) => {
    const info = test.info();
    const edition = catalog["PAL 185"];
    await hold(lender, await unsorted(lender), edition, 1);
    const id = await lendHandedOver(lender, page, [[edition, 1]]);
    if (outcome === "Returned") {
      await loanStep(page, id, "returns", { all: true });
      const loan = await loanView(lender, id);
      await api(
        lender,
        "POST",
        `/api/loans/${loan.thread_id}/returns/confirm`,
        {
          loan_id: loan.loan_id,
          revision: loan.revision,
          return_id: loan.pending_return!.return_id,
          idempotency_key: randomUUID(),
        }
      );
    } else {
      await loanStep(lender, id, "write-off", {
        lines: [{ edition_id: edition, quantity: "1" }],
      });
      const current = await loanView(page, id);
      const side = await api(
        page,
        "GET",
        `/api/loans/${current.thread_id}/side`
      );
      await api(page, "POST", `/api/loans/${current.thread_id}/written-off`, {
        loan_id: current.loan_id,
        revision: current.revision,
        idempotency_key: randomUUID(),
        choice: "keep",
        places: side.awaiting_choice.map(
          (place: {
            location_id: string;
            edition_id: string;
            copies: string;
          }) => ({
            location_id: place.location_id,
            edition_id: place.edition_id,
            copies: place.copies,
          })
        ),
      });
    }
    const loan = await loanView(page, id);
    await api(page, "POST", `/api/loans/${loan.thread_id}/messages`, {
      body: "Thanks for letting me know.",
      idempotency_key: randomUUID(),
    });
    for (const on of [page, lender]) {
      await on.goto(`${ORIGIN}/loans`);
      const row = on.locator(`a[data-thread="${loan.thread_id}"]`);
      await expect(row).toBeAttached();
      await row.evaluate((node) => {
        const details = node.closest("details");
        if (details) details.open = true;
      });
      await expect(row).toContainText(outcome);
      await expect(row).not.toContainText("written_off");
      await expect(row).not.toContainText("→");
      await info.attach(`${outcome}-${on === page ? "borrower" : "lender"}`, {
        body: await row.innerText(),
        contentType: "text/plain",
      });
    }
  });
}
