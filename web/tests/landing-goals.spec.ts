// The landing page leads with the two ways a collector starts, Import a deck and Add my cards, each a link to the real
// import page: signed out, that address shows the sign-in card in its place, and signing in opens it.
import { test, expect, type Page } from "@playwright/test";
import { expectPageChecks } from "./support/page-check";
import { signInWithButton } from "./support/sign-in";

const ORIGIN = process.env.TEST_ORIGIN || "http://localhost:5173";
const CONTINUING = "Sign in to continue where you left off.";

const goals = (page: Page) =>
  page.getByRole("list", { name: "Where to start" });
const heading = (page: Page) => page.getByRole("heading", { level: 1 });

const GOALS = [
  {
    name: "Import a deck",
    href: "/decks/import",
    description: /^Paste a decklist from Pokémon TCG Live or Limitless/,
    opens: "Import a decklist",
  },
  {
    name: "Add my cards",
    href: "/collection/import",
    description: /^Upload another tracker's export or paste a list/,
    opens: "Import your collection",
  },
] as const;

test.describe("landing goals", () => {
  test("the landing page offers Import a deck and Add my cards beside Sign in and Discover decks", async ({
    page,
  }, testInfo) => {
    for (const [width, height] of [
      [1280, 800],
      [375, 812],
      [320, 568],
    ] as const) {
      await page.setViewportSize({ width, height });
      await page.goto(`${ORIGIN}/`);
      await expect(goals(page).getByRole("link")).toHaveCount(2);
      for (const goal of GOALS) {
        const link = goals(page).getByRole("link", {
          name: goal.name,
          exact: true,
        });
        await expect(link).toHaveAttribute("href", goal.href);
        await expect(link).toHaveAccessibleDescription(goal.description);
      }
      const main = page.getByRole("main");
      await expect(
        main.getByRole("link", { name: "Sign in", exact: true })
      ).toHaveAttribute("href", "/sign-in");
      await expect(
        main.getByRole("link", { name: "Discover decks" })
      ).toHaveAttribute("href", "/discover");
      await expectPageChecks(page, `the landing goals at ${width} px`);
      // Kept for a visual check of the layout at each width, pass or fail.
      await page.screenshot({
        path: testInfo.outputPath(`landing-${width}.png`),
        fullPage: true,
      });
    }
  });

  for (const goal of GOALS)
    test(`${goal.name} signs in, then opens ${goal.opens}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto(`${ORIGIN}/`);
      await goals(page)
        .getByRole("link", { name: goal.name, exact: true })
        .click();
      await expect(page).toHaveURL(`${ORIGIN}${goal.href}`);
      await expect(heading(page)).toHaveText("Sign in to PrizeCheck");
      await expect(page.getByText(CONTINUING)).toBeVisible();

      await signInWithButton(page);
      await expect(page).toHaveURL(`${ORIGIN}${goal.href}`);
      await expect(heading(page)).toHaveText(goal.opens);
    });
});
