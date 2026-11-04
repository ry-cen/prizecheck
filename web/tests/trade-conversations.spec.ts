// Item-thread chat: separate waiting/unread marks, live offer revisions, Done history, message refusals and pulse cadence.
import { randomUUID } from "node:crypto";
import type { BrowserContextOptions, Page } from "@playwright/test";
import { expect, test } from "./support/collectors";
import {
  api,
  accountId,
  befriend,
  hold,
  nameCollector,
  ORIGIN,
  seedCatalog,
} from "./support/loans";
import { focusPulse, seedMessages } from "./support/conversations";
import { expectPageChecks } from "./support/page-check";
import { signInAsOwner } from "./support/sign-in";
import { expectTouchTarget } from "./support/touch-target";
import {
  DESKTOP_SIZE,
  PHONE_SIZE,
  forTradeLeaf,
  propose,
  tradeView,
  tradeStep,
} from "./support/trades";

const timeline = (page: Page) =>
  page.getByRole("list", { name: "Messages and changes" });
const heading = (page: Page) => page.getByRole("heading", { level: 1 });
const composer = (page: Page) =>
  page.getByRole("textbox", { name: /^Message / });
const sendButton = (page: Page) => page.getByRole("button", { name: "Send" });
const tradesTab = (page: Page) =>
  page
    .getByRole("navigation", { name: "Main views" })
    .getByRole("button", { name: /^Trades/ });
const NO_SOURCES = /refresh|poll|updated \d|TCGdex|TCGplayer/i;
const isPhone = (page: Page) => (page.viewportSize()?.width ?? 1280) <= 760;

type Collectors = {
  signIn: (options?: {
    next?: string;
    contextOptions?: BrowserContextOptions;
  }) => Promise<{ page: Page }>;
};

