import { test } from "./support/art-upstream";
// Ticket #319: the Scan Suggestion. An image-only match is offered as up to three candidates instead of an automatic lock;
// a card is added only when one is picked. None of these opens search and the same card is not suggested again until it
// leaves the guide; a card taken out unanswered is skipped; the shutter is greyed out while a suggestion shows. Driven
// by the stub recognizer (frame injection). Every state runs the shared page check at 1280×800 and 375×812.
import { expect, type Page } from "@playwright/test";
import { expectPageChecks } from "./support/page-check";
import { expectTouchTarget } from "./support/touch-target";
import {
  choiceCard,
  empty,
  hintPill,
  holding,
  imageOnly,
  installScript,
  openScanner,
  pickFinish,
  printingIds,
  reviewTray,
  seedPopup,
  signInFresh,
  suggestionCard,
  trayOpen,
  trayPeek,
} from "./support/scanner";

const SIZES = [
  { name: "desktop", viewport: { width: 1280, height: 800 }, phone: false },
  { name: "phone", viewport: { width: 375, height: 812 }, phone: true },
] as const;

const shutter = (page: Page) =>
  page.getByRole("button", { name: "Scan this card", exact: true });

for (const size of SIZES) {
  test.describe(size.name, () => {
    test.use({
      viewport: size.viewport,
      hasTouch: size.phone,
    });
    test.beforeEach(() => seedPopup());

    test("an image-only match shows three candidates, adds nothing until one is picked, and the pick enters the tray", async ({
      page,
    }) => {
      await signInFresh(page);
      const ids = await printingIds(page);
      const ranking = [ids["Bulbasaur"], ids["Rare Candy"], ids["Switch"]];
      // The card stays in the guide: after the last frame the last one repeats.
      await installScript(page, { frames: imageOnly(ranking) });
      await openScanner(page);

      const card = suggestionCard(page);
      await expect(card).toBeVisible();
      await expect(card.getByRole("heading")).toHaveText("Is it one of these?");
      // Three versions: Bulbasaur has two finishes (chips, none selected); Rare Candy and Switch have one (a button).
      const candidates = card.getByRole("listitem");
      await expect(candidates).toHaveCount(3);
      await expect(candidates.nth(0)).toContainText("Bulbasaur");
      await expect(candidates.nth(1)).toContainText("Rare Candy");
      await expect(candidates.nth(2)).toContainText("Switch");
      await expect(
        candidates.nth(0).getByRole("button", { pressed: true })
      ).toHaveCount(0);
      await expect(
        candidates.nth(0).getByRole("button", { name: "Normal", exact: true })
      ).toBeVisible();
      await expect(
        candidates
          .nth(0)
          .getByRole("button", { name: "Reverse Holo", exact: true })
      ).toBeVisible();
      await expect(
        card.getByRole("button", { name: "None of these" })
      ).toBeVisible();
      // No scores, no prices; every image is same-origin art.
      await expect(card).not.toContainText(/\$|%|score/i);
      expect(
        await page.evaluate(
          () =>
            [...document.images].filter(
              (i) => new URL(i.src).origin !== location.origin
            ).length
        )
      ).toBe(0);

      // Focus is in the suggestion, on its first control; the shutter is greyed out and announced as unavailable.
      await expect(
        candidates.nth(0).getByRole("button", { name: "Normal", exact: true })
      ).toBeFocused();
      await expect(shutter(page)).toBeDisabled();
      // No lock cue: the guide does not flash, and nothing is in the tray.
      await expect(page.getByTestId("scanner-guide")).not.toHaveAttribute(
        "data-flash"
      );
      await expect(trayPeek(page)).toContainText("Empty");
      if (size.phone) {
        await expectTouchTarget(
          candidates.nth(0).getByRole("button", { name: "Normal", exact: true })
        );
        await expectTouchTarget(candidates.nth(2).getByRole("button"));
        await expectTouchTarget(
          card.getByRole("button", { name: "None of these" })
        );
      }
      await expectPageChecks(page, `${size.name} scanner, suggestion`);

      await candidates.nth(1).getByRole("button").click();
      await expect(card).toBeHidden();
      await expect(trayPeek(page)).toContainText("Rare Candy");
      await expect(trayPeek(page)).toContainText("×1");
      // Focus goes back to the shutter, which is enabled again.
      await expect(shutter(page)).toBeEnabled();
      await expect(shutter(page)).toBeFocused();
      // The same card still in the guide is not suggested again.
      // flake-exempt wait-for-timeout (quiet): nothing on the page marks a suggestion that must not come
      await page.waitForTimeout(700);
      await expect(card).toHaveCount(0);

      await reviewTray(page);
      await expect(trayOpen(page)).toContainText("Rare Candy");
      await expect(trayOpen(page)).not.toContainText("Bulbasaur");
    });

    test("the picked finish is the row's finish", async ({ page }) => {
      await signInFresh(page);
      const ids = await printingIds(page);
      await installScript(page, {
        frames: imageOnly([ids["Bulbasaur"], ids["Switch"]]),
      });
      await openScanner(page);
      const card = suggestionCard(page);
      // Two candidates resolve: Bulbasaur offers its finishes, Switch is one button.
      await expect(
        card.getByRole("group", { name: "Finish of Bulbasaur" })
      ).toBeVisible();
      await expect(card.getByRole("button", { name: /^Switch/ })).toBeVisible();
      await pickFinish(page, "Reverse Holo", "Bulbasaur");
      await expect(trayPeek(page)).toContainText("Bulbasaur");
      await reviewTray(page);
      const finishes = trayOpen(page).getByRole("group", {
        name: "Finish of Bulbasaur",
      });
      await expect(
        finishes.getByRole("button", { name: "Reverse Holo", exact: true })
      ).toHaveAttribute("aria-pressed", "true");
      await expect(
        finishes.getByRole("button", { name: "Normal", exact: true })
      ).toHaveAttribute("aria-pressed", "false");
    });

    test("None of these opens search, and the card is not suggested again until it leaves the guide", async ({
      page,
    }) => {
      await signInFresh(page);
      const ids = await printingIds(page);
      const ranking = [ids["Bulbasaur"], ids["Rare Candy"], ids["Switch"]];
      await installScript(page, {
        frames: [
          ...imageOnly(ranking, 4),
          ...imageOnly(ranking, 400),
          ...empty(30),
          ...imageOnly(ranking, 4),
        ],
      });
      await openScanner(page);

      const card = suggestionCard(page);
      await expect(card).toBeVisible();
      await card.getByRole("button", { name: "None of these" }).click();
      const search = page.getByRole("dialog", { name: "Find this card" });
      await expect(search).toBeVisible();
      await expect(
        search.getByRole("searchbox", { name: "Search the catalog" })
      ).toBeFocused();
      await expect(card).toBeHidden();
      await expect(trayPeek(page)).toContainText("Empty");
      await expectPageChecks(
        page,
        `${size.name} scanner, search after None of these`
      );

      await search.getByRole("button", { name: "Back to scanning" }).click();
      await expect(search).toBeHidden();
      await expect(shutter(page)).toBeFocused();
      // The card is still in the guide: no new suggestion.
      // flake-exempt wait-for-timeout (quiet): nothing on the page marks a suggestion that must not come
      await page.waitForTimeout(800);
      await expect(card).toHaveCount(0);
      await expect(trayPeek(page)).toContainText("Empty");
      // After the scripted absence the card is suggested again.
      await expect(card).toBeVisible({ timeout: 20_000 });
    });

    test("a search after None of these takes the explicit finish the collector chooses", async ({
      page,
    }) => {
      await signInFresh(page);
      const ids = await printingIds(page);
      await installScript(page, {
        frames: imageOnly([ids["Bulbasaur"], ids["Rare Candy"], ids["Switch"]]),
      });
      await openScanner(page);
      await suggestionCard(page)
        .getByRole("button", { name: "None of these" })
        .click();
      const search = page.getByRole("dialog", { name: "Find this card" });
      await search
        .getByRole("searchbox", { name: "Search the catalog" })
        .fill("Bulbasaur");
      await search
        .getByRole("button", { name: /Bulbasaur.*Reverse Holo/ })
        .first()
        .click();
      await expect(search).toBeHidden();
      await expect(trayPeek(page)).toContainText("Bulbasaur");
      await reviewTray(page);
      await expect(
        trayOpen(page)
          .getByRole("group", { name: "Finish of Bulbasaur" })
          .getByRole("button", { name: "Reverse Holo" })
      ).toHaveAttribute("aria-pressed", "true");
    });

    test("taking the card out with the suggestion open skips it", async ({
      page,
    }) => {
      await signInFresh(page);
      const ids = await printingIds(page);
      const ranking = [ids["Bulbasaur"], ids["Rare Candy"], ids["Switch"]];
      await installScript(page, {
        frames: [
          ...imageOnly(ranking, 100),
          ...empty(30),
          ...imageOnly(ranking, 4),
        ],
        walkAway: true,
      });
      await openScanner(page);
      const card = suggestionCard(page);
      await expect(card).toBeVisible();
      await expect(shutter(page)).toBeDisabled();
      // The card leaves: the suggestion closes, nothing is added, and the shutter is back.
      await expect(card).toBeHidden({ timeout: 15_000 });
      await expect(shutter(page)).toBeEnabled();
      await expect(trayPeek(page)).toContainText("Empty");
      // The worker was answered: the same card placed again is suggested again.
      await expect(card).toBeVisible({ timeout: 15_000 });
      await expect(trayPeek(page)).toContainText("Empty");
    });

    test("a number-backed match of a one-finish card adds a row with no question", async ({
      page,
    }) => {
      await signInFresh(page);
      const ids = await printingIds(page);
      await installScript(page, { frames: holding(ids["Switch"]) });
      await openScanner(page);
      await expect(trayPeek(page)).toContainText("Switch");
      await expect(trayPeek(page)).toContainText("×1");
      await expect(suggestionCard(page)).toHaveCount(0);
      await expect(shutter(page)).toBeEnabled();
    });

    test("a run with no card adds nothing and shows no suggestion", async ({
      page,
    }) => {
      await signInFresh(page);
      await installScript(page, { frames: empty(1) });
      await openScanner(page);
      await expect(trayPeek(page)).toContainText("Empty");
      // flake-exempt wait-for-timeout (quiet): nothing on the page marks a suggestion that must not come
      await page.waitForTimeout(1000);
      await expect(suggestionCard(page)).toHaveCount(0);
      await expect(trayPeek(page)).toContainText("Empty");
      await expect(hintPill(page)).toHaveText("");
    });

    test("outside a suggestion the shutter adds an image-only match as a row", async ({
      page,
    }) => {
      await signInFresh(page);
      const ids = await printingIds(page);
      // Not eligible (no corners, no number), so no suggestion comes; the collector's shutter takes the top candidate.
      await installScript(page, {
        frames: [{ top: [ids["Bulbasaur"], ids["Switch"]], eligible: false }],
      });
      await openScanner(page);
      await expect(shutter(page)).toBeEnabled();
      await shutter(page).click();
      // The top candidate has two finishes, so the shutter asks which (not "Is it one of these?").
      await expect(suggestionCard(page)).toHaveCount(0);
      await expect(choiceCard(page)).toContainText("Bulbasaur");
      await pickFinish(page, "Normal");
      await expect(trayPeek(page)).toContainText("Bulbasaur");
    });

    test("when none of the candidates can be added, it says so as a lock does", async ({
      page,
    }) => {
      await signInFresh(page);
      const ids = await printingIds(page);
      await page.route("**/api/scanner/printings", (route) =>
        route.fulfill({
          json: {
            catalog_revision: 1,
            printings: [],
            missing: [ids["Switch"]],
          },
        })
      );
      await installScript(page, { frames: imageOnly([ids["Switch"]]) });
      await openScanner(page);
      await expect(hintPill(page)).toHaveText(
        "Couldn't add this card. Tap the shutter to search."
      );
      await expect(suggestionCard(page)).toHaveCount(0);
      await expect(trayPeek(page)).toContainText("Empty");
    });

    test("when the printings cannot be reached it shows the offline hint and no suggestion", async ({
      page,
    }) => {
      await signInFresh(page);
      const ids = await printingIds(page);
      await page.route("**/api/scanner/printings", (route) => route.abort());
      await installScript(page, { frames: imageOnly([ids["Switch"]]) });
      await openScanner(page);
      await expect(hintPill(page)).toHaveText(
        "Can't reach PrizeCheck. Check your connection and scan again."
      );
      await expect(suggestionCard(page)).toHaveCount(0);
      await expect(trayPeek(page)).toContainText("Empty");
      await expectPageChecks(page, `${size.name} scanner, offline hint`);
    });
  });
}
