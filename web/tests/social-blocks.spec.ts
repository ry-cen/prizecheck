// Ticket #248: Blocks (spec "Blocks and Hidden Locations", "Web screens"). Two collectors on one stack (the collectors
// harness): one blocks the other from the Friends drawer, which ends the friendship; the blocked collector then finds
// nobody by the blocker's Handle and a dead end at their Invite Link; the blocker unblocks in Settings › Privacy. The
// other collector signs in first, so the test's own page signs in afterwards as a new account.
// Ticket #274 (Trading spec "Unfriend, Block and half-confirmed Trades"): Ash blocks Misty with his Trade Proposal, a
// Trade nobody has confirmed and a Trade only he confirmed open. The question counts them; the Block cancels the first
// two, and Misty, Blocked, finishes the third alone, while nothing she sees says Block. At desktop width and 375 px.
import { randomInt, randomUUID } from "node:crypto";
import type { BrowserContextOptions, Page, Route } from "@playwright/test";
import { expect, test } from "./support/collectors";
import {
  accountId,
  befriend,
  hold,
  nameCollector as named,
  seedCatalog,
} from "./support/loans";
import { expectPageChecks } from "./support/page-check";
import { signInAsOwner } from "./support/sign-in";
import {
  DESKTOP_SIZE,
  PHONE_SIZE,
  forTradeLeaf,
  propose,
  tradeStep,
} from "./support/trades";

const ORIGIN = process.env.TEST_ORIGIN || "http://localhost:5173";

async function api(
  page: Page,
  method: "PUT" | "POST",
  path: string,
  data: object
) {
  const response = await page.request.fetch(`${ORIGIN}${path}`, {
    method,
    headers: { origin: ORIGIN },
    data: { ...data, idempotency_key: randomUUID() },
  });
  expect(response.status(), path).toBe(200);
  return response.json();
}

/** Gives the signed-in collector this Display Name and a new Handle, through the API, and returns the Handle. */
async function nameCollector(page: Page, name: string): Promise<string> {
  // Ten random consonants: never a word the name filter refuses.
  const tail = Array.from(
    { length: 10 },
    () => "bcdfghjklmnpqrstvwxz"[randomInt(20)]
  ).join("");
  const handle = `${name.split(" ")[0].toLowerCase()}_${tail}`;
  await api(page, "PUT", "/api/profile/display-name", { display_name: name });
  await api(page, "PUT", "/api/profile/handle", { handle });
  return handle;
}

const drawer = (page: Page) => page.getByRole("dialog", { name: "Friends" });

async function openFriends(page: Page) {
  await page.getByRole("button", { name: "Friends", exact: true }).click();
  await expect(drawer(page)).toBeVisible();
}

async function find(page: Page, handle: string) {
  await drawer(page).getByRole("button", { name: "Add" }).click();
  await drawer(page)
    .getByRole("textbox", { name: "Their Handle" })
    .fill(handle);
  await drawer(page).getByRole("button", { name: "Find" }).click();
}

