import type { Page } from "@playwright/test";
import { test, expect } from "./support/collectors";
import { api, createDeck, ORIGIN, seedCatalog, setLine } from "./support/loans";

// Desktop already shows a failed Deck List change's banner at the top of the page with a working Try again; the
// copy sheet's own error line must not change that.
const DESKTOP = { width: 1280, height: 800 };
const NOTICE = /may not have been saved/;

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

test("desktop: a failed +1 from a Deck card shows the page banner and its Try again works", async ({
  collectors,
}) => {
  const ids = seedCatalog();
  const { page } = await collectors.signIn({
    contextOptions: { viewport: DESKTOP },
  });
  await page.route(/^https:\/\/assets\.tcgdex\.net\//, (route) =>
    route.abort()
  );
  const deck = await createDeck(page, "Desktop failure");
  await setLine(page, deck, ids["PAL 185"], 3);
  await page.goto(`${ORIGIN}/decks/${deck}`);
  const control = page.locator("[data-edition-id]").first();
  await expect(control).toBeVisible();
  await control.hover();
  await failWrites(page);
  await page.getByRole("button", { name: "Add one Iono" }).first().click();
  const banner = page.getByRole("alert").filter({ hasText: NOTICE });
  await expect(banner).toBeVisible();
  const again = banner.getByRole("button", { name: "Try again" });
  await expect(again).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await saved(page, deck, ids["PAL 185"])).toBe("3");
  await page.unroute("**/api/decks/**");
  await again.click();
  await expect(banner).toHaveCount(0);
  await expect.poll(() => saved(page, deck, ids["PAL 185"])).toBe("4");
});

test("desktop: a failed +1 in the copy sheet shows the same one count and its Try again in the sheet", async ({
  collectors,
}) => {
  const ids = seedCatalog();
  const { page } = await collectors.signIn({
    contextOptions: { viewport: DESKTOP },
  });
  await page.route(/^https:\/\/assets\.tcgdex\.net\//, (route) =>
    route.abort()
  );
  const deck = await createDeck(page, "Desktop sheet failure");
  await setLine(page, deck, ids["PAL 185"], 3);
  await page.goto(`${ORIGIN}/decks/${deck}`);
  await page.locator("[data-edition-id]").first().click();
  const sheet = page.getByRole("dialog", { name: "Iono", exact: true });
  await expect(sheet).toBeVisible();
  const count = sheet
    .getByRole("group", { name: "Deck List copies" })
    .locator("strong");
  await failWrites(page);
  await sheet.getByRole("button", { name: /^\+1, Add one Iono/ }).click();
  await expect(
    sheet.getByRole("status").filter({ hasText: NOTICE })
  ).toHaveCount(1);
  await expect(count).toHaveText("3");
  await expect(
    sheet.getByRole("heading", { name: /on the Deck List/ })
  ).toHaveText("3 on the Deck List");
  await page.unroute("**/api/decks/**");
  await sheet.getByRole("button", { name: "Try again" }).click();
  await expect(count).toHaveText("4");
  await expect.poll(() => saved(page, deck, ids["PAL 185"])).toBe("4");
});
