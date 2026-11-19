// m13 s5: the Borrowed list has an address of its own (?borrowed=1 on the Collection address), so reload, Back,
// Forward and a pasted link bring it back, a return through the Collection tab doesn't, and its Back keeps the
// listing's scroll.
import { randomUUID } from "node:crypto";
import { expect, test } from "./support/collectors";
import {
  ORIGIN,
  api,
  befriend,
  hold,
  lendHandedOver,
  nameCollector,
  seedCatalog,
  unsorted,
} from "./support/loans";
import { signInAsOwner } from "./support/sign-in";
import type { Page } from "@playwright/test";

const SIZES = [
  { name: "desktop", viewport: { width: 1280, height: 800 }, phone: false },
  { name: "phone", viewport: { width: 375, height: 812 }, phone: true },
] as const;

type Collectors = Parameters<Parameters<typeof test>[2]>[0]["collectors"];

/** Ash holds `copies` of one card in Unsorted and borrows `lent` Iono from Misty (into Unsorted). With `ownIono`,
 * Ash also owns one Iono in a Box of his own, so Move can put each kind where the other sits. */
async function setup(
  page: Page,
  collectors: Collectors,
  size: (typeof SIZES)[number],
  copies: number,
  { lent = 2, ownIono = false } = {}
) {
  await page.setViewportSize(size.viewport);
  const ids = seedCatalog();
  const lender = (await collectors.signIn({ next: "/loans" })).page;
  await nameCollector(lender, "Misty W");
  await hold(lender, await unsorted(lender), ids["PAL 185"], 2);
  await page.route(/^https:\/\/assets\.tcgdex\.net\//, (route) =>
    route.abort()
  );
  await signInAsOwner(page, "/collection");
  await nameCollector(page, "Ash K");
  const home = await unsorted(page);
  await hold(page, home, ids["PAL 172"], copies);
  await befriend(page, lender);
  let box = "";
  if (ownIono) {
    box = (
      await api(page, "POST", "/api/location-tree", {
        name: "M13 Box",
        parent_id: null,
        parent_version: null,
        idempotency_key: randomUUID(),
      })
    ).location.id as string;
    await hold(page, box, ids["PAL 185"], 1);
  }
  const loan = await lendHandedOver(lender, page, [[ids["PAL 185"], lent]]);
  return { home, box, loan, iono: ids["PAL 185"] };
}

const borrowedDialog = (page: Page) =>
  page.getByRole("dialog", { name: "Borrowed" });

async function openBorrowed(page: Page, phone: boolean) {
  if (phone) {
    await page.getByRole("button", { name: "Open locations" }).click();
    await page.getByRole("button", { name: /^Borrowed/ }).click();
  } else
    await page
      .getByRole("complementary", { name: "Sidebar" })
      .getByRole("button", { name: /^Borrowed/ })
      .click();
  await expect(borrowedDialog(page)).toBeVisible();
}

const params = (page: Page) => new URL(page.url()).searchParams;

