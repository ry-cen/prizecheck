import { randomUUID } from "node:crypto";
import { expect, test } from "./support/collectors";
import {
  accountId,
  api,
  befriend,
  hold,
  loanStep,
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
import { expectTouchTarget } from "./support/touch-target";

for (const [size, contextOptions] of [
  ["desktop", DESKTOP_SIZE],
  ["phone", PHONE_SIZE],
] as const) {
  test(`finished Loans have guidance on ${size}`, async ({ collectors }) => {
    const ids = seedCatalog();
    const { page: lender } = await collectors.signIn();
    const { page } = await collectors.signIn({ contextOptions });
    await befriend(lender, page);
    await hold(lender, await unsorted(lender), ids["PAL 185"], 1);
    await page.goto(`${ORIGIN}/loans`);
    await expect(
      page.getByText("No Loans yet.", { exact: true })
    ).toBeVisible();
    const loan = await api(page, "POST", "/api/loans", {
      lender_id: await accountId(lender),
      lines: [{ edition_id: ids["PAL 185"], quantity: "1" }],
      deck_id: null,
      return_by: null,
      idempotency_key: randomUUID(),
    });
    await loanStep(page, loan.id, "withdraw");
    await page.reload();
    await expect(
      page.getByText("No Loans in progress.", { exact: true })
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Lend from your Collection" })
    ).toHaveAttribute("href", "/collection");
    const done = page
      .locator("details")
      .filter({ has: page.getByText("Done", { exact: true }) });
    await expect(done).not.toHaveAttribute("open");
    await expect(done.getByRole("heading", { name: "Done" })).toBeVisible();
    await done.locator("summary").click();
    await expect(done.getByRole("link")).toHaveCount(1);
  });

  test(`swap confirmation layout on ${size}`, async ({ collectors }) => {
    const ids = seedCatalog();
    const { page: other } = await collectors.signIn();
    const { page } = await collectors.signIn({ contextOptions });
    await nameCollector(other, "Misty W");
    await befriend(other, page);
    await hold(
      other,
      await forTradeLeaf(other, "Trade shelf"),
      ids["PAL 185"],
      1
    );
    const id = await propose(
      other,
      await accountId(page),
      [[ids["PAL 185"], 1]],
      []
    );
    await tradeStep(page, id, "accept");
    await page.goto(`${ORIGIN}/trades/${id}`);
    const region = page.getByRole("region", {
      name: "Confirm swap with Misty W",
    });
    await region
      .getByRole("button", { name: "Confirm swap", exact: true })
      .click();
    const group = region.getByRole("group", {
      name: "Confirm swap",
      exact: true,
    });
    const question = group.locator("p");
    const yes = group.getByRole("button", {
      name: "Confirm swap",
      exact: true,
    });
    await expect(question).toBeFocused();
    await expect
      .poll(async () => {
        const text = (await question.boundingBox())!;
        const button = (await yes.boundingBox())!;
        return size === "phone"
          ? text.y + text.height <= button.y
          : text.x + text.width <= button.x;
      })
      .toBe(true);
    if (size === "phone") {
      await expectTouchTarget(yes);
      await expectTouchTarget(group.getByRole("button", { name: "Not yet" }));
      await expect
        .poll(() =>
          page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth
          )
        )
        .toBe(true);
    }
  });
}
