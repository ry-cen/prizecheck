// Ticket #259: the inbox (spec "Inbox derivation", "Web screens"). Ash K. sends Misty W. two Borrow Requests through
// the API. Misty's bell and Loans tab count both; the bell's drawer lists one line per Loan, she opens one from it and
// declines it, and both badges count one. Ash's bell lists the decline under Earlier; he opens the Loan from it, and
// Clear empties Earlier for good. Collection's phone header still fits its Search with the bell in it. Each update says
// when it happened (owner's decision, 2026-10-16), read on a clock fixed after it, so the words never depend on how long
// the test took (a Waiting on you line too, from when its Loan began to wait); Ash then withdraws his other request, and Misty's bell says he withdrew it. A Loan opened from the
// bell in Collection's phone header takes focus on its heading, and a Clear that got no answer keeps focus on Clear.
//
// Ticket #273 (Trading spec "Inbox integration", prototype inbox drawer): Misty W. sends Ash K. a Trade Proposal through
// the API. Ash's bell and Trades tab count it, and its line opens the Trade, whose heading takes focus; he accepts it
// and Misty is told. A Move leaves Misty's pick out of date, so her line says Fix picks; she uses the suggested picks,
// Ash confirms the swap and her line says Confirm swap; she confirms from it, Ash is told, and each clears Earlier with
// the one Clear. At desktop width and at 375 px. The catalog is the Swap catalog (api/tests/want_list_swap_fixtures.py).
import { randomUUID } from "node:crypto";
import type { BrowserContextOptions, Page } from "@playwright/test";
import { expect, test } from "./support/collectors";
import {
  DESKTOP,
  ORIGIN,
  PHONE,
  accountId,
  api,
  befriend,
  hold,
  loanStep,
  nameCollector,
  seedCatalog,
  unsorted,
} from "./support/loans";
import { expectPageChecks } from "./support/page-check";
import { signInAsOwner } from "./support/sign-in";

const bell = (on: Page) => on.getByRole("button", { name: /^Inbox/ });
const loansTab = (on: Page) =>
  on
    .getByRole("navigation", { name: "Main views" })
    .getByRole("button", { name: /^Loans/ });
const tradesTab = (on: Page) =>
  on
    .getByRole("navigation", { name: "Main views" })
    .getByRole("button", { name: /^Trades/ });
const drawer = (on: Page) => on.getByRole("dialog", { name: "Inbox" });
const title = (on: Page) => on.getByRole("heading", { level: 1 });
const HOUR = 3_600_000;

/** Fixes `on`'s clock `ms` after the time of the reader's newest update, as the API says it happened. */
async function fixClockAfterNewestUpdate(on: Page, ms: number) {
  const { updates } = await api(on, "GET", "/api/social/inbox");
  await on.clock.setFixedTime(
    new Date(
      Math.max(...updates.map((u: { at: string }) => Date.parse(u.at))) + ms
    )
  );
}

/** Fixes `on`'s clock `ms` after the time its newest waiting line began to wait, as the API says. */
async function fixClockAfterNewestWaiting(on: Page, ms: number) {
  const { waiting } = await api(on, "GET", "/api/social/inbox");
  await on.clock.setFixedTime(
    new Date(
      Math.max(...waiting.map((w: { since: string }) => Date.parse(w.since))) +
        ms
    )
  );
}

