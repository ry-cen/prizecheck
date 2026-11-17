// Hill-climb m12 s3 (Opus m11 F4): on a phone a Trade's decision actions stay within reach. Jordan counters Priya's
// proposal with five card lines, so Priya's Accept, Counter and Decline would sit well below the first screen; on a
// phone they come first, under the heading, after a one-line count of the copies and a Review cards link, and the
// builder's Jump to Send takes a keyboard or screen-reader collector to Send. Desktop keeps its own layout. The catalog
// is the Swap catalog (api/tests/want_list_swap_fixtures.py).
import { randomUUID } from "node:crypto";
import type { BrowserContextOptions, Locator, Page } from "@playwright/test";
import { expect, test } from "./support/collectors";
import {
  accountId,
  api,
  befriend,
  hold,
  nameCollector,
  ORIGIN,
  seedCatalog,
} from "./support/loans";
import { expectPageChecks } from "./support/page-check";
import { expectTouchTarget } from "./support/touch-target";
import {
  DESKTOP_SIZE,
  PHONE_SIZE,
  forTradeLeaf,
  propose,
  tradeView,
} from "./support/trades";

type Collectors = {
  signIn: (options?: {
    contextOptions?: BrowserContextOptions;
  }) => Promise<{ page: Page }>;
};

/** Priya proposes one Iono for one Iono; Jordan counters with five lines. Returns Priya's page and the Trade's id. */
async function counteredTrade(
  collectors: Collectors,
  options: BrowserContextOptions
) {
  const ids = seedCatalog();
  const { page: jordan } = await collectors.signIn();
  const { page } = await collectors.signIn({ contextOptions: options });
  await page.route(/^https:\/\/assets\.tcgdex\.net\//, (route) =>
    route.abort()
  );
  await nameCollector(jordan, "Jordan P");
  await nameCollector(page, "Priya R");
  await befriend(page, jordan);
  const jordanShelf = await forTradeLeaf(jordan, "Jordan Shelf");
  const priyaShelf = await forTradeLeaf(page, "Priya Shelf");
  for (const key of ["PAL 254", "PAF 80"])
    await hold(jordan, jordanShelf, ids[key], 2);
  for (const key of ["PAL 185", "SVI 166", "PAL 172"])
    await hold(page, priyaShelf, ids[key], 3);
  const thread = await propose(
    page,
    await accountId(jordan),
    [[ids["PAL 185"], 1]],
    [[ids["PAL 254"], 1]]
  );
  const first = await tradeView(jordan, thread);
  await api(jordan, "POST", `/api/trades/${thread}/offer`, {
    offer_id: first.offer_id,
    revision: first.revision,
    idempotency_key: randomUUID(),
    you_give: [
      { edition_id: ids["PAL 254"], quantity: "1" },
      { edition_id: ids["PAF 80"], quantity: "1" },
    ],
    you_get: [
      { edition_id: ids["PAL 185"], quantity: "2" },
      { edition_id: ids["SVI 166"], quantity: "1" },
      { edition_id: ids["PAL 172"], quantity: "1" },
    ],
  });
  return { page, thread };
}

const tabBar = (page: Page) =>
  page.locator('nav[aria-label="Main views"]:visible');

/** `locator` is fully on screen without scrolling, above the tab bar, and a 44 px target. */
async function expectWithinReach(page: Page, locator: Locator) {
  await expect(locator).toBeVisible();
  const box = (await locator.boundingBox())!;
  const nav = (await tabBar(page).boundingBox())!;
  expect(box.y, `${locator} top`).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height, `${locator} bottom`).toBeLessThanOrEqual(nav.y);
  await expectTouchTarget(locator, ["height"]);
}

