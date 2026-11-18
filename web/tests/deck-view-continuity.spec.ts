import type { Page } from "@playwright/test";
import { test, expect } from "./support/collectors";
import { api, createDeck, ORIGIN, seedCatalog, setLine } from "./support/loans";

// Hill-climb m13 s2 (Sol m12 B-02, B-03): a Deck keeps the Deck List layout the collector chose, and the Want List
// keeps its place, when a collector comes back with Back, Forward or a reload.

const VIEWPORTS = [
  { name: "desktop", width: 1280, height: 800, phone: false },
  { name: "phone", width: 375, height: 812, phone: true },
] as const;

const KEYS = ["PAL 185", "PAL 254", "PAF 80", "SVE 5", "SVE 13"];

async function seed(page: Page, decks: string[]) {
  // Card artwork never reaches the network.
  await page.route(/^https:\/\/assets\.tcgdex\.net\//, (route) =>
    route.abort()
  );
  const ids = seedCatalog();
  const created: string[] = [];
  for (const name of decks) {
    const id = await createDeck(page, name);
    // Cards the collector doesn't own, so the Deck needs them and the Want List has a section for it.
    for (const key of KEYS) await setLine(page, id, ids[key], 4);
    created.push(id);
  }
  return { ids, created };
}

const layoutChoice = (page: Page, name: string) =>
  page
    .getByRole("radiogroup", { name: "Deck List view" })
    .getByRole("radio", { name, exact: true });

async function expectLayout(page: Page, name: string) {
  for (const other of ["Spread", "Stacked", "List"])
    await expect(layoutChoice(page, other)).toHaveAttribute(
      "aria-checked",
      other === name ? "true" : "false"
    );
}

for (const viewport of VIEWPORTS) {
  test.describe(`${viewport.name} ${viewport.width}×${viewport.height}`, () => {
    test("a Deck keeps its chosen layout across Want List, Back, Forward and reload", async ({
      collectors,
    }) => {
      const { page } = await collectors.signIn({
        contextOptions: {
          viewport: { width: viewport.width, height: viewport.height },
          isMobile: viewport.phone,
          hasTouch: viewport.phone,
        },
      });
      const {
        created: [deck],
      } = await seed(page, ["Garden practice"]);
      const base = `${ORIGIN}/decks/${deck}`;
      const standard = viewport.phone ? "Stacked" : "Spread";

      // Nothing chosen: the default for this width, and the address stays clean.
      await page.goto(base);
      await expectLayout(page, standard);
      expect(new URL(page.url()).search).toBe("");

      // Choosing a layout rewrites the entry; it adds none.
      const entries = await page.evaluate(() => history.length);
      await layoutChoice(page, "List").click();
      await expectLayout(page, "List");
      await expect(page).toHaveURL(/[?&]layout=list(&|$)/);
      expect(await page.evaluate(() => history.length)).toBe(entries);

      // Deck, Want List, Back: the Deck comes back in List.
      await page
        .getByRole("button", { name: "Want List", exact: true })
        .click();
      await expect(page).toHaveURL(/\/decks\/want-list\?deck=/);
      await expect(
        page.getByRole("heading", { name: /^Want List · Garden practice$/ })
      ).toBeVisible();
      await page.goBack();
      await expect(page).toHaveURL(new RegExp(`/decks/${deck}\\?layout=list$`));
      await expectLayout(page, "List");

      // Forward to the Want List and Back again, then a reload.
      await page.goForward();
      await expect(page).toHaveURL(/\/decks\/want-list/);
      await page.goBack();
      await expectLayout(page, "List");
      await page.reload();
      await expectLayout(page, "List");
      await expect(page).toHaveURL(new RegExp(`/decks/${deck}\\?layout=list$`));

      // A layout picked on its own is kept too, including the default's own name.
      await layoutChoice(page, standard).click();
      await expectLayout(page, standard);
      await page
        .getByRole("button", { name: "Want List", exact: true })
        .click();
      await expect(page).toHaveURL(/\/decks\/want-list\?deck=/);
      await page.goBack();
      await expectLayout(page, standard);

      // Deep links open in that layout; an unknown value reads as the default.
      await page.goto(`${base}?layout=stacked`);
      await expectLayout(page, "Stacked");
      await page.goto(`${base}?layout=spread`);
      await expectLayout(page, "Spread");
      await page.goto(`${base}?layout=nonsense`);
      await expectLayout(page, standard);
    });

    test("the Deck sheet keeps the chosen layout through its own history", async ({
      collectors,
    }) => {
      const { page } = await collectors.signIn({
        contextOptions: {
          viewport: { width: viewport.width, height: viewport.height },
          isMobile: viewport.phone,
          hasTouch: viewport.phone,
        },
      });
      const {
        created: [deck],
      } = await seed(page, ["Sheet practice"]);
      await page.goto(`${ORIGIN}/decks/${deck}`);
      await layoutChoice(page, "List").click();
      await expectLayout(page, "List");
      await page.locator("[data-edition-id]").first().click();
      const sheet = page.getByRole("dialog").first();
      await expect(sheet).toBeVisible();
      await expect(page).toHaveURL(
        /layout=list.*edition=|edition=.*layout=list/
      );
      await page.goBack();
      await expect(sheet).toBeHidden();
      await expectLayout(page, "List");
      await expect(page).toHaveURL(new RegExp(`/decks/${deck}\\?layout=list$`));
      await page.goForward();
      await expect(sheet).toBeVisible();
      await page.goBack();
      await expectLayout(page, "List");
    });

    test("the Want List returns to the same place after leaving for another page", async ({
      collectors,
    }) => {
      const { page } = await collectors.signIn({
        contextOptions: {
          viewport: { width: viewport.width, height: viewport.height },
          isMobile: viewport.phone,
          hasTouch: viewport.phone,
        },
      });
      const { ids } = await seed(page, ["Practice", "Weekend", "Tournament"]);
      for (const key of KEYS.slice(0, 3))
        await api(page, "PUT", `/api/trade-wants/${ids[key]}`, {
          quantity: "2",
        });
      await page.goto(`${ORIGIN}/decks/want-list`);
      const wants = page.getByRole("region", {
        name: "Trade Wants",
        exact: true,
      });
      const entriesList = wants.getByRole("list", {
        name: "Your Trade Wants",
      });
      await expect(entriesList).toBeVisible();
      // Near the bottom, as the review scrolled: the Trade Wants panel in view.
      await wants.scrollIntoViewIfNeeded();
      await page.evaluate(() => window.scrollBy(0, 200));
      const saved = await page.evaluate(() => window.scrollY);
      expect(saved).toBeGreaterThan(viewport.height);
      await page
        .getByRole("navigation", { name: "Main views" })
        .getByRole("link", { name: "Catalog", exact: true })
        .click();
      await expect(page).toHaveURL(/\/catalog/);
      await page.goBack();
      await expect(page).toHaveURL(/\/decks\/want-list/);
      await expect(entriesList).toBeVisible();
      // The late layout (prices, Friends' cards, Trade Wants) has arrived: the position is the one left.
      await expect
        .poll(() => page.evaluate(() => window.scrollY))
        .toBeGreaterThanOrEqual(saved - 2);
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve))
          )
      );
      const settled = await page.evaluate(() => window.scrollY);
      expect(Math.abs(settled - saved)).toBeLessThanOrEqual(2);
    });
  });
}
