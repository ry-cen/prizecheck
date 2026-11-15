import { test, expect } from "./support/collectors";
import { api, createDeck, ORIGIN, seedCatalog, setLine } from "./support/loans";

for (const phone of [true, false]) {
  for (const populated of [false, true]) {
    test(`${phone ? "phone" : "desktop"}: first-screen Trade Wants access (${populated ? "populated" : "empty"})`, async ({
      collectors,
    }) => {
      const ids = seedCatalog();
      const { page } = await collectors.signIn({
        contextOptions: {
          viewport: phone
            ? { width: 375, height: 812 }
            : { width: 1280, height: 800 },
          isMobile: phone,
          hasTouch: phone,
        },
      });
      await page.route(/^https:\/\/assets\.tcgdex\.net\//, (route) =>
        route.abort()
      );
      for (const name of ["Practice", "Weekend", "Tournament"]) {
        const deck = await createDeck(page, name);
        for (const key of ["PAL 185", "PAL 254", "PAF 80", "SVE 5", "SVE 13"])
          await setLine(page, deck, ids[key], 4);
      }
      if (populated)
        await api(page, "PUT", `/api/trade-wants/${ids["PAL 185"]}`, {
          quantity: "1",
        });
      await page.goto(`${ORIGIN}/decks/want-list`);
      const shortcut = page.getByRole("link", {
        name: populated
          ? "Trade Wants · 1 copy across 1 entry"
          : "Add a Trade Want",
        exact: true,
      });
      await expect(shortcut).toBeVisible();
      const bottom = await page
        .getByRole("navigation", { name: "Main views" })
        .evaluate((node) => node.getBoundingClientRect().top);
      const box = (await shortcut.boundingBox())!;
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height).toBeLessThanOrEqual(phone ? bottom : 800);
      const add = page
        .getByRole("region", { name: "Trade Wants", exact: true })
        .getByRole("button", { name: "Add a card", exact: true });
      expect((await add.boundingBox())!.y).toBeGreaterThan(phone ? 812 : 800);
      if (phone)
        await page.screenshot({
          path: test.info().outputPath("phone-want-list-first-screen.png"),
        });
      const address = page.url();
      const historyLength = await page.evaluate(() => history.length);
      await shortcut.focus();
      await shortcut.press("Enter");
      await expect(add).toBeFocused();
      await expect(add).toBeInViewport({ ratio: 1 });
      const target = (await add.boundingBox())!;
      expect(target.y).toBeGreaterThanOrEqual(
        await page
          .locator("header")
          .first()
          .evaluate((node) => node.getBoundingClientRect().bottom)
      );
      expect(target.y + target.height).toBeLessThanOrEqual(
        phone ? bottom : 800
      );
      await expect(page).toHaveURL(address);
      expect(await page.evaluate(() => history.length)).toBe(historyLength);
    });
  }
}
