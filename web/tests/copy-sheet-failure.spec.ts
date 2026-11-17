import type { Locator, Page } from "@playwright/test";
import { test, expect } from "./support/collectors";
import { expectTouchTarget } from "./support/touch-target";
import { api, createDeck, ORIGIN, seedCatalog, setLine } from "./support/loans";

// A Deck List change whose outcome is unknown (the request never gets an answer), made from the phone's copy
// sheet: one honest count, and the error with its Try again inside the sheet, then on the page once it closes.
const PHONE = { width: 375, height: 812 };
const NOTICE = /may not have been saved/;

async function openSheet(page: Page, deck: string) {
  await page.route(/^https:\/\/assets\.tcgdex\.net\//, (route) =>
    route.abort()
  );
  await page.goto(`${ORIGIN}/decks/${deck}`);
  const control = page.locator("[data-edition-id]").first();
  await expect(control).toBeVisible();
  await control.tap();
  const sheet = page.getByRole("dialog", { name: "Iono", exact: true });
  await expect(sheet).toBeVisible();
  return sheet;
}

// The polite region must already be in the accessibility tree, empty and without height, for its words to be announced
// when they arrive.
async function expectEmptyStatusInTree(sheet: Locator) {
  const region = sheet.locator("[data-edit-notice]");
  await expect(region).toHaveText("");
  await expect(
    sheet.getByRole("status").and(sheet.locator("[data-edit-notice]"))
  ).toHaveCount(1);
  expect(
    await region.evaluate((node) => {
      const style = getComputedStyle(node);
      return {
        display: style.display,
        visibility: style.visibility,
        height: node.getBoundingClientRect().height,
      };
    })
  ).toEqual({ display: "block", visibility: "visible", height: 0 });
}

const failWrites = (page: Page) =>
  page.route("**/api/decks/**", (route) =>
    route.request().method() === "GET"
      ? route.continue()
      : route.abort("failed")
  );

async function saved(page: Page, deck: string, edition: string) {
  const detail = await api(page, "GET", `/api/decks/${deck}`);
  return detail.deck_list.lines.find(
    (line: { edition_id: string }) => line.edition_id === edition
  ).quantity as string;
}

test("phone: a failed +1 in the copy sheet keeps one count and shows its Try again inside the sheet", async ({
  collectors,
}) => {
  const ids = seedCatalog();
  const { page } = await collectors.signIn({
    contextOptions: { viewport: PHONE, hasTouch: true },
  });
  const deck = await createDeck(page, "Sheet failure");
  await setLine(page, deck, ids["PAL 185"], 3);
  const sheet = await openSheet(page, deck);
  const stepper = sheet.getByRole("group", { name: "Deck List copies" });
  const count = stepper.locator("strong");
  const heading = sheet.getByRole("heading", { name: /on the Deck List/ });
  await expect(count).toHaveText("3");
  await expect(heading).toHaveText("3 on the Deck List");
  await expectEmptyStatusInTree(sheet);

  await failWrites(page);
  await sheet.getByRole("button", { name: /^\+1, Add one Iono/ }).tap();

  // The error is in the sheet, near the stepper, announced politely, and the page's own banner doesn't announce too.
  const notice = sheet.locator("[data-edit-notice]");
  await expect(notice).toHaveAttribute("role", "status");
  await expect(notice).toHaveText(NOTICE);
  const again = sheet.getByRole("button", { name: "Try again" });
  await expect(again).toBeVisible();
  await expect(
    page.locator("[role='alert']").filter({ hasText: NOTICE })
  ).toHaveCount(0);
  // One count: the sheet and the stepper both say the confirmed 3, and the change is marked as not confirmed.
  await expect(count).toHaveText("3");
  await expect(heading).toHaveText("3 on the Deck List");
  await expect(sheet.getByText("+1 not confirmed")).toBeVisible();
  // Phone: nothing wider than the screen, and Try again is a full-size target inside the sheet.
  const box = await expectTouchTarget(again, ["height"]);
  const sheetBox = (await sheet.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(sheetBox.y);
  expect(box.y + box.height).toBeLessThanOrEqual(PHONE.height);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true);
  expect(
    await sheet.evaluate((node) => node.scrollWidth <= node.clientWidth)
  ).toBe(true);
  expect(await saved(page, deck, ids["PAL 185"])).toBe("3");

  // Requests allowed again: Try again from the sheet sends the same change once.
  await page.unroute("**/api/decks/**");
  await again.tap();
  await expect(count).toHaveText("4");
  await expect(heading).toHaveText("4 on the Deck List");
  await expect(notice).toHaveText("");
  await expect(again).toHaveCount(0);
  await expect(sheet.getByText("not confirmed")).toHaveCount(0);
  expect(await saved(page, deck, ids["PAL 185"])).toBe("4");
});