async function story(
  page: Page,
  collectors: Collectors,
  contextOptions: BrowserContextOptions,
  width: string
) {
  const ids = seedCatalog();
  const iono = ids["PAL 185"];
  const misty = (await collectors.signIn({ contextOptions })).page;
  await nameCollector(misty, "Misty W");
  await hold(misty, await forTradeLeaf(misty, "Trade Shelf"), iono, 2);
  await signInAsOwner(page, "/collection");
  await nameCollector(page, "Ash K");
  await befriend(page, misty);
  for (const on of [page, misty])
    await on.route(/^https:\/\/assets\.tcgdex\.net\//, (route) =>
      route.abort()
    );
  // Chat belongs to an item. Opening it preserves one live offer and an empty draft.
  const thread = await propose(page, await accountId(misty), [], [[iono, 1]]);
  const first = await tradeView(page, thread);
  const address = `${ORIGIN}/trades/${thread}`;
  await page.goto(address);
  await expect(heading(page)).toHaveText("Waiting for Misty W to answer");
  await expect(page.getByRole("main")).toContainText("New to trading");
  await expect(composer(page)).toHaveValue("");
  await expect(timeline(page).getByRole("listitem")).toHaveCount(1);
  await expectPageChecks(page, `an item with empty chat at ${width}`);
  if (isPhone(page)) await expectTouchTarget(sendButton(page));
  await composer(page).fill("Hi Misty!\nStill have that Iono?");
  await sendButton(page).click();
  await expect(timeline(page)).toContainText(
    "Hi Misty!\nStill have that Iono?"
  );
  await expect(composer(page)).toHaveValue("");
  await expect(timeline(page).getByRole("listitem")).toHaveCount(2);
  expect(page.url()).toBe(address);

  // Waiting and unread overlap: reading clears only unread, never the answer step.
  await misty.goto(`${ORIGIN}/collection`);
  await expect(tradesTab(misty)).toHaveAccessibleName(
    "Trades, 1 need you: 1 waiting on you, 1 with new messages"
  );
  await tradesTab(misty).click();
  const row = misty.locator(`a[data-thread="${thread}"]`);
  await expect(row).toContainText("Ash K");
  await expect(row).toContainText("New messages");
  await expect(row).toContainText("Ash K: Hi Misty!\nStill have that Iono?");
  await expect(row).toContainText("Accept or counter");
  await expectPageChecks(misty, `waiting and unread on one item at ${width}`);
  await row.click();
  await expect(heading(misty)).toHaveText("Ash K sent you a Trade Proposal");
  await expect(
    misty.getByRole("button", { name: "Accept", exact: true })
  ).toHaveClass(/bg-accent(?:\s|$)/);
  await expect(
    misty.getByRole("button", { name: "Counter", exact: true })
  ).toHaveClass(/bg-surface-raised/);
  await expect(
    misty.getByRole("button", { name: "Counter", exact: true })
  ).not.toHaveClass(/bg-accent(?:\s|$)/);
  await expect(timeline(misty)).toContainText("Hi Misty!");
  await expect(tradesTab(misty)).toHaveAccessibleName(
    "Trades, 1 need you: 1 waiting on you, 0 with new messages"
  );
  await composer(misty).fill("Yes, 2 copies.");
  await sendButton(misty).click();
  await focusPulse(page);
  await expect(timeline(page)).toContainText("Misty W: Yes, 2 copies.");
  await expect(timeline(page).getByRole("listitem")).toHaveCount(3);

  // Revisions stay on this item; the old quantity is a diff, not another current offer.
  await api(page, "POST", `/api/trades/${thread}/offer`, {
    offer_id: first.offer_id,
    revision: first.revision,
    idempotency_key: randomUUID(),
    you_give: [],
    you_get: [{ edition_id: iono, quantity: "2" }],
  });
  await focusPulse(page);
  await expect(timeline(page)).toContainText("You: Revised the offer");
  await expect(timeline(page).getByRole("listitem")).toHaveCount(4);
  await expect(timeline(page)).toContainText("They give Iono (PAL 185): 1 → 2");
  await expect(
    page.getByRole("list", { name: "You get", exact: true })
  ).toContainText("×2");
  await expect(page).toHaveURL(address);
  await expectPageChecks(page, `live revised terms and their diff at ${width}`);

  // Done replaces the retired Archive action. Closing removes waiting; a message on
  // the closed item brings that same item into Needs you until read.
  await tradeStep(page, thread, "withdraw");
  await misty.goto(`${ORIGIN}/trades`);
  await expect(tradesTab(misty)).toHaveAccessibleName("Trades");
  await misty.getByText("Done", { exact: true }).click();
  await expect(row).toBeVisible();
  await page.goto(address);
  await composer(page).fill("Any news?");
  // A click starts the POST; only its successful response makes the next pulse meaningful.
  const sent = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `/api/trades/${thread}/messages` &&
      response.request().method() === "POST" &&
      response.status() === 201
  );
  await sendButton(page).click();
  await sent;
  await focusPulse(misty);
  await expect(tradesTab(misty)).toHaveAccessibleName(
    "Trades, 1 need you: 0 waiting on you, 1 with new messages"
  );
  await expect(
    misty
      .getByRole("region", { name: "Needs you" })
      .locator(`a[data-thread="${thread}"]`)
  ).toContainText("New messages");
  await row.click();
  await expect(heading(misty)).toHaveText("Ash K withdrew this Trade Proposal");
  await expect(timeline(misty)).toContainText("Hi Misty!");
  await expect(timeline(misty)).toContainText("Yes, 2 copies.");
  await expect(timeline(misty)).toContainText("Revised the offer");
  await expect(timeline(misty)).toContainText("Any news?");
  await expect(timeline(misty).getByRole("listitem")).toHaveCount(6);
  await expect(tradesTab(misty)).toHaveAccessibleName("Trades");
  await misty.goto(`${ORIGIN}/trades/${first.offer_id}`);
  await expect(misty).toHaveURL(address);
  await expect(heading(misty)).toHaveText("Ash K withdrew this Trade Proposal");
  for (const on of [page, misty]) {
    await expect(on.getByRole("main")).not.toContainText(NO_SOURCES);
    await expectPageChecks(on, `closed item with retained chat at ${width}`);
  }
}

test.describe("desktop, conversations", () => {
  test.use(DESKTOP_SIZE);

  test("Friends message on an item, review a revision, close it and read a new message from Done", async ({
    page,
    collectors,
  }) => {
    // Two collectors in two contexts, a catalog seed and several page checks: well over 30 s on a loaded host.
    test.slow();
    await story(page, collectors, DESKTOP_SIZE, "desktop width");
  });
});