for (const size of SIZES) {
  test(`the Borrowed list has its own address at ${size.name}`, async ({
    page,
    collectors,
  }) => {
    const { home } = await setup(page, collectors, size, 1);
    const dialog = borrowedDialog(page);
    const cards = page.getByRole("region", { name: "Cards" });

    await page.goto(`${ORIGIN}/collection?location=${home}`);
    await expect(cards.getByRole("button").first()).toBeVisible();
    await openBorrowed(page, size.phone);
    expect(params(page).get("borrowed")).toBe("1");
    expect(params(page).get("location")).toBe(home);

    // Reload brings the list back, over the same Location.
    await page.reload();
    await expect(dialog).toBeVisible();
    expect(params(page).get("location")).toBe(home);

    // Closing drops it from the address and the entry; Forward opens it again; Back closes it.
    await dialog.getByRole("button", { name: "Close Borrowed" }).click();
    await expect(dialog).toHaveCount(0);
    expect(params(page).has("borrowed")).toBe(false);
    await page.goForward();
    await expect(dialog).toBeVisible();
    await page.goBack();
    await expect(dialog).toHaveCount(0);
    expect(params(page).has("borrowed")).toBe(false);
    expect(params(page).get("location")).toBe(home);

    // A pasted link opens it.
    await page.goto(`${ORIGIN}/collection?borrowed=1`);
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole("list", { name: "Borrowed cards" })
    ).toBeVisible();

    // Borrowed list, then a card, then Back: the list stays closed and the card's details close.
    await dialog.getByRole("button", { name: "Close Borrowed" }).click();
    await expect(dialog).toHaveCount(0);
    await cards.getByRole("button").first().click();
    await page.goBack();
    await expect(dialog).toHaveCount(0);
    expect(params(page).has("borrowed")).toBe(false);
    expect(params(page).has("card")).toBe(false);
  });

  test(`returning through the Collection tab doesn't reopen the Borrowed list at ${size.name}`, async ({
    page,
    collectors,
  }) => {
    const { home } = await setup(page, collectors, size, 1);
    const tab = (name: string) =>
      page.getByRole("link", { name, exact: true }).first();
    await page.goto(`${ORIGIN}/collection?location=${home}&q=Boss`);
    await expect(
      page.getByRole("region", { name: "Cards" }).getByRole("button").first()
    ).toBeVisible();
    await tab("Decks").click();
    await expect(page).toHaveURL(/\/decks/);
    await tab("Collection").click();
    await expect(page).toHaveURL(/\/collection/);
    await openBorrowed(page, size.phone);
    // History jumps straight back to the Decks entry, past the Collection entries, without a page load.
    await page.evaluate(() => window.history.go(-2));
    await expect(page).toHaveURL(/\/decks/);
    await tab("Collection").click();
    await expect(page).toHaveURL(/\/collection/);
    await expect(
      page.getByRole("region", { name: "Cards" }).getByRole("button").first()
    ).toBeVisible();
    expect(params(page).has("borrowed")).toBe(false);
    expect(params(page).get("location")).toBe(home);
    expect(params(page).get("q")).toBe("Boss");
    await expect(borrowedDialog(page)).toHaveCount(0);
  });

  test(`the Borrowed list keeps the listing's scroll through Back and Forward at ${size.name}`, async ({
    page,
    collectors,
  }) => {
    const { home } = await setup(page, collectors, size, 90);
    await page.goto(`${ORIGIN}/collection?location=${home}`);
    await expect(
      page.getByRole("region", { name: "Cards" }).getByRole("button").first()
    ).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, 600));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(600);
    await openBorrowed(page, size.phone);
    // On a phone the Locations drawer the list is opened from moves the page a little; the list keeps what it found.
    const scrolled = await page.evaluate(() => window.scrollY);
    expect(scrolled).toBeGreaterThan(0);
    const scroll = () => page.evaluate(() => window.scrollY);
    await page.goBack();
    await expect(borrowedDialog(page)).toHaveCount(0);
    await expect.poll(scroll).toBe(scrolled);
    await page.goForward();
    await expect(borrowedDialog(page)).toBeVisible();
    await expect.poll(scroll).toBe(scrolled);
    await page.goBack();
    await expect(borrowedDialog(page)).toHaveCount(0);
    await expect.poll(scroll).toBe(scrolled);
  });
}

const scroll = (page: Page) => page.evaluate(() => window.scrollY);
const cards = (page: Page) => page.getByRole("region", { name: "Cards" });
/** A tab link. A modal sheet or list holds the tabs inert, so a collector leaves it by history; the test presses
 * the link itself, which is what a pointer does when nothing covers it. */
const tab = (page: Page, name: string) =>
  page.getByRole("link", { name, exact: true }).first();
const press = (page: Page, name: string) =>
  tab(page, name).evaluate((link) => (link as HTMLElement).click());