test("phone: after the sheet closes, the failed change's banner is on screen with its Try again, which works", async ({
  collectors,
}) => {
  const ids = seedCatalog();
  const { page } = await collectors.signIn({
    contextOptions: { viewport: PHONE, hasTouch: true },
  });
  const deck = await createDeck(page, "Sheet failure closed");
  await setLine(page, deck, ids["PAL 185"], 3);
  const sheet = await openSheet(page, deck);
  await failWrites(page);
  await sheet.getByRole("button", { name: /^\+1, Add one Iono/ }).tap();
  await expect(
    sheet.getByRole("status").filter({ hasText: NOTICE })
  ).toHaveCount(1);
  await sheet.getByRole("button", { name: "Close card" }).tap();
  await expect(sheet).toHaveCount(0);

  const banner = page.locator("[data-edit-banner]");
  await expect(banner).toBeVisible();
  // The sheet's own line announced it; the banner stays visible but says nothing more, now or after reopening.
  await expect(banner).not.toHaveAttribute("role", /.+/);
  const again = banner.getByRole("button", { name: "Try again" });
  // Not above the viewport, and not under the shell's bar: focus brought it into view.
  await expect(again).toBeFocused();
  const inView = await again.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return rect.top >= 0 && rect.bottom <= window.innerHeight;
  });
  expect(inView).toBe(true);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true);
  await expectTouchTarget(again, ["height"]);
  expect(await saved(page, deck, ids["PAL 185"])).toBe("3");

  // Reopening and closing the sheet with the same notice announces nothing new.
  await page.locator("[data-edition-id]").first().tap();
  await expect(sheet).toBeVisible();
  await expect(sheet.locator("[data-edit-notice]")).toHaveText(NOTICE);
  await expect(banner).not.toHaveAttribute("role", /.+/);
  await sheet.getByRole("button", { name: "Close card" }).tap();
  await expect(sheet).toHaveCount(0);
  await expect(banner).toBeVisible();
  await expect(banner).not.toHaveAttribute("role", /.+/);

  await page.unroute("**/api/decks/**");
  await again.tap();
  await expect(banner).toHaveCount(0);
  await expect.poll(() => saved(page, deck, ids["PAL 185"])).toBe("4");
});

test("phone: a tap after a failed +1 moves the heading and the stepper together, and Try again settles both", async ({
  collectors,
}) => {
  const ids = seedCatalog();
  const { page } = await collectors.signIn({
    contextOptions: { viewport: PHONE, hasTouch: true },
  });
  const deck = await createDeck(page, "Sheet failure second tap");
  await setLine(page, deck, ids["PAL 185"], 3);
  const sheet = await openSheet(page, deck);
  const count = sheet
    .getByRole("group", { name: "Deck List copies" })
    .locator("strong");
  const heading = sheet.getByRole("heading", { name: /on the Deck List/ });
  const marker = sheet.getByText("+1 not confirmed");
  const notice = sheet.locator("[data-edit-notice]");
  const add = sheet.getByRole("button", { name: /^\+1, Add one Iono/ });
  const again = sheet.getByRole("button", { name: "Try again" });
  const same = async (n: string) => {
    await expect(count).toHaveText(n);
    await expect(heading).toHaveText(`${n} on the Deck List`);
  };

  await failWrites(page);
  await add.tap();
  await expect(notice).toHaveText(NOTICE);
  await same("3");
  await expect(marker).toBeVisible();

  // The next tap waits behind the unconfirmed one: the heading and the stepper both move, the mark stays.
  await add.tap();
  await same("4");
  await expect(marker).toBeVisible();
  await expect(notice).toHaveText(NOTICE);
  expect(await saved(page, deck, ids["PAL 185"])).toBe("3");

  // Try again while requests still fail: still unconfirmed, the same two numbers, a notice again.
  await again.tap();
  await expect(notice).toHaveText(NOTICE);
  await expect(again).toBeVisible();
  await same("4");
  await expect(marker).toBeVisible();
  expect(await saved(page, deck, ids["PAL 185"])).toBe("3");

  // Requests allowed: the unconfirmed change and the queued tap both land, once each.
  await page.unroute("**/api/decks/**");
  await again.tap();
  await expect(notice).toHaveText("");
  await expect(again).toHaveCount(0);
  await expect(sheet.getByText("not confirmed")).toHaveCount(0);
  await expect.poll(() => saved(page, deck, ids["PAL 185"])).toBe("5");
  await same("5");
});

