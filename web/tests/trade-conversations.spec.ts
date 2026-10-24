// Ticket #298 (Trading Stage 2, "Conversations and messages"): two Friends talk in a conversation. Ash opens the empty
// conversation with Misty from her trader id and sends the first message; Misty's Trades tab counts it as unread, her
// list shows it, and opening it clears the badge. She replies and Ash, who stays on the page, sees it when the pulse
// moves. Ash then proposes a Trade by the API and the card appears inline; it opens the Trade, which links back to the
// conversation. Misty archives the conversation, and a new message from Ash brings it back. An old Trade link still
// opens. Nothing on these screens names a data source or a refresh. A second test shows a collector sending too fast
// being told to wait. Ash is the test's page, Misty signs in first; desktop width and 375 px.
// The catalog is the Swap catalog (api/tests/want_list_swap_fixtures.py).
import type { BrowserContextOptions, Page } from "@playwright/test";
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
  conversations,
  focusPulse,
  openConversation,
  seedMessages,
  timeline,
  timelineTrades,
  traderIdOf,
} from "./support/conversations";
import { expectPageChecks } from "./support/page-check";
import { signInAsOwner } from "./support/sign-in";
import { expectTouchTarget } from "./support/touch-target";
import {
  DESKTOP_SIZE,
  PHONE_SIZE,
  forTradeLeaf,
  propose,
} from "./support/trades";