for (const size of SIZES) {
  test(`a Collection tab return keeps the listing's scroll though the Borrowed list was open at ${size.name}`, async ({
    page,
    collectors,
  }) => {
    const { home } = await setup(page, collectors, size, 90);
    await page.goto(`${ORIGIN}/collection?location=${home}`);
    await expect(cards(page).getByRole("button").first()).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, 600));
    await expect.poll(() => scroll(page)).toBe(600);
    await openBorrowed(page, size.phone);
    const saved = await scroll(page);
    expect(saved).toBeGreaterThanOrEqual(194);
    await press(page, "Catalog");
    await expect(page).toHaveURL(/\/catalog/);
    await tab(page, "Collection").click();
    await expect(page).toHaveURL(/\/collection/);
    await expect(cards(page).getByRole("button").first()).toBeVisible();
    expect(params(page).has("borrowed")).toBe(false);
    expect(params(page).get("location")).toBe(home);
    await expect(borrowedDialog(page)).toHaveCount(0);
    await expect
      .poll(async () => Math.abs((await scroll(page)) - saved))
      .toBeLessThanOrEqual(2);
  });

  test(`a card's overlay survives a tab return with its scroll at ${size.name}`, async ({
    page,
    collectors,
  }) => {
    const { home } = await setup(page, collectors, size, 90);
    await page.goto(`${ORIGIN}/collection?location=${home}`);
    await expect(cards(page).getByRole("button").first()).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, 600));
    await expect.poll(() => scroll(page)).toBe(600);
    // A tile that began below the fold: were the scroll lost, it would be out of the viewport after the return.
    const tiles = cards(page).getByRole("button");
    const viewportHeight = page.viewportSize()!.height;
    let label = "";
    for (let i = 0; i < (await tiles.count()) && !label; i++) {
      const box = await tiles.nth(i).boundingBox();
      if (
        box &&
        box.y > viewportHeight - 600 &&
        box.y + box.height < viewportHeight
      )
        label = (await tiles.nth(i).getAttribute("aria-label")) ?? "";
    }
    expect(label).not.toBe("");
    const tile = cards(page).getByRole("button", { name: label, exact: true });
    await tile.click();
    await expect(page).toHaveURL(/[?&]card=/);
    const saved = await scroll(page);
    const address = page.url();
    // Away to Catalog and back: the tab returns to the same address, and the page to the same place.
    await press(page, "Catalog");
    await expect(page).toHaveURL(/\/catalog/);
    await tab(page, "Collection").click();
    await expect(page).toHaveURL(address);
    // The card's details are back: the aside on a desktop, the sheet on a phone.
    const details = size.phone
      ? page.getByRole("dialog", { name: "Boss's Orders", exact: true })
      : page.getByRole("complementary", { name: "Card details" });
    await expect(details).toBeVisible();
    await expect(details).toContainText("Boss's Orders");
    // Before anything is clicked, so no auto-scroll can hide a lost position: the same tile is in view.
    await expect(tile).toBeInViewport();
    await expect
      .poll(async () => Math.abs((await scroll(page)) - saved))
      .toBeLessThanOrEqual(2);
  });

  test(`a reload on the Borrowed address reopens it and Back closes it at ${size.name}`, async ({
    page,
    collectors,
  }) => {
    const { home } = await setup(page, collectors, size, 90);
    await page.goto(`${ORIGIN}/collection?location=${home}`);
    await expect(cards(page).getByRole("button").first()).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, 600));
    await expect.poll(() => scroll(page)).toBe(600);
    await openBorrowed(page, size.phone);
    await page.reload();
    await expect(borrowedDialog(page)).toBeVisible();
    expect(params(page).get("borrowed")).toBe("1");
    // History positions live in the page's memory, so a reload starts the entries before it at the top, for a card's
    // overlay as for this list; Back still closes the list over the same Location.
    // The scroll position is intentionally not asserted here (an open low item, owner-waived).
    await page.goBack();
    await expect(borrowedDialog(page)).toHaveCount(0);
    expect(params(page).has("borrowed")).toBe(false);
    expect(params(page).get("location")).toBe(home);
  });
}

test("Back from a card's sheet restores the listing's scroll", async ({
  page,
  collectors,
}) => {
  const { home } = await setup(page, collectors, SIZES[1], 90);
  await page.goto(`${ORIGIN}/collection?location=${home}`);
  await expect(cards(page).getByRole("button").first()).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 600));
  await expect.poll(() => scroll(page)).toBe(600);
  await cards(page).getByRole("button").nth(14).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  const saved = await scroll(page);
  expect(saved).toBeGreaterThan(0);
  await page.goBack();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(params(page).has("card")).toBe(false);
  await expect
    .poll(async () => Math.abs((await scroll(page)) - saved))
    .toBeLessThanOrEqual(2);
});

test.describe("the aside follows a moved copy of either kind", () => {
  test.use({ viewport: SIZES[0].viewport });
  const aside = (page: Page) =>
    page.getByRole("complementary", { name: "Card details" });

  async function moveFirst(page: Page, tile: RegExp, destination: string) {
    await cards(page).getByRole("button", { name: tile }).first().click();
    await aside(page)
      .getByRole("button", { name: "Move…", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "Move 1 copy" });
    await dialog
      .getByRole("button", { name: destination, exact: true })
      .click();
    await dialog.getByRole("button", { name: "Move 1 copy" }).click();
    await expect(dialog).toHaveCount(0);
  }

  test("the last Borrowed Copy moves where an owned copy of the card sits: the aside shows the borrowed one", async ({
    page,
    collectors,
  }) => {
    const { box, loan, iono } = await setup(page, collectors, SIZES[0], 1, {
      lent: 1,
      ownIono: true,
    });
    await page.goto(`${ORIGIN}/collection`);
    await moveFirst(page, /Iono.*borrowed from Misty W/, "M13 Box");
    await expect(aside(page)).toContainText("Iono");
    await expect(aside(page)).toContainText("borrowed from Misty W");
    await expect(aside(page)).toContainText("M13 Box");
    expect(params(page).get("card")).toBe(`borrowed:${loan}:${box}:${iono}`);
  });

  test("the last owned copy moves where a Borrowed Copy of the card sits: the aside shows the owned one", async ({
    page,
    collectors,
  }) => {
    const { home, box, iono } = await setup(page, collectors, SIZES[0], 1, {
      lent: 1,
      ownIono: true,
    });
    await page.goto(`${ORIGIN}/collection`);
    await moveFirst(page, /^Iono(?!.*borrowed)/, "Unsorted");
    await expect(aside(page)).toContainText("Iono");
    await expect(aside(page)).not.toContainText("borrowed from");
    expect(params(page).get("card")).toBe(`${home}:${iono}`);
    expect(box).not.toBe(home);
  });
});