test("Block ends the friendship and hides the blocker, and Settings › Privacy unblocks", async ({
  page,
  collectors,
}) => {
  const misty = await collectors.signIn({ next: "/decks" });
  const mistyHandle = await nameCollector(misty.page, "Misty W");
  await signInAsOwner(page, "/decks");
  const ashHandle = await nameCollector(page, "Ash K");
  // Friends already, through the API.
  const ash = (await api(page, "POST", "/api/social/lookup", {
    handle: ashHandle,
  })) as { collector_id: string };
  await api(misty.page, "POST", "/api/social/friend-requests", {
    collector_id: ash.collector_id,
  });
  await api(
    page,
    "POST",
    `/api/social/friend-requests/${misty.userId}/accept`,
    {}
  );
  const ashToken = (
    (await (await page.request.get(`${ORIGIN}/api/profile`)).json()) as {
      invite_token: string;
    }
  ).invite_token;

  // Ash blocks Misty from her ⋯, after a confirmation.
  await page.reload();
  await openFriends(page);
  const friends = drawer(page).getByRole("region", { name: "Your Friends" });
  await friends.getByRole("button", { name: "More for Misty W" }).click();
  await page.getByRole("menuitem", { name: "Block" }).click();
  await expect(friends).toContainText("Block Misty W? They won't be told.");
  await friends.getByRole("button", { name: "Block", exact: true }).click();
  await expect(drawer(page).getByRole("status")).toHaveText(
    "Blocked Misty W. They aren't told."
  );
  await expect(friends).toContainText("No Friends yet.");

  // Misty is no longer Ash's Friend, finds nobody by his Handle, and his link is a dead end.
  await misty.page.reload();
  await openFriends(misty.page);
  await expect(
    drawer(misty.page).getByRole("region", { name: "Your Friends" })
  ).toContainText("No Friends yet.");
  await find(misty.page, ashHandle);
  await expect(drawer(misty.page).getByRole("alert")).toHaveText(
    "No collector has that Handle."
  );
  await misty.page.goto(`${ORIGIN}/invite/${ashToken}`);
  await expect(misty.page.getByRole("heading", { level: 1 })).toHaveText(
    "This link no longer works"
  );

  // Ash still finds Misty, with Unblock; Privacy and blocked leads to Settings, where he unblocks her.
  await find(page, mistyHandle);
  const result = drawer(page).getByRole("group", { name: "Search result" });
  await expect(result).toContainText("You blocked Misty W.");
  await expect(result.getByRole("button", { name: "Unblock" })).toBeVisible();
  await drawer(page)
    .getByRole("button", { name: "Privacy and blocked" })
    .click();
  await expect(page).toHaveURL(`${ORIGIN}/settings`);
  const blocked = page.getByRole("region", { name: "Blocked collectors" });
  await expect(blocked.getByRole("listitem")).toHaveCount(1);
  await expect(blocked.getByRole("listitem")).toContainText(
    `Misty W @${mistyHandle}`
  );
  await blocked.getByRole("button", { name: "Unblock Misty W" }).click();
  await expect(blocked.getByRole("status")).toHaveText("Unblocked Misty W.");
  await expect(blocked).toContainText("You haven't blocked anyone.");
  // The row is gone; focus goes to the section's heading.
  await expect(
    blocked.getByRole("heading", { name: "Blocked collectors" })
  ).toBeFocused();

  // Misty can find Ash and ask again; they aren't Friends until he accepts.
  await misty.page.goto(`${ORIGIN}/invite/${ashToken}`);
  await expect(misty.page.getByRole("heading", { level: 1 })).toHaveText(
    "Ash K invited you to PrizeCheck"
  );
  await expect(
    misty.page.getByRole("button", { name: "Send Friend Request" })
  ).toBeVisible();
});