test("phone: Undo after an unconfirmed change waits for it, and the numbers never disagree", async ({
  collectors,
}) => {
  const ids = seedCatalog();
  const { page } = await collectors.signIn({
    contextOptions: { viewport: PHONE, hasTouch: true },
  });
  const deck = await createDeck(page, "Sheet failure undo");
  await setLine(page, deck, ids["PAL 185"], 3);
  const sheet = await openSheet(page, deck);
  const count = sheet
    .getByRole("group", { name: "Deck List copies" })
    .locator("strong");
  const heading = sheet.getByRole("heading", { name: /on the Deck List/ });
  const notice = sheet.locator("[data-edit-notice]");
  const add = sheet.getByRole("button", { name: /^\+1, Add one Iono/ });
  const same = async (n: string) => {
    await expect(count).toHaveText(n);
    await expect(heading).toHaveText(`${n} on the Deck List`);
  };
  // One saved +1 with its Undo in the sheet, then a +1 whose outcome is unknown.
  await add.tap();
  await same("4");
  const undo = sheet.getByRole("button", { name: "Undo" });
  await expect(undo).toBeVisible();
  let writes = 0;
  await page.route("**/api/decks/**", (route) => {
    if (route.request().method() === "GET") return route.continue();
    writes++;
    return route.abort("failed");
  });
  await add.tap();
  await expect(notice).toHaveText(NOTICE);
  await same("4");
  expect(writes).toBe(1);

  // Undo is asked for, but nothing is sent while the other change is unconfirmed, and the numbers hold.
  await undo.tap();
  await same("4");
  await expect(notice).toHaveText(NOTICE);
  expect(writes).toBe(1);
  expect(await saved(page, deck, ids["PAL 185"])).toBe("4");

  // Try again settles the unconfirmed change; the numbers agree and match what is saved.
  await page.unroute("**/api/decks/**");
  await sheet.getByRole("button", { name: "Try again" }).tap();
  await expect(notice).toHaveText("");
  await expect(sheet.getByText("not confirmed")).toHaveCount(0);
  await expect
    .poll(async () => [
      await count.textContent(),
      await heading.textContent(),
      await saved(page, deck, ids["PAL 185"]),
    ])
    .toEqual(["5", "5 on the Deck List", "5"]);
});

test("phone: a failure that arrives after the sheet closed is announced by the banner, once, and on screen", async ({
  collectors,
}) => {
  const ids = seedCatalog();
  const { page } = await collectors.signIn({
    contextOptions: { viewport: PHONE, hasTouch: true },
  });
  const deck = await createDeck(page, "Sheet failure late");
  await setLine(page, deck, ids["PAL 185"], 3);
  const sheet = await openSheet(page, deck);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/decks/**", async (route) => {
    if (route.request().method() === "GET") return route.continue();
    await gate;
    return route.abort("failed");
  });
  await sheet.getByRole("button", { name: /^\+1, Add one Iono/ }).tap();
  await sheet.getByRole("button", { name: "Close card" }).tap();
  await expect(sheet).toHaveCount(0);
  release();
  const banner = page.locator("[data-edit-banner]");
  await expect(banner).toHaveAttribute("role", "alert");
  await expect(banner).toContainText(NOTICE);
  const inView = await banner.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return rect.top >= 0 && rect.bottom <= window.innerHeight;
  });
  expect(inView).toBe(true);
  // Opening and closing the sheet doesn't turn it into a second announcement.
  await page.locator("[data-edition-id]").first().tap();
  await expect(sheet).toBeVisible();
  await expect(sheet.locator("[data-edit-notice]")).toHaveText(NOTICE);
  await sheet.getByRole("button", { name: "Close card" }).tap();
  await expect(sheet).toHaveCount(0);
  await expect(banner).toHaveAttribute("role", "alert");
});
