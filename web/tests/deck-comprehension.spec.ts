import { test, expect } from "./support/collectors";
import {
  createDeck,
  hold,
  ORIGIN,
  seedCatalog,
  setLine,
} from "./support/loans";

for (const viewport of [
  { width: 1280, height: 800 },
  { width: 375, height: 812 },
]) {
  test(`spare-copy details and missing labels at ${viewport.width}px`, async ({
    collectors,
  }) => {
    const ids = seedCatalog();
    const page = (await collectors.signIn({ contextOptions: { viewport } }))
      .page;
    const keeper = await createDeck(page, "Keeper");
    const deck = await createDeck(page, "Weekend");
    for (const edition of [ids["PAL 185"], ids["PAL 172"], ids["SVE 13"]]) {
      await hold(page, keeper, edition, 1);
      await setLine(page, deck, edition, 4);
    }
    await page.goto(`${ORIGIN}/decks/${deck}`);
    const warning = page.getByRole("group", {
      name: "Other Decks count the same spare copies",
    });
    await expect(warning).toBeVisible();
    const details = warning.locator("details");
    if (viewport.width <= 760) {
      await expect(details).not.toHaveAttribute("open");
      await expect
        .poll(() =>
          warning.evaluate((element) => element.getBoundingClientRect().height)
        )
        .toBeLessThanOrEqual(viewport.height / 4);
      await expect
        .poll(() =>
          page
            .getByRole("heading", {
              name: "Deck List",
              exact: true,
            })
            .evaluate(
              (element) => element.getBoundingClientRect().top + scrollY
            )
        )
        .toBeLessThan(viewport.height);
      await warning.locator("summary").click();
    }
    await expect(details).toHaveAttribute("open");
    await expect(
      warning.getByText("Keeper holds 1 for its own Deck List.", {
        exact: true,
      })
    ).toHaveCount(3);
    if (viewport.width <= 760) {
      await warning.locator("summary").click();
      await expect(details).not.toHaveAttribute("open");
    }

    // An entirely unowned card exercises both the Deck's rows and the Want List's tiles.
    await setLine(page, deck, ids["SVI 166"], 4);
    await page.reload();
    await page
      .getByRole("button", { name: "Ways to get missing cards" })
      .click();
    const panel = page.getByRole("region", {
      name: "Ways to get missing cards",
    });
    const row = panel.getByRole("listitem").filter({ hasText: "Arven" });
    await expect(row).toContainText("Need 4 of 4");
    await expect(row).toContainText("None owned");
    await page.goto(`${ORIGIN}/decks/want-list?deck=${deck}`);
    const tile = page
      .getByRole("list", { name: "What Weekend needs" })
      .getByRole("listitem")
      .filter({ hasText: "Arven" });
    await expect(tile).toContainText("Need 4 of 4");
    await expect(tile).toContainText("None owned");
  });
}
