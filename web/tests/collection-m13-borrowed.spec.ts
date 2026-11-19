// m13 s5: the Borrowed list has an address of its own (?borrowed=1 on the Collection address), so reload, Back,
// Forward and a pasted link bring it back, and it leaves the Location and search in the address alone.
import { randomUUID } from "node:crypto";
import { expect, test } from "./support/collectors";
import {
  ORIGIN,
  befriend,
  hold,
  lendHandedOver,
  nameCollector,
  seedCatalog,
  unsorted,
  api,
} from "./support/loans";
import { signInAsOwner } from "./support/sign-in";
import type { Page } from "@playwright/test";

const SIZES = [
  { name: "desktop", viewport: { width: 1280, height: 800 }, phone: false },
  { name: "phone", viewport: { width: 375, height: 812 }, phone: true },
] as const;

for (const size of SIZES) {
  test(`the Borrowed list has its own address at ${size.name}`, async ({
    page,
    collectors,
  }) => {
    test.slow();
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
    await hold(page, await unsorted(page), ids["PAL 172"], 1);
    const box = (
      await api(page, "POST", "/api/location-tree", {
        name: `Box ${randomUUID().slice(0, 6)}`,
        parent_id: null,
        parent_version: null,
        idempotency_key: randomUUID(),
      })
    ).location.id as string;
    await hold(page, box, ids["PAL 172"], 1);
    await befriend(page, lender);
    await lendHandedOver(lender, page, [[ids["PAL 185"], 2]]);

    const dialog = page.getByRole("dialog", { name: "Borrowed" });
    const open = async () => {
      if (size.phone) {
        await page.getByRole("button", { name: "Open locations" }).click();
        await page.getByRole("button", { name: /^Borrowed/ }).click();
      } else
        await page
          .getByRole("complementary", { name: "Sidebar" })
          .getByRole("button", { name: /^Borrowed/ })
          .click();
      await expect(dialog).toBeVisible();
    };
    const cards = page.getByRole("region", { name: "Cards" });

    await page.goto(`${ORIGIN}/collection?location=${box}`);
    await expect(page.getByRole("heading", { level: 1 })).not.toHaveText(
      "All owned"
    );
    await open();
    const search = new URL(page.url()).searchParams;
    expect(search.get("borrowed")).toBe("1");
    expect(search.get("location")).toBe(box);

    // Reload brings the list back, over the same Location.
    await page.reload();
    await expect(dialog).toBeVisible();
    expect(new URL(page.url()).searchParams.get("location")).toBe(box);

    // Closing drops it from the address and the entry; Forward opens it again; Back closes it.
    await dialog.getByRole("button", { name: "Close Borrowed" }).click();
    await expect(dialog).toHaveCount(0);
    expect(new URL(page.url()).searchParams.has("borrowed")).toBe(false);
    await page.goForward();
    await expect(dialog).toBeVisible();
    await page.goBack();
    await expect(dialog).toHaveCount(0);
    expect(new URL(page.url()).searchParams.has("borrowed")).toBe(false);
    expect(new URL(page.url()).searchParams.get("location")).toBe(box);

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
    expect(new URL(page.url()).searchParams.has("borrowed")).toBe(false);
    expect(new URL(page.url()).searchParams.has("card")).toBe(false);
    await expect(cards).toBeVisible();
    await expectNoBorrowedLeak(page);
  });
}

async function expectNoBorrowedLeak(page: Page) {
  await expect(page.getByRole("dialog")).toHaveCount(0);
}