const heading = (page: Page) => page.getByRole("heading", { level: 1 });
const composer = (page: Page) => page.getByRole("textbox", { name: "Message" });
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
  // 1. Set-up, through the API. Misty holds an Iono for trade; Ash and she are Friends.
  const ids = seedCatalog();
  const iono = ids["PAL 185"];
  const misty = (await collectors.signIn({ contextOptions })).page;
  await nameCollector(misty, "Misty W");
  await hold(misty, await forTradeLeaf(misty, "Trade Shelf"), iono, 1);
  await signInAsOwner(page, "/collection");
  await nameCollector(page, "Ash K");
  await befriend(page, misty);
  const mistyId = await accountId(misty);
  for (const on of [page, misty])
    await on.route(/^https:\/\/assets\.tcgdex\.net\//, (route) =>
      route.abort()
    );

  // 2. Ash opens the conversation by Misty's trader id: nothing said yet, an empty composer.
  const mistyTrader = await traderIdOf(misty);
  await page.goto(`${ORIGIN}/trades/with/${mistyTrader}`);
  await expect(heading(page)).toHaveText("Misty W");
  await expect(page.getByRole("main")).toContainText("New to trading");
  await expect(timeline(page).getByRole("listitem")).toHaveCount(0);
  await expect(composer(page)).toHaveValue("");
  await expectPageChecks(page, `an empty conversation at ${width}`);
  if (isPhone(page)) await expectTouchTarget(sendButton(page));

  // 3. Ash's first message opens the conversation and stays on the same address.
  const address = page.url();
  await composer(page).fill("Hi Misty!\nStill have that Iono?");
  await sendButton(page).click();
  const messages = timeline(page).getByRole("listitem");
  await expect(messages).toHaveCount(1);
  await expect(messages).toContainText("Hi Misty!");
  await expect(messages).toContainText("Still have that Iono?");
  await expect(composer(page)).toHaveValue("");
  expect(page.url()).toBe(address);

  // 4. Misty's Trades tab counts the unread conversation; her list shows it; opening it clears the count.
  await misty.goto(`${ORIGIN}/collection`);
  await expect(tradesTab(misty)).toHaveAccessibleName(
    "Trades, 1 unread conversation"
  );
  await tradesTab(misty).click();
  const ashRow = conversations(misty).getByRole("link", { name: /^Ash K/ });
  await expect(ashRow).toContainText("Unread");
  await expect(ashRow).toContainText("Hi Misty!");
  await expectPageChecks(
    misty,
    `the conversation list with one unread at ${width}`
  );
  await ashRow.click();
  await expect(heading(misty)).toHaveText("Ash K");
  await expect(timeline(misty).getByRole("listitem")).toContainText([
    /Hi Misty!/,
  ]);
  await expect(tradesTab(misty)).toHaveAccessibleName("Trades");

  // 5. Misty replies; Ash, still on the page, sees it when the pulse moves.
  await composer(misty).fill("Yes, 2 copies.");
  await sendButton(misty).click();
  await expect(timeline(misty).getByRole("listitem")).toHaveCount(2);
  await focusPulse(page);
  await expect(timeline(page).getByRole("listitem")).toContainText([
    /Hi Misty!/,
    /Yes, 2 copies\./,
  ]);

  // 6. Ash proposes by the API; the Trade appears as a card, which opens the Trade, which links back.
  const trade = await propose(page, mistyId, [], [[iono, 1]]);
  await focusPulse(page);
  await expect(timelineTrades(page)).toHaveText([
    /Waiting for Misty W to answer/,
  ]);
  await expectPageChecks(page, `a conversation with a Trade card at ${width}`);
  await timelineTrades(page).click();
  await expect(page).toHaveURL(`${ORIGIN}/trades/${trade}`);
  await page.getByRole("link", { name: "Conversation with Misty W" }).click();
  await expect(page).toHaveURL(
    new RegExp(`^${ORIGIN}/trades/conversation/[0-9a-f-]{36}$`)
  );
  await expect(heading(page)).toHaveText("Misty W");

  // 7. Misty sees the card, archives the conversation, and a new message brings it back.
  await openConversation(misty, "Ash K");
  await expect(timelineTrades(misty)).toHaveText([
    /Ash K sent you a Trade Proposal/,
  ]);
  await misty.getByRole("link", { name: "All conversations" }).click();
  const archive = misty.getByRole("button", {
    name: "Archive conversation with Ash K",
  });
  if (isPhone(misty)) await expectTouchTarget(archive);
  await archive.click();
  await expect(conversations(misty)).toHaveCount(0);
  await expect(misty.getByRole("main")).toContainText("No conversations yet.");
  await misty.getByRole("button", { name: "Archived conversations" }).click();
  await expect(
    conversations(misty).getByRole("link", { name: /^Ash K/ })
  ).toBeVisible();
  await expect(
    misty.getByRole("button", { name: "Unarchive conversation with Ash K" })
  ).toBeVisible();
  await misty.getByRole("button", { name: "Back to conversations" }).click();
  await expect(misty.getByRole("main")).toContainText("No conversations yet.");
  await composer(page).fill("Any news?");
  await sendButton(page).click();
  await expect(timeline(page).getByRole("listitem")).toContainText([
    /Hi Misty!/,
    /Yes, 2 copies\./,
    /Waiting for Misty W to answer/,
    /Any news\?/,
  ]);
  await focusPulse(misty);
  await expect(
    conversations(misty).getByRole("link", { name: /^Ash K/ })
  ).toContainText("Any news?");

  // 8. An old Trade link still opens.
  await misty.goto(`${ORIGIN}/trades/${trade}`);
  await expect(heading(misty)).toHaveText("Ash K sent you a Trade Proposal");

  // 9. Nothing names a data source or a refresh.
  await page.goto(`${ORIGIN}/trades`);
  await expect(page.getByRole("main")).not.toContainText(NO_SOURCES);
  await openConversation(page, "Misty W");
  await expect(page.getByRole("main")).not.toContainText(NO_SOURCES);
  await openConversation(misty, "Ash K");
  await expect(misty.getByRole("main")).not.toContainText(NO_SOURCES);
}

test.describe("desktop, conversations", () => {
  test.use(DESKTOP_SIZE);

  test("a Friend opens a conversation, messages, sees a Trade inline, reads, archives and comes back", async ({
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
  const misty = (await collectors.signIn({})).page;
  await nameCollector(misty, "Misty W");
  await signInAsOwner(page, "/collection");
  await nameCollector(page, "Ash K");
  await befriend(page, misty);
  return `${ORIGIN}/trades/with/${await traderIdOf(misty)}`;
}

const isPulse = (url: string) =>
  url.includes("/api/social/conversations/pulse");

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
