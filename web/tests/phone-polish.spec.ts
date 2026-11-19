// m13 s6 (Opus m12 F6): phone polish on Trades and Friends. At 375×812 with touch a Trade card tile reads its card
// name before its set and number, the keyboard hint stays off the chat, the Friends links line up with the content
// beside them, and the Confirm swap heading is a level-2 heading styled like its neighbours. Desktop keeps the name
// first and the hint.
import type { Locator, Page } from "@playwright/test";
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
  tradeStep,
} from "./support/trades";
import { expectTouchTarget } from "./support/touch-target";

const left = async (locator: Locator) => (await locator.boundingBox())!.x;

/** The first x of the text itself, not of the box it sits in. */
const textLeft = (locator: Locator) =>
  locator.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    return range.getBoundingClientRect().left;
  });

async function setup(
  collectors: Parameters<Parameters<typeof test>[2]>[0]["collectors"],
  contextOptions: typeof PHONE_SIZE
) {
  const ids = seedCatalog();
  const { page: other } = await collectors.signIn();
  const { page } = await collectors.signIn({ contextOptions });
  await nameCollector(other, "Misty W");
  await nameCollector(page, "Ash K");
  await befriend(other, page);
  await hold(
    other,
    await forTradeLeaf(other, "Other shelf"),
    ids["PAL 185"],
    1
  );
  await hold(page, await forTradeLeaf(page, "My shelf"), ids["SVI 166"], 1);
  const trade = await propose(
    other,
    await accountId(page),
    [[ids["PAL 185"], 1]],
    [[ids["SVI 166"], 1]]
  );
  await tradeStep(page, trade, "accept");
  return { page, other, trade };
}

async function openFriends(page: Page) {
  await page.getByRole("button", { name: "Friends", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Friends" })).toBeVisible();
}

for (const [label, contextOptions] of [
  ["phone", PHONE_SIZE],
  ["desktop", DESKTOP_SIZE],
] as const) {
  test(`Trade tiles, hint and swap heading on ${label}`, async ({
    collectors,
  }) => {
    const { page, trade } = await setup(collectors, contextOptions);
    await page.goto(`${ORIGIN}/trades/${trade}`);
    for (const list of ["You give", "You get"]) {
      const tile = page
        .getByRole("list", { name: list, exact: true })
        .getByRole("button")
        .first();
      const name = tile.locator('[id$="-name"]');
      const edition = tile.locator('[id$="-edition"]');
      await expect(name).toBeVisible();
      await expect(edition).toBeVisible();
      const [n, e] = [
        (await name.boundingBox())!,
        (await edition.boundingBox())!,
      ];
      // The name is above the set and number line (or, side by side on desktop, never below it).
      expect(n.y + n.height, `${list} name above set`).toBeLessThanOrEqual(
        e.y + 1
      );
    }
    const hint = page.getByText(/^(Ctrl|⌘)\+Enter to send$/);
    await expect(
      page.getByRole("textbox", { name: "Message Misty W" })
    ).toBeVisible();
    if (label === "phone") {
      expect(
        await page.evaluate(() => matchMedia("(hover: none)").matches)
      ).toBe(true);
      await expect(hint).toBeHidden();
    } else await expect(hint).toBeVisible();

    await expect(
      page.getByRole("region", { name: "Confirm swap with Misty W" })
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Confirm swap", level: 2 })
    ).toBeVisible();
    const weights = await page
      .getByRole("main")
      .getByRole("heading", { level: 2 })
      .evaluateAll((all) =>
        all.map((h) => [h.textContent, getComputedStyle(h).fontWeight])
      );
    const swapWeight = weights.find(([t]) => t === "Confirm swap")![1];
    for (const [text, weight] of weights)
      expect(weight, `${text} weight`).toBe(swapWeight);
  });
}

test("Friends links line up with their content on phone", async ({
  collectors,
}) => {
  const { page } = await setup(collectors, PHONE_SIZE);
  await page.goto(`${ORIGIN}/decks`);
  await openFriends(page);
  const drawer = page.getByRole("dialog", { name: "Friends" });
  const privacy = drawer.getByRole("button", { name: "Privacy and blocked" });
  const rowName = drawer
    .getByRole("region", { name: "Your Friends" })
    .getByText("Misty W", { exact: true });
  await expect(privacy).toBeVisible();
  expect(
    Math.abs((await textLeft(privacy)) - (await textLeft(rowName)))
  ).toBeLessThanOrEqual(1);
  await expectTouchTarget(privacy, ["height"]);

  await drawer
    .getByRole("button", { name: "Open Misty W's Collection" })
    .click();
  const link = page.getByRole("link", { name: "See Misty W's Trade List" });
  const sub = page.getByText(/^@\w+ · Cards they could lend now$/);
  await expect(link).toBeVisible();
  expect(
    Math.abs((await textLeft(link)) - (await textLeft(sub)))
  ).toBeLessThanOrEqual(1);
  await expectTouchTarget(link, ["height"]);
  expect(await left(link)).toBeGreaterThanOrEqual(0);
});
