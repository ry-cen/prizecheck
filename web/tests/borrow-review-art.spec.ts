import { expect, test } from "./support/collectors";
import {
  seedCatalog,
  nameCollector,
  hold,
  unsorted,
  befriend,
  ORIGIN,
} from "./support/loans";
import { signInAsOwner } from "./support/sign-in";
import { PIXEL } from "./support/art-upstream";

for (const viewport of [
  { width: 1280, height: 800 },
  { width: 375, height: 812 },
]) {
  test(`Borrow review preserves matching Edition artwork and fits missing art at ${viewport.width}`, async ({
    page,
    collectors,
  }) => {
    await page.setViewportSize(viewport);
    const ids = seedCatalog();
    const friend = await collectors.signIn({ next: "/loans" });
    await nameCollector(friend.page, "Misty W");
    await hold(friend.page, await unsorted(friend.page), ids["PAL 185"], 1);
    await hold(friend.page, await unsorted(friend.page), ids["PAL 172"], 1);
    await signInAsOwner(page, "/catalog");
    await befriend(page, friend.page);
    // Supply an available image on exactly one Edition, leaving the other genuinely without art.
    await page.route("**/api/catalog/printings/*", async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      for (const edition of body.printing.editions) {
        edition.image_url =
          edition.id === ids["PAL 185"] ? "/review-art.png" : null;
      }
      await route.fulfill({ response, json: body });
    });
    await page.route("**/review-art.png", (route) =>
      route.fulfill({ contentType: "image/png", body: PIXEL })
    );
    for (const name of ["Iono, PAL 185", "Boss's Orders, PAL 172"]) {
      await page
        .getByRole("region", { name: "Catalog results" })
        .getByRole("button", {
          name: new RegExp(`^${name}, Paldea Evolved, Normal,`),
        })
        .click();
      const popup = page.getByRole("dialog");
      if (name.startsWith("Iono"))
        await expect(
          popup.locator('img[src="/review-art.png"]')
        ).toHaveJSProperty("naturalWidth", 1);
      await popup
        .getByRole("button", { name: /^Ask to borrow .* from Misty W/ })
        .click();
      await popup.getByRole("button", { name: /^Close/ }).click();
    }
    await page
      .getByRole("region", { name: "Borrow Request drafts" })
      .getByRole("button", { name: "Review Borrow Request to Misty W" })
      .click();
    const cards = page.getByRole("list", { name: "Cards to borrow" });
    await expect(cards.locator("img")).toHaveJSProperty("naturalWidth", 1);
    const fallback = cards.getByText("Artwork unavailable", { exact: true });
    await expect(fallback).toBeVisible();
    await expect
      .poll(() =>
        fallback.evaluate((el) => {
          const box = el.parentElement!.getBoundingClientRect();
          const range = document.createRange();
          range.selectNodeContents(el);
          return Array.from(range.getClientRects()).every(
            (rect) =>
              rect.left >= box.left &&
              rect.right <= box.right &&
              rect.top >= box.top &&
              rect.bottom <= box.bottom
          );
        })
      )
      .toBe(true);
  });
}