test("the bell lists the Loans waiting on you, opens one, and Clear empties Earlier", async ({
  page,
  collectors,
}) => {
  // Two collectors in two contexts, a catalog import and page checks at both widths: well over 30 s on a loaded host.
  test.slow();
  const ids = seedCatalog();
  const misty = await collectors.signIn({ next: "/loans" });
  const lender = misty.page;
  await nameCollector(lender, "Misty W");
  await hold(lender, await unsorted(lender), ids["PAL 185"], 2);

  await page.route(/^https:\/\/assets\.tcgdex\.net\//, (route) =>
    route.abort()
  );
  await signInAsOwner(page, "/loans");
  await nameCollector(page, "Ash K");
  await befriend(page, lender);
  const mistyId = await accountId(lender);
  const ask = async () =>
    (
      await api(page, "POST", "/api/loans", {
        lender_id: mistyId,
        lines: [{ edition_id: ids["PAL 185"], quantity: "1" }],
        deck_id: null,
        idempotency_key: randomUUID(),
      })
    ).id as string;
  const older = await ask();
  const newer = await ask();

  // Misty: both requests wait on her, on the bell and on the Loans tab.
  await lender.goto(`${ORIGIN}/collection`);
  await expect(bell(lender)).toHaveAccessibleName("Inbox, 2 waiting");
  await expect(loansTab(lender)).toHaveAccessibleName("Loans, 2 need you");
  await bell(lender).click();
  const waiting = drawer(lender)
    .getByRole("region", { name: "Waiting on you" })
    .getByRole("link");
  await expect(waiting).toHaveCount(2);
  await expect(waiting.first()).toContainText("Ash K · Answer");
  await expect(waiting.first()).toContainText("Iono");
  await expect(
    drawer(lender).getByRole("region", { name: "Earlier" })
  ).toContainText("No updates.");
  await expectPageChecks(lender, "the inbox");
  await lender.setViewportSize(PHONE);
  await expectPageChecks(lender, "the inbox on a phone");

  // She opens the newer one from the bell in Collection's phone header and declines it: one Loan waits on her now.
  // That bell is hidden once the Loan is drawn, so the Loan's heading takes focus.
  await drawer(lender).getByRole("button", { name: "Close Inbox" }).click();
  await bell(lender).click();
  await waiting.first().click();
  await expect(drawer(lender)).toBeHidden();
  await expect(lender).toHaveURL(`${ORIGIN}/loans/${newer}`);
  await expect(title(lender)).toHaveText("Ash K wants to borrow 1 card");
  await expect(title(lender)).toBeFocused();
  await lender.setViewportSize(DESKTOP);
  await lender.getByRole("button", { name: "Decline", exact: true }).click();
  await lender
    .getByRole("group", { name: "Decline" })
    .getByRole("button", { name: "Decline", exact: true })
    .click();
  await expect(title(lender)).toHaveText(
    "You declined Ash K's request for 1 card"
  );
  await expect(bell(lender)).toHaveAccessibleName("Inbox, 1 waiting");
  await expect(loansTab(lender)).toHaveAccessibleName("Loans, 1 needs you");

  // Collection's phone header holds the bell and still fits Search.
  await lender.setViewportSize(PHONE);
  await lender.goto(`${ORIGIN}/collection`);
  await expect(bell(lender)).toBeVisible();
  await expect(loansTab(lender)).toHaveAccessibleName("Loans, 1 needs you");
  await expectPageChecks(lender, "Collection on a phone with the bell");

  // Ash: nothing waits on him; the decline is under Earlier, three hours ago by his clock, and opens its Loan.
  await fixClockAfterNewestUpdate(page, 3 * HOUR);
  await page.goto(`${ORIGIN}/loans`);
  await expect(bell(page)).toHaveAccessibleName("Inbox");
  await expect(loansTab(page)).toHaveAccessibleName("Loans");
  // The drawer marks what it shows read; wait for that before reading the inbox again.
  const marked = page.waitForResponse(/\/api\/social\/inbox\/read$/);
  await bell(page).click();
  await expect(
    drawer(page).getByRole("region", { name: "Waiting on you" })
  ).toContainText("Nothing is waiting on you.");
  const earlier = drawer(page).getByRole("region", { name: "Earlier" });
  await expect(earlier.getByRole("link")).toHaveText([
    "New: Misty W declined your request 3 hours ago",
  ]);
  await marked;
  await earlier.getByRole("link").click();
  await expect(page).toHaveURL(`${ORIGIN}/loans/${newer}`);
  await expect(title(page)).toHaveText(
    "Misty W declined your request for 1 card"
  );

  // The drawer marked it read; Clear empties Earlier, and it stays empty. A Clear that got no answer says so, and
  // focus stays on Clear, which stays enabled while it is out.
  await bell(page).click();
  await expect(earlier.getByRole("link")).toHaveText([
    "Misty W declined your request 3 hours ago",
  ]);
  const clear = earlier.getByRole("button", { name: "Clear" });
  await page.route("**/api/social/inbox/clear", (route) => route.abort(), {
    times: 1,
  });
  await clear.click();
  await expect(drawer(page).getByRole("alert")).toHaveText(
    "Couldn't clear. Check your connection and try again."
  );
  await expect(clear).toBeFocused();
  await clear.click();
  await expect(earlier).toContainText("No updates.");
  await expect(drawer(page).getByRole("status")).toHaveText("Cleared.");
  await expect(earlier.getByRole("heading", { name: "Earlier" })).toBeFocused();
  await drawer(page).getByRole("button", { name: "Close Inbox" }).click();
  await expect(bell(page)).toBeFocused();
  await page.reload();
  await bell(page).click();
  await expect(earlier).toContainText("No updates.");

  // Ash withdraws his other request: Misty's bell says he withdrew it, two days ago by her clock, and nothing waits.
  await loanStep(page, older, `/api/social/loans/${older}/withdraw`);
  await fixClockAfterNewestUpdate(lender, 48 * HOUR);
  await lender.goto(`${ORIGIN}/loans`);
  await expect(bell(lender)).toHaveAccessibleName("Inbox");
  await bell(lender).click();
  await expect(
    drawer(lender).getByRole("region", { name: "Earlier" }).getByRole("link")
  ).toHaveText(["New: Ash K withdrew their request 2 days ago"]);

  // A new request waits on Misty; by her clock, five hours after it was sent, its line says so.
  const third = await ask();
  await fixClockAfterNewestWaiting(lender, 5 * HOUR);
  await lender.goto(`${ORIGIN}/loans`);
  await bell(lender).click();
  await expect(
    drawer(lender)
      .getByRole("region", { name: "Waiting on you" })
      .getByRole("link")
  ).toHaveText([/^Ash K · Answer.* 5 hours ago$/]);
});