test("Block from a received request's row removes the request, and the blocker unblocks from the Invite Link", async ({
  page,
  collectors,
}) => {
  const misty = await collectors.signIn({ next: "/decks" });
  await nameCollector(misty.page, "Misty W");
  await signInAsOwner(page, "/decks");
  const ashHandle = await nameCollector(page, "Ash K");
  const ash = (await api(misty.page, "POST", "/api/social/lookup", {
    handle: ashHandle,
  })) as { collector_id: string };
  await api(misty.page, "POST", "/api/social/friend-requests", {
    collector_id: ash.collector_id,
  });
  const mistyToken = (
    (await (await misty.page.request.get(`${ORIGIN}/api/profile`)).json()) as {
      invite_token: string;
    }
  ).invite_token;

  // Ash blocks Misty from the request's own row, after the same confirmation.
  await page.reload();
  await page.getByRole("button", { name: "Friends, 1 request" }).click();
  const received = drawer(page).getByRole("region", {
    name: "Friend Requests",
  });
  await received.getByRole("button", { name: "More for Misty W" }).click();
  await page.getByRole("menuitem", { name: "Block" }).click();
  await expect(received).toContainText("Block Misty W? They won't be told.");
  const confirm = received.getByRole("button", { name: "Block", exact: true });
  await expect(confirm).toBeFocused();
  // A failed Block leaves the row, shows the problem and returns focus to the row's ⋯.
  const refuse = (route: Route) =>
    route.fulfill({ status: 500, body: "{}", contentType: "application/json" });
  await page.route("**/api/social/blocks", refuse);
  await confirm.click();
  await expect(drawer(page).getByRole("alert")).toContainText(
    "Couldn't update"
  );
  await expect(
    received.getByRole("button", { name: "More for Misty W" })
  ).toBeFocused();
  await page.unroute("**/api/social/blocks", refuse);
  await received.getByRole("button", { name: "More for Misty W" }).click();
  await page.getByRole("menuitem", { name: "Block" }).click();
  await expect(confirm).toBeFocused();
  await confirm.click();
  await expect(drawer(page).getByRole("status")).toHaveText(
    "Blocked Misty W. They aren't told."
  );
  await expect(received).toHaveCount(0);
  await expect(
    drawer(page).getByRole("heading", { name: "Your Friends" })
  ).toBeFocused();

  // Misty finds nobody by Ash's Handle, and nothing she sees says Block.
  const missed = await misty.page.request.post(`${ORIGIN}/api/social/lookup`, {
    headers: { origin: ORIGIN },
    data: { handle: ashHandle },
  });
  expect(missed.status()).toBe(404);
  await misty.page.reload();
  await openFriends(misty.page);
  await find(misty.page, ashHandle);
  await expect(drawer(misty.page).getByRole("alert")).toHaveText(
    "No collector has that Handle."
  );
  await expect(misty.page.locator("body")).not.toContainText("Block");

  // Ash opens Misty's Invite Link: he sees he blocked her, and Unblock gives way to Send Friend Request.
  await page.goto(`${ORIGIN}/invite/${mistyToken}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Misty W invited you to PrizeCheck"
  );
  await expect(page.getByRole("main").getByRole("status")).toHaveText(
    "You blocked Misty W."
  );
  await page.getByRole("button", { name: "Unblock" }).click();
  await expect(
    page.getByRole("button", { name: "Send Friend Request" })
  ).toBeFocused();
  await expect(page.getByRole("button", { name: "Unblock" })).toHaveCount(0);
});

/** Ash blocks Misty with his proposal, a Trade nobody confirmed and a Trade only he confirmed open. */
async function tradeStory(
  page: Page,
  collectors: {
    signIn: (options?: {
      next?: string;
      contextOptions?: BrowserContextOptions;
    }) => Promise<{ page: Page }>;
  },
  contextOptions: BrowserContextOptions,
  width: string
) {
  const ids = seedCatalog();
  const iono = ids["PAL 185"];
  const arven = ids["SVI 166"];
  const misty = (await collectors.signIn({ next: "/trades", contextOptions }))
    .page;
  await named(misty, "Misty W");
  await hold(misty, await forTradeLeaf(misty, "Trade Shelf"), iono, 2);
  await misty.route(/^https:\/\/assets\.tcgdex\.net\//, (route) =>
    route.abort()
  );
  await page.route(/^https:\/\/assets\.tcgdex\.net\//, (route) =>
    route.abort()
  );
  await signInAsOwner(page, "/trades");
  await named(page, "Ash K");
  await hold(page, await forTradeLeaf(page, "Trade Box"), arven, 3);
  await befriend(page, misty);
  const mistyId = await accountId(misty);
  // Ash's proposal waits for Misty; she accepted his second; she accepted his gift, and only he confirmed it.
  await propose(page, mistyId, [[arven, 1]], [[iono, 1]]);
  const accepted = await propose(page, mistyId, [[arven, 1]], [[iono, 1]]);
  await tradeStep(misty, accepted, "accept");
  const half = await propose(page, mistyId, [[arven, 1]], []);
  await tradeStep(misty, half, "accept");
  await tradeStep(page, half, "confirm-swap");

  // With the Trades unreadable, the question says nothing it can't count.
  const offline = (route: Route) => route.abort();
  await page.route(/\/api\/social\/trades$/, offline);
  await page.goto(`${ORIGIN}/trades`);
  await openFriends(page);
  const friends = drawer(page).getByRole("region", { name: "Your Friends" });
  await friends.getByRole("button", { name: "More for Misty W" }).click();
  await page.getByRole("menuitem", { name: "Block" }).click();
  await expect(friends.getByText(/^Block Misty W\?/)).toHaveText(
    "Block Misty W? They won't be told."
  );
  await friends.getByRole("button", { name: "Cancel" }).click();
  await page.unroute(/\/api\/social\/trades$/, offline);

  // Ash blocks Misty: the question counts what it cancels and what stays.
  await page.reload();
  await openFriends(page);
  await friends.getByRole("button", { name: "More for Misty W" }).click();
  await page.getByRole("menuitem", { name: "Block" }).click();
  await expect(friends.getByText(/^Block Misty W\?/)).toHaveText(
    "Block Misty W? They won't be told. This cancels 1 Trade Proposal and 1 Trade that hasn't been swapped. 1 Trade that one of you has confirmed stays open so it can finish."
  );
  await expectPageChecks(page, `the Block question with Trades at ${width}`);
  await friends.getByRole("button", { name: "Block", exact: true }).click();
  await expect(drawer(page).getByRole("status")).toHaveText(
    "Blocked Misty W. They aren't told."
  );
  await drawer(page).getByRole("button", { name: "Close Friends" }).click();
  // His list, read again: the Trade he confirmed waits for Misty; the other two are history.
  await expect(
    page.getByRole("list", { name: "Pending" }).getByRole("link")
  ).toHaveText([/Waiting for Misty W to confirm the swap/]);
  await page.locator("summary", { hasText: "History · 2" }).click();
  await expect(
    page.getByRole("list", { name: "History" }).getByRole("link")
  ).toHaveText([/You cancelled this Trade/, /You cancelled this Trade/]);

  // Misty, Blocked: Ash cancelled two Trades, and the one he confirmed is hers to finish. Nothing says Block.
  await misty.goto(`${ORIGIN}/trades`);
  const needsYou = misty.getByRole("list", { name: "Needs you" });
  await expect(needsYou.getByRole("link")).toHaveText([
    /Ash K confirmed the swap/,
  ]);
  await misty.locator("summary", { hasText: "History · 2" }).click();
  await expect(
    misty.getByRole("list", { name: "History" }).getByRole("link")
  ).toHaveText([/Ash K cancelled this Trade/, /Ash K cancelled this Trade/]);
  await expect(misty.locator("body")).not.toContainText(/block/i);
  await misty.getByRole("button", { name: /^Inbox/ }).click();
  const inbox = misty.getByRole("dialog", { name: "Inbox" });
  await expect(
    inbox
      .getByRole("region", { name: "Earlier" })
      .getByRole("link", { name: /Ash K cancelled this Trade/ })
  ).toHaveCount(2);
  await expect(inbox).not.toContainText(/block/i);
  await expectPageChecks(misty, `a Blocked collector's inbox at ${width}`);
  await inbox.getByRole("button", { name: "Close Inbox" }).click();

  // She confirms alone: Ash's Arven goes to her Unsorted, and the Trade is swapped.
  await needsYou.getByRole("link").click();
  await expect(misty).toHaveURL(`${ORIGIN}/trades/${half}`);
  const main = misty.getByRole("main");
  await expect(main.getByRole("heading", { level: 1 })).toHaveText(
    "Ash K confirmed the swap"
  );
  await main.getByRole("button", { name: "Confirm swap" }).click();
  await misty
    .getByRole("dialog", { name: "Confirm swap with Ash K?" })
    .getByRole("button", { name: "Confirm swap" })
    .click();
  await expect(main.getByRole("heading", { level: 1 })).toHaveText(
    "Swapped with Ash K"
  );
  await expect(misty.locator("body")).not.toContainText(/block/i);
  await page.goto(`${ORIGIN}/trades/${half}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Swapped with Misty W"
  );
}

test.describe("Trades, desktop", () => {
  test.use(DESKTOP_SIZE);

  test("Block counts and cancels the Trades nobody confirmed, and the Blocked side finishes a half-confirmed one unaware", async ({
    page,
    collectors,
  }) => {
    // Two collectors in two contexts, a catalog import, many page loads and page checks: well over 30 s on a loaded
    // host.
    test.slow();
    await tradeStory(page, collectors, DESKTOP_SIZE, "desktop width");
  });
});

test.describe("Trades, phone", () => {
  test.use(PHONE_SIZE);

  test("the same at 375 px", async ({ page, collectors }) => {
    // Two collectors in two contexts, a catalog import, many page loads and page checks: well over 30 s on a loaded
    // host.
    test.slow();
    await tradeStory(page, collectors, PHONE_SIZE, "375 px");
  });
});