test.describe("phone, conversations", () => {
  test.use(PHONE_SIZE);

  test("the same at 375 px, with no sideways scroll and touch-sized controls", async ({
    page,
    collectors,
  }) => {
    test.slow();
    await story(page, collectors, PHONE_SIZE, "375 px");
  });
});

/** Ash (the test's page) and Misty, Friends, both named. */
async function twoFriends(page: Page, collectors: Collectors) {
  const ids = seedCatalog();
  const misty = (await collectors.signIn({})).page;
  await nameCollector(misty, "Misty W");
  await hold(
    misty,
    await forTradeLeaf(misty, "Chat Trade Shelf"),
    ids["PAL 185"],
    1
  );
  await signInAsOwner(page, "/collection");
  await nameCollector(page, "Ash K");
  await befriend(page, misty);
  return `${ORIGIN}/trades/${await propose(page, await accountId(misty), [], [[ids["PAL 185"], 1]])}`;
}

const isPulse = (url: string) => url.includes("/api/threads/pulse");

test.describe("rate limit", () => {
  test.use(DESKTOP_SIZE);

  test("a collector sending too fast is told to wait", async ({
    page,
    collectors,
  }) => {
    const conversation = await twoFriends(page, collectors);
    await seedMessages(page, 120, 30);
    await page.goto(conversation);
    await composer(page).fill("One more");
    await sendButton(page).click();
    await expect(page.getByRole("alert")).toHaveText(
      "You're sending messages quickly. Try again in a few minutes."
    );
    await expect(composer(page)).toHaveValue("One more");
  });

  test("a paste over 4,000 characters is refused in the composer with the length message", async ({
    page,
    collectors,
  }) => {
    const conversation = await twoFriends(page, collectors);
    await page.goto(conversation);
    let sent = 0;
    page.on("request", (request) => {
      if (request.method() === "POST" && request.url().includes("/messages"))
        sent++;
    });
    await composer(page).fill("é".repeat(4001));
    await sendButton(page).click();
    await expect(page.getByRole("alert")).toHaveText(
      "Messages can be up to 1,000 characters."
    );
    expect(sent).toBe(0);
    await expect(composer(page)).not.toHaveValue("");
    // Past 1,000 and up to 4,000 characters the server refuses it, with the same words.
    await composer(page).fill("é".repeat(1001));
    await sendButton(page).click();
    await expect(page.getByRole("alert")).toHaveText(
      "Messages can be up to 1,000 characters."
    );
    expect(sent).toBe(1);
  });
});

test.describe("pulse timing", () => {
  test.use(DESKTOP_SIZE);

  test("the pulse is read every 15 s on a conversation page, every 60 s elsewhere and never while hidden", async ({
    page,
    collectors,
  }) => {
    const conversation = await twoFriends(page, collectors);
    let pulses = 0;
    page.on("request", (request) => {
      if (isPulse(request.url())) pulses++;
    });
    const load = async (url: string) => {
      const first = page.waitForResponse((response) => isPulse(response.url()));
      await page.goto(url);
      await first;
      await expect(page.getByRole("main")).toBeVisible();
      return pulses;
    };
    await page.clock.install();

    // A conversation page: the first read, none before 15 s, one at 15 s.
    const base = await load(conversation);
    await page.clock.runFor(14_000);
    await expect.poll(() => pulses).toBe(base);
    await page.clock.runFor(1_000);
    await expect.poll(() => pulses).toBe(base + 1);

    // Hidden: none however long, and one at once on becoming visible.
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "hidden",
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.clock.runFor(120_000);
    await expect.poll(() => pulses).toBe(base + 1);
    const answered = page.waitForResponse((response) =>
      isPulse(response.url())
    );
    await page.evaluate(() => {
      delete (document as unknown as Record<string, unknown>).visibilityState;
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect.poll(() => pulses).toBe(base + 2);
    await answered;

    // Any other page: none at 15 s, one at 60 s.
    const other = await load(`${ORIGIN}/collection`);
    await page.clock.runFor(15_000);
    await expect.poll(() => pulses).toBe(other);
    await page.clock.runFor(45_000);
    await expect.poll(() => pulses).toBe(other + 1);
  });
});
