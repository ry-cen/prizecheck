import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { expectPageChecks } from "./support/page-check";
import { startAsNewOwner } from "./support/owner";
import { signInAsOwner } from "./support/sign-in";
import { expectTouchTarget } from "./support/touch-target";

// The Settings page (#207, decklist import spec "Settings"): the avatar menu and the More sheet open it, the retired
// Sign-ins address redirects to it, and its Decks section changes the Want List counting setting, which is stored on
// the account, so it survives a reload and reads the same on another device. Each test starts as a new owner, whose
// setting is the default (Every Deck built at once) whatever earlier tests on the stack chose.

const ORIGIN = process.env.TEST_ORIGIN || "http://localhost:5173";
const PHONE = {
  viewport: { width: 375, height: 812 },
  isMobile: true,
  hasTouch: true,
};
const EVERY_DECK = "Every Deck built at once";
const ONE_DECK = "One Deck at a time";

async function signIn(page: Page, next = "/collection") {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await startAsNewOwner(pool);
  } finally {
    await pool.end();
  }
  await signInAsOwner(page, next);
  await expect(
    page.getByRole("navigation", { name: "Main views" })
  ).toBeVisible();
}

const counting = (page: Page) =>
  page.getByRole("group", { name: "Want List counting" });
const option = (page: Page, name: string) =>
  counting(page).getByRole("radio", { name });
const saved = (page: Page) =>
  page.getByRole("region", { name: "Decks" }).getByRole("status");

/** The account's setting as the API reads it, through the page's session. */
async function stored(page: Page) {
  const response = await page.request.get(`${ORIGIN}/api/settings`);
  expect(response.status()).toBe(200);
  return response.json();
}

test("the avatar menu opens Settings, and the old Sign-ins address redirects to it", async ({
  page,
}) => {
  await signIn(page);
  await page.getByRole("button", { name: "Account" }).click();
  await expect(page.getByRole("menuitem", { name: "Sign-ins" })).toHaveCount(0);
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await expect(page).toHaveURL(`${ORIGIN}/settings`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Settings");
  await expect(
    page.getByRole("heading", { level: 2, name: "Decks" })
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { level: 2, name: "Sign-ins" })
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Your sign-ins" })
  ).toBeVisible();
  await expect(option(page, EVERY_DECK)).toBeChecked();
  await expectPageChecks(page, "Settings");

  // The retired address lands on Settings, keeping its query: a sign-in link failure the gateway returns there still
  // reaches the Sign-ins section, which shows it and then removes it from the address.
  await page.goto(
    `${ORIGIN}/settings/sign-ins?provider=discord&error=recent_sign_in_required`
  );
  await expect(
    page.getByRole("alert").filter({ hasText: "sign in again" })
  ).toContainText("For your security, sign in again to change your sign-ins.");
  await expect(page).toHaveURL(`${ORIGIN}/settings`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Settings");
});

test("changing the counting setting saves it to the account: it survives a reload and reads the same on a phone", async ({
  page,
  browser,
}) => {
  await signIn(page, "/settings");
  await expect(option(page, EVERY_DECK)).toBeChecked();
  await expect(counting(page)).toContainText(
    "Each spare copy counts toward one Deck only, oldest Deck first."
  );
  await expect(counting(page)).toContainText(
    "Every copy you own counts for every Deck, even copies sleeved in another Deck."
  );
  await option(page, ONE_DECK).click();
  await expect(saved(page)).toHaveText(
    `Want List counting set to ${ONE_DECK}.`
  );
  await expect(option(page, ONE_DECK)).toBeChecked();
  expect(await stored(page)).toEqual({
    want_list_counting: "one_at_a_time",
    revision: 2,
  });
  await page.reload();
  await expect(option(page, ONE_DECK)).toBeChecked();
  await expect(option(page, EVERY_DECK)).not.toBeChecked();

  // Another device: the same account, signed in on a phone.
  const phone = await browser.newContext(PHONE);
  try {
    const other = await phone.newPage();
    await signInAsOwner(other, "/settings");
    await expect(option(other, ONE_DECK)).toBeChecked();
    await expectPageChecks(other, "Settings on a phone");
    await counting(other).getByText(EVERY_DECK, { exact: true }).tap();
    await expect(saved(other)).toHaveText(
      `Want List counting set to ${EVERY_DECK}.`
    );
  } finally {
    await phone.close();
  }
  await page.reload();
  await expect(option(page, EVERY_DECK)).toBeChecked();
});

test("a change refused as stale shows the current setting and says why", async ({
  page,
}) => {
  await signIn(page, "/settings");
  await expect(option(page, EVERY_DECK)).toBeChecked();
  // Another device changes the setting twice while this page still shows revision 1.
  for (const [counting, revision] of [
    ["one_at_a_time", 1],
    ["all_at_once", 2],
  ] as const) {
    const response = await page.request.put(
      `${ORIGIN}/api/settings/want-list-counting`,
      {
        headers: { origin: ORIGIN },
        data: {
          want_list_counting: counting,
          revision,
          idempotency_key: randomUUID(),
        },
      }
    );
    expect(response.status()).toBe(200);
  }
  await option(page, ONE_DECK).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "changed somewhere else" })
  ).toHaveText(
    "Your settings changed somewhere else, so this change wasn't saved. They're up to date now: try again."
  );
  await expect(option(page, EVERY_DECK)).toBeChecked();
  expect(await stored(page)).toEqual({
    want_list_counting: "all_at_once",
    revision: 3,
  });
  // Trying again, at the revision the page now has, saves it.
  await option(page, ONE_DECK).click();
  await expect(saved(page)).toHaveText(
    `Want List counting set to ${ONE_DECK}.`
  );
  expect(await stored(page)).toEqual({
    want_list_counting: "one_at_a_time",
    revision: 4,
  });
});

