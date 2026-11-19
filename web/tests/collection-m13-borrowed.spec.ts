// m13 s5: the Borrowed list has an address of its own (?borrowed=1 on the Collection address), so reload, Back,
// Forward and a pasted link bring it back, a return through the Collection tab doesn't, and its Back keeps the
// listing's scroll.
import { expect, test } from "./support/collectors";
import {
  ORIGIN,
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

/** Ash holds `copies` of one card in Unsorted and borrows two Iono from Misty. Returns Unsorted's id. */
async function setup(
  page: Page,
  collectors: Collectors,
  size: (typeof SIZES)[number],
  copies: number
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
  await lendHandedOver(lender, page, [[ids["PAL 185"], 2]]);
  return home;
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
    const home = await setup(page, collectors, size, 1);
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
    const home = await setup(page, collectors, size, 1);
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
    const home = await setup(page, collectors, size, 90);
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