test("phone: Accept, Counter and Decline come first on a five-line Counter, and work", async ({
  collectors,
}) => {
  const { page, thread } = await counteredTrade(collectors, PHONE_SIZE);
  await page.goto(`${ORIGIN}/trades/${thread}`);
  const main = page.getByRole("main");
  await expect(main.getByRole("heading", { level: 1 })).toHaveText(
    "Jordan P countered your Trade Proposal"
  );
  const lists = main.getByRole("list", { name: /^You (give|get)$/ });
  await expect(lists).toHaveCount(2);
  await expect(
    lists.getByRole("listitem").filter({ hasText: "×" })
  ).toHaveCount(5);
  // One group, in the first viewport without scrolling.
  const actions = main.getByRole("group", { name: "Trade actions" });
  await expect(actions).toHaveCount(1);
  const accept = actions.getByRole("button", { name: "Accept", exact: true });
  const counter = actions.getByRole("button", { name: "Counter", exact: true });
  const decline = actions.getByRole("button", { name: "Decline", exact: true });
  expect(await page.evaluate(() => scrollY)).toBe(0);
  for (const button of [accept, counter, decline])
    await expectWithinReach(page, button);
  // The summary counts copies, not printings: 2 + 1 + 1 given, 1 + 1 received.
  await expect(
    main.getByText("You give 4 cards · You get 2 cards")
  ).toBeVisible();
  await expectPageChecks(page, "a five-line Counter with its actions first");

  // DOM order is the visual and focus order: summary, Review cards, the group, then the cards, then the chat.
  expect(
    await page.evaluate(() => {
      const before = (a: Element, b: Element) =>
        !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
      const summary = [...document.querySelectorAll("main p")].find((p) =>
        p.textContent?.startsWith("You give")
      )!;
      const review = [...document.querySelectorAll("main a")].find(
        (a) => a.textContent === "Review cards"
      )!;
      const group = document.querySelector('[aria-label="Trade actions"]')!;
      const cards = document.querySelector(
        '[aria-label="Cards in this Trade"]'
      )!;
      const chat = document.querySelector("main textarea")!;
      const buttons = [...group.querySelectorAll("button")];
      return (
        before(summary, review) &&
        before(review, group) &&
        before(group, cards) &&
        before(cards, chat) &&
        buttons.map((b) => b.textContent).join() === "Accept,Counter,Decline"
      );
    })
  ).toBe(true);
  await main.evaluate((node) => {
    node.tabIndex = -1;
    node.focus();
  });
  const stops: string[] = [];
  for (let step = 0; step < 12 && !stops.includes("Decline"); step++) {
    await page.keyboard.press("Tab");
    stops.push(
      await page
        .locator(":focus")
        .evaluate((node) => (node.textContent ?? "").trim())
    );
  }
  const at = (label: string) => stops.indexOf(label);
  expect(at("Review cards")).toBeGreaterThanOrEqual(0);
  expect(at("Review cards")).toBeLessThan(at("Accept"));
  expect(at("Accept")).toBeLessThan(at("Counter"));
  expect(at("Counter")).toBeLessThan(at("Decline"));

  // Review cards scrolls to the lists and moves focus to them.
  const cards = main.getByRole("group", { name: "Cards in this Trade" });
  await main.getByRole("link", { name: "Review cards" }).tap();
  await expect(cards).toBeFocused();
  await expect(cards).toBeInViewport();
  await page.evaluate(() => scrollTo(0, 0));

  // Decline asks inline, as before; Keep it returns to the group with focus on Decline.
  await decline.tap();
  const asking = main.getByRole("group", { name: "Decline", exact: true });
  await expect(asking).toBeVisible();
  await expect(asking).toBeInViewport({ ratio: 1 });
  await expect(asking.locator("p")).toBeFocused();
  await expect(actions).toHaveCount(0);
  await asking.getByRole("button", { name: "Keep it" }).tap();
  await expect(asking).toHaveCount(0);
  await expect(decline).toBeFocused();
  await expectWithinReach(page, decline);

  // Accept works from where it is.
  await accept.tap();
  await expect(main.getByRole("heading", { level: 1 })).toHaveText(
    "Ready to swap with Jordan P"
  );
  expect((await tradeView(page, thread)).state).toBe("accepted");
});

test("phone: Counter opens the builder, and Jump to Send takes focus to Send", async ({
  collectors,
}) => {
  const { page, thread } = await counteredTrade(collectors, PHONE_SIZE);
  await page.goto(`${ORIGIN}/trades/${thread}`);
  const main = page.getByRole("main");
  await main
    .getByRole("group", { name: "Trade actions" })
    .getByRole("button", { name: "Counter", exact: true })
    .tap();
  await expect(page).toHaveURL(`${ORIGIN}/trades/${thread}/counter`);
  await expect(main.getByRole("heading", { level: 1 })).toHaveText(
    "Counter to Jordan P"
  );
  const send = main.getByRole("button", { name: "Send Counter" });
  await main
    .getByRole("button", { name: /^Increase .* you give$/ })
    .first()
    .tap();
  await expect(send).toBeEnabled();
  await expectPageChecks(page, "the Counter builder on a phone");

  // The link is a skip link: it shows when focused, and Enter moves focus to the Send group.
  const jump = main.getByRole("link", { name: "Jump to Send" });
  await jump.focus();
  await expect(jump).toBeInViewport();
  await jump.press("Enter");
  const group = main.getByRole("group", { name: "Send", exact: true });
  await expect(group).toBeFocused();
  await expect(send).toBeInViewport({ ratio: 1 });
  await send.tap();
  await expect(
    page.getByRole("region", { name: "Notifications" })
  ).toContainText("Counter sent to Jordan P");
  await expect(page).toHaveURL(`${ORIGIN}/trades/${thread}`);
});

test("desktop: the actions stay after the cards, with no summary or jump link", async ({
  collectors,
}) => {
  const { page, thread } = await counteredTrade(collectors, DESKTOP_SIZE);
  await page.goto(`${ORIGIN}/trades/${thread}`);
  const main = page.getByRole("main");
  const actions = main.getByRole("group", { name: "Trade actions" });
  await expect(actions).toBeVisible();
  await expect(main.getByRole("link", { name: "Review cards" })).toHaveCount(0);
  await expect(main.getByText(/^You give \d+ cards? · /)).toHaveCount(0);
  await expect(
    main.getByRole("group", { name: "Cards in this Trade" })
  ).toHaveCount(0);
  expect(
    await page.evaluate(() => {
      const group = document.querySelector('[aria-label="Trade actions"]')!;
      const list = document.querySelector('ul[aria-label="You get"]')!;
      return !!(
        list.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING
      );
    })
  ).toBe(true);
  await main.getByRole("button", { name: "Counter", exact: true }).click();
  await expect(main.getByRole("link", { name: "Jump to Send" })).toHaveCount(0);
});