test("a change that couldn't be sent shows the saved setting again and can be retried", async ({
  page,
}) => {
  await signIn(page, "/settings");
  await expect(option(page, EVERY_DECK)).toBeChecked();
  // The server commits the change but its answer is lost, so only a retry
  // that reuses the idempotency key is answered; a fresh key would be stale.
  await page.route("**/api/settings/want-list-counting", async (route) => {
    await route.fetch();
    await route.abort();
  });
  await option(page, ONE_DECK).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "couldn't be saved" })
  ).toHaveText(
    "The setting couldn't be saved. Check your connection and try again."
  );
  await expect(option(page, EVERY_DECK)).toBeChecked();
  await page.unroute("**/api/settings/want-list-counting");
  await option(page, ONE_DECK).click();
  await expect(saved(page)).toHaveText(
    `Want List counting set to ${ONE_DECK}.`
  );
  expect(await stored(page)).toEqual({
    want_list_counting: "one_at_a_time",
    revision: 2,
  });
});

test.describe("phone", () => {
  test.use(PHONE);

  test("the account sheet opens Settings, whose options are 44 px targets", async ({
    page,
  }) => {
    await signIn(page);
    await page.getByRole("button", { name: "Account", exact: true }).tap();
    const sheet = page.getByRole("dialog", { name: "Account" });
    await sheet.getByRole("button", { name: "Settings" }).tap();
    await expect(page).toHaveURL(`${ORIGIN}/settings`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Settings"
    );
    await expect(option(page, EVERY_DECK)).toBeChecked();
    for (const name of [EVERY_DECK, ONE_DECK])
      await expectTouchTarget(counting(page).getByText(name, { exact: true }));
    await expectPageChecks(page, "Settings");
    await counting(page).getByText(ONE_DECK, { exact: true }).tap();
    await expect(saved(page)).toHaveText(
      `Want List counting set to ${ONE_DECK}.`
    );
    await page.reload();
    await expect(option(page, ONE_DECK)).toBeChecked();
  });
});

// Ticket #283: Settings › Privacy lists the For trade Locations, topmost marks only, beside the hidden list.
async function location(page: Page, name: string, parentId?: string) {
  const tree = async () =>
    (
      (await (
        await page.request.get(`${ORIGIN}/api/location-tree`)
      ).json()) as {
        locations: { id: string; version: number }[];
      }
    ).locations;
  const parent_version = parentId
    ? (await tree()).find((node) => node.id === parentId)!.version
    : null;
  const response = await page.request.post(`${ORIGIN}/api/location-tree`, {
    headers: { origin: ORIGIN },
    data: {
      name,
      parent_id: parentId ?? null,
      parent_version,
      idempotency_key: randomUUID(),
    },
  });
  expect(response.status()).toBe(201);
  return ((await response.json()) as { location: { id: string } }).location.id;
}

async function flag(page: Page, id: string, key: "for_trade" | "hidden") {
  const nodes = (
    (await (await page.request.get(`${ORIGIN}/api/location-tree`)).json()) as {
      locations: { id: string; version: number }[];
    }
  ).locations;
  const response = await page.request.put(
    `${ORIGIN}/api/location-tree/${id}/${key === "hidden" ? "hidden" : "for-trade"}`,
    {
      headers: { origin: ORIGIN },
      data: {
        [key]: true,
        version: nodes.find((node) => node.id === id)!.version,
        idempotency_key: randomUUID(),
      },
    }
  );
  expect(response.status()).toBe(200);
}

async function forTradeSettings(page: Page) {
  await signIn(page, "/settings");
  const section = page.getByRole("region", { name: "For trade" });
  await expect(section).toContainText("Nothing is offered for trade.");
  await expect(section).toHaveText(
    "For tradeNothing is offered for trade. To offer a Location's cards, open its settings from the gear beside it in Collection and choose For trade."
  );
  const storage = await location(page, "Storage");
  const binder = await location(page, "Binder", storage);
  const shelf = await location(page, "Shelf");
  await location(page, "Plain");
  // The child is marked first, then the box above it: only the box is listed.
  await flag(page, binder, "for_trade");
  await flag(page, storage, "for_trade");
  await flag(page, shelf, "for_trade");
  await flag(page, shelf, "hidden");
  await page.reload();
  await expect(section).toContainText(
    "Friends can trade for the cards in these Locations and everything inside them, apart from Decks. Change this in each Location's settings in Collection."
  );
  await expect(section.getByRole("listitem")).toHaveText(["Shelf", "Storage"]);
  // The hidden and For trade Location is listed in both sections.
  await expect(
    page
      .getByRole("region", { name: "Hidden from Friends" })
      .getByRole("listitem")
  ).toHaveText(["Shelf"]);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth)
  ).toBeLessThanOrEqual(page.viewportSize()!.width);
}

test("Settings › Privacy lists the For trade Locations, topmost marks only", async ({
  page,
}) => {
  await forTradeSettings(page);
});

test.describe("phone, For trade", () => {
  test.use(PHONE);

  test("the same at 375 px", async ({ page }) => {
    await forTradeSettings(page);
  });
});

test("Settings says the For trade Locations are unavailable when they can't be read", async ({
  page,
}) => {
  await signIn(page, "/settings");
  await page.route("**/api/location-tree", (route) => route.abort());
  await page.reload();
  await expect(
    page.getByRole("region", { name: "For trade" }).getByRole("alert")
  ).toHaveText(
    "Your For trade Locations are temporarily unavailable. Please retry."
  );
});
