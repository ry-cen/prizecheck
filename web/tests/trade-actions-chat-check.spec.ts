// Hill-climb m12 s3 (Opus m11 F9): a Trade's chat check offers Retry only after a check has failed. While the check is
// still open the page says "Checking chat…" and nothing else; a failed check says so and offers Retry. At desktop width
// and at 375 px. The catalog is the Swap catalog (api/tests/want_list_swap_fixtures.py).
import type { BrowserContextOptions } from "@playwright/test";
import { expect, test } from "./support/collectors";
import {
  accountId,
  befriend,
  hold,
  nameCollector,
  ORIGIN,
  seedCatalog,
} from "./support/loans";
import {
  DESKTOP_SIZE,
  PHONE_SIZE,
  forTradeLeaf,
  propose,
} from "./support/trades";

for (const [label, options] of [
  ["desktop", DESKTOP_SIZE],
  ["phone", PHONE_SIZE],
] as [string, BrowserContextOptions][])
  test(`${label}: Retry shows only after the chat check has failed`, async ({
    collectors,
  }) => {
    const ids = seedCatalog();
    const { page: jordan } = await collectors.signIn();
    const { page } = await collectors.signIn({ contextOptions: options });
    await page.route(/^https:\/\/assets\.tcgdex\.net\//, (route) =>
      route.abort()
    );
    await nameCollector(jordan, "Jordan P");
    await nameCollector(page, "Priya R");
    await befriend(page, jordan);
    await hold(
      page,
      await forTradeLeaf(page, "Priya Shelf"),
      ids["PAL 185"],
      2
    );
    const thread = await propose(
      page,
      await accountId(jordan),
      [[ids["PAL 185"], 1]],
      []
    );

    // The Trade's own reads go through. The chat's permission read starts once the Trade is on screen: it is held, then
    // fails.
    const shown = page.getByRole("heading", {
      level: 1,
      name: "Waiting for Jordan P to answer",
    });
    let fail!: () => void;
    const gate = new Promise<void>((resolve) => {
      fail = resolve;
    });
    let held!: () => void;
    const arrived = new Promise<void>((resolve) => {
      held = resolve;
    });
    await page.route(`**/api/trades/${thread}`, async (route) => {
      if (route.request().method() !== "GET" || !(await shown.isVisible()))
        return route.continue();
      held();
      await gate;
      await route.abort();
    });
    await page.goto(`${ORIGIN}/trades/${thread}`);
    await arrived;
    const main = page.getByRole("main");
    await expect(main.getByText("Checking chat…")).toBeVisible();
    await expect(
      main.getByRole("button", { name: "Retry", exact: true })
    ).toHaveCount(0);
    // It stays that way for as long as the check is open.
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(resolve))
    );
    await expect(
      main.getByRole("button", { name: "Retry", exact: true })
    ).toHaveCount(0);

    fail();
    await expect(main.getByText("Chat couldn't be checked.")).toBeVisible();
    await expect(
      main.getByRole("button", { name: "Retry", exact: true })
    ).toBeVisible();
    await expect(main.getByText("Checking chat…")).toHaveCount(0);
  });