/** A top-level Storage Leaf, marked For trade when `forTrade`; returns its id. */
async function leaf(on: Page, name: string, forTrade: boolean) {
  const created = await api(on, "POST", "/api/location-tree", {
    name,
    parent_id: null,
    parent_version: null,
    idempotency_key: randomUUID(),
  });
  const location = created.location as { id: string; version: number };
  if (forTrade)
    await api(on, "PUT", `/api/location-tree/${location.id}/for-trade`, {
      for_trade: true,
      version: location.version,
      idempotency_key: randomUUID(),
    });
  return location.id;
}

/** A Collection Move of `copies` of one Edition from `source` to `destination`, through the API. */
async function move(
  on: Page,
  source: string,
  edition: string,
  copies: number,
  destination: string
) {
  const version = (
    (await api(on, "GET", `/api/holdings/${source}`)).holdings as {
      edition_id: string;
      version: number;
    }[]
  ).find((item) => item.edition_id === edition)!.version;
  const manifest = (
    await api(on, "POST", "/api/moves/manifests", { source_id: source })
  ).id as string;
  await api(on, "PUT", `/api/moves/manifests/${manifest}/items`, {
    items: [
      {
        edition_id: edition,
        quantity: String(copies),
        expected_version: version,
      },
    ],
  });
  await api(on, "POST", `/api/moves/manifests/${manifest}/commit`, {
    destination_id: destination,
    idempotency_key: randomUUID(),
  });
}

/** Misty's Trade, as far as Waiting on you goes: Ash, then Misty, through the inbox. */
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
  const ash = (await collectors.signIn({ contextOptions })).page;
  await nameCollector(ash, "Ash K");
  await hold(ash, await leaf(ash, "Trade Binder", true), arven, 1);
  for (const on of [page, ash])
    await on.route(/^https:\/\/assets\.tcgdex\.net\//, (route) =>
      route.abort()
    );
  await signInAsOwner(page, "/collection");
  await nameCollector(page, "Misty W");
  const shelf = await leaf(page, "Trade Shelf", true);
  const box = await leaf(page, "Box", false);
  await hold(page, shelf, iono, 1);
  await befriend(page, ash);
  const trade = (
    await api(page, "POST", "/api/trades", {
      recipient_id: await accountId(ash),
      you_give: [{ edition_id: iono, quantity: "1" }],
      you_get: [{ edition_id: arven, quantity: "1" }],
      idempotency_key: randomUUID(),
    })
  ).id as string;
  const tradeAddress = `${ORIGIN}/trades/${trade}`;
  const waitingOn = (on: Page) =>
    drawer(on)
      .getByRole("region", { name: "Waiting on you" })
      .getByRole("link");
  const earlierOn = (on: Page) =>
    drawer(on).getByRole("region", { name: "Earlier" });

  // Ash: the proposal waits on his answer, on the bell and on the Trades tab, and its line opens the Trade.
  await ash.goto(`${ORIGIN}/collection`);
  await expect(bell(ash)).toHaveAccessibleName("Inbox, 1 waiting");
  await expect(tradesTab(ash)).toHaveAccessibleName("Trades, 1 needs you");
  await expect(loansTab(ash)).toHaveAccessibleName("Loans");
  await bell(ash).click();
  await expect(waitingOn(ash)).toHaveText([
    /^Misty W · Answer\s*You give 1 card · You get 1 card /,
  ]);
  await expect(earlierOn(ash)).toContainText("No updates.");
  await expectPageChecks(ash, `a Trade waiting in the inbox at ${width}`);
  await waitingOn(ash).click();
  await expect(drawer(ash)).toBeHidden();
  await expect(ash).toHaveURL(tradeAddress);
  await expect(title(ash)).toHaveText("Misty W sent you a Trade Proposal");
  await expect(title(ash)).toBeFocused();

  // He accepts: nothing waits on him now, and Misty is told.
  await ash.getByRole("main").getByRole("button", { name: "Accept" }).click();
  await expect(title(ash)).toHaveText("Ready to swap with Misty W");
  await expect(bell(ash)).toHaveAccessibleName("Inbox");
  await expect(tradesTab(ash)).toHaveAccessibleName("Trades");
  await page.goto(`${ORIGIN}/collection`);
  await expect(bell(page)).toHaveAccessibleName("Inbox");
  await bell(page).click();
  await expect(earlierOn(page).getByRole("link")).toHaveText([
    /^New: Ash K accepted your Trade Proposal /,
  ]);
  await drawer(page).getByRole("button", { name: "Close Inbox" }).click();

  // Misty's Iono moves to her Box: her pick is out of date, which waits on her.
  await move(page, shelf, iono, 1, box);
  await page.reload();
  await expect(bell(page)).toHaveAccessibleName("Inbox, 1 waiting");
  await expect(tradesTab(page)).toHaveAccessibleName("Trades, 1 needs you");
  await tradesTab(page).click();
  await expect(
    page.getByRole("region", { name: "Needs you" }).getByRole("link")
  ).toContainText("· Fix picks");
  await bell(page).click();
  await expect(waitingOn(page)).toHaveText([/^Ash K · Fix picks/]);
  await waitingOn(page).click();
  await expect(page).toHaveURL(tradeAddress);
  await expect(title(page)).toBeFocused();
  await page
    .getByRole("main")
    .getByRole("button", { name: "Use suggested picks" })
    .click();
  await expect(
    page.getByRole("region", { name: "Notifications" })
  ).toContainText("Picks updated");
  await expect(bell(page)).toHaveAccessibleName("Inbox");

  // Ash confirms the swap: it waits on Misty to confirm hers.
  const read = await api(ash, "GET", `/api/social/trades/${trade}`);
  await api(ash, "POST", `/api/trades/${trade}/confirm-swap`, {
    revision: read.revision,
    idempotency_key: randomUUID(),
    destination_id: null,
  });
  await page.goto(`${ORIGIN}/collection`);
  await expect(bell(page)).toHaveAccessibleName("Inbox, 1 waiting");
  await bell(page).click();
  await expect(waitingOn(page)).toHaveText([/^Ash K · Confirm swap/]);
  await expectPageChecks(page, `a swap to confirm in the inbox at ${width}`);
  await waitingOn(page).click();
  await expect(title(page)).toHaveText("Ash K confirmed the swap");
  await page
    .getByRole("main")
    .getByRole("button", { name: "Confirm swap" })
    .click();
  await page
    .getByRole("dialog", { name: "Confirm swap with Ash K?" })
    .getByRole("button", { name: "Confirm swap" })
    .click();
  await expect(title(page)).toHaveText("Swapped with Ash K");
  await expect(bell(page)).toHaveAccessibleName("Inbox");
  await expect(tradesTab(page)).toHaveAccessibleName("Trades");

  // Each clears Earlier with the one Clear, and it stays empty.
  for (const [on, told] of [
    [ash, /^New: Misty W confirmed the swap /],
    [page, /^Ash K accepted your Trade Proposal /],
  ] as const) {
    await on.goto(`${ORIGIN}/collection`);
    await bell(on).click();
    await expect(earlierOn(on).getByRole("link")).toHaveText([told]);
    await earlierOn(on).getByRole("button", { name: "Clear" }).click();
    await expect(earlierOn(on)).toContainText("No updates.");
    await on.reload();
    await bell(on).click();
    await expect(earlierOn(on)).toContainText("No updates.");
    await expect(
      drawer(on).getByRole("region", { name: "Waiting on you" })
    ).toContainText("Nothing is waiting on you.");
  }
}

test.describe("Trades in the inbox, desktop", () => {
  const size = { viewport: DESKTOP };
  test.use(size);

  test("a Trade waits on whichever side's step it is, its line opens it, and its updates clear with Clear", async ({
    page,
    collectors,
  }) => {
    // Two collectors in two contexts, a catalog seed, many page loads and page checks: well over 30 s on a loaded host.
    test.slow();
    await tradeStory(page, collectors, size, "desktop width");
  });
});

test.describe("Trades in the inbox, phone", () => {
  const size = {
    viewport: { width: 375, height: 812 },
    isMobile: true,
    hasTouch: true,
  };
  test.use(size);

  test("the same at 375 px, from the phone header's bell and the tab bar", async ({
    page,
    collectors,
  }) => {
    // Two collectors in two contexts, a catalog seed, many page loads and page checks: well over 30 s on a loaded host.
    test.slow();
    await tradeStory(page, collectors, size, "375 px");
  });
});
