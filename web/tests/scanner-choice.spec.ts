import { test } from "./support/art-upstream";
// The Scan Choice: a recognized card that has look-alike Printings or more than one active Edition asks which version
// and finish before it is added; one with a single Edition and no look-alikes is added directly. One tap on a finish
// adds one copy to the row of that Printing and Edition (or starts a row); the scanner never preselects a finish. A card
// taken away with the prompt open is skipped and must leave the guide before the next lock; a chip change that matches
// another row merges the two. Driven by the stub recognizer. Every state runs the shared page check at 1280×800 and
// 375×812.
import { expect } from "@playwright/test";
import { expectPageChecks } from "./support/page-check";
import { expectTouchTarget } from "./support/touch-target";
import {
  choiceCard,
  empty,
  holding,
  installScript,
  openScanner,
  pickFinish,
  placements,
  printingIds,
  retireBulbasaurNormal,
  reviewTray,
  seedPopup,
  signInFresh,
  trayOpen,
  trayPeek,
} from "./support/scanner";

const SIZES = [
  { name: "desktop", viewport: { width: 1280, height: 800 }, phone: false },
  { name: "phone", viewport: { width: 375, height: 812 }, phone: true },
] as const;

for (const size of SIZES) {
  test.describe(size.name, () => {
    test.use({ viewport: size.viewport, hasTouch: size.phone });
    test.beforeEach(() => seedPopup());

    test("a number-backed card with two finishes opens the finish prompt; a Reverse Holo tap adds a row with Reverse Holo selected", async ({
      page,
    }) => {
      await signInFresh(page);
      const ids = await printingIds(page);
      await installScript(page, { frames: holding(ids["Bulbasaur"]) });
      await openScanner(page);

      const card = choiceCard(page);
      await expect(card.getByRole("heading")).toHaveText("Which finish?");
      await expect(card).toContainText("Bulbasaur");
      await expect(card.getByRole("listitem")).toHaveCount(1);
      const chips = card.getByRole("group", { name: "Finish of Bulbasaur" });
      await expect(chips.getByRole("button")).toHaveText([
        "Normal",
        "Reverse Holo",
      ]);
      // Nothing is selected for the collector, and no scores, sources or prices show.
      await expect(chips.getByRole("button", { pressed: true })).toHaveCount(0);
      await expect(card).not.toContainText(/\$|%|score/i);
      await expect(
        card.getByRole("button", { name: "None of these" })
      ).toBeVisible();
      await expect(chips.getByRole("button").first()).toBeFocused();
      await expect(
        page.getByRole("button", { name: "Scan this card", exact: true })
      ).toBeDisabled();
      await expect(trayPeek(page)).toContainText("Empty");
      if (size.phone)
        await expectTouchTarget(
          chips.getByRole("button", { name: "Reverse Holo" })
        );
      await expectPageChecks(page, `${size.name} scanner, finish prompt`);

      await pickFinish(page, "Reverse Holo");
      await expect(card).toBeHidden();
      await expect(trayPeek(page)).toContainText("Bulbasaur");
      await expect(trayPeek(page)).toContainText("×1");
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

    test("scanning it again and tapping Normal makes a second row; a third scan with Reverse Holo counts ×2 on the first", async ({
      page,
    }) => {
      await signInFresh(page);
      const ids = await printingIds(page);
      const b = ids["Bulbasaur"];
      await installScript(page, { frames: placements(b, b, b) });
      await openScanner(page);
      await pickFinish(page, "Reverse Holo");
      await expect(trayPeek(page)).toContainText("×1");
      await pickFinish(page, "Normal");
      await expect(trayPeek(page)).toContainText("2 cards");
      await pickFinish(page, "Reverse Holo");
      await expect(trayPeek(page)).toContainText("3 cards");
      await reviewTray(page);
      const rows = trayOpen(page).getByRole("listitem");
      await expect(rows).toHaveCount(2);
      // Newest first: the Normal row on top with one copy, the Reverse Holo row below with two.
      await expect(
        rows.nth(0).getByRole("button", { name: "Normal", exact: true })
      ).toHaveAttribute("aria-pressed", "true");
      await expect(
        rows.nth(0).getByRole("group", { name: "Copies of Bulbasaur" })
      ).toContainText("1");
      await expect(
        rows.nth(1).getByRole("button", { name: "Reverse Holo", exact: true })
      ).toHaveAttribute("aria-pressed", "true");
      await expect(
        rows.nth(1).getByRole("group", { name: "Copies of Bulbasaur" })
      ).toContainText("2");
    });

    test("a card with one finish is added with no prompt", async ({ page }) => {
      await signInFresh(page);
      await retireBulbasaurNormal();
      const ids = await printingIds(page);
      await installScript(page, { frames: holding(ids["Bulbasaur"]) });
      await openScanner(page);
      await expect(trayPeek(page)).toContainText("Bulbasaur");
      await expect(trayPeek(page)).toContainText("×1");
      await expect(choiceCard(page)).toHaveCount(0);
    });

    test("look-alikes open the version prompt: each version shows its finish chips, one tap adds", async ({
      page,
    }) => {
      await signInFresh(page);
      const ids = await printingIds(page);
      const b = ids["Bulbasaur"];
      const alike = ids["Rare Candy"];
      // The number reads both cards, so the look-alike survives the number check.
      await installScript(page, {
        frames: Array.from({ length: 4 }, () => ({
          top: [b],
          ocr: [b, alike],
        })),
        lookalikes: { [b]: [alike] },
      });
      await openScanner(page);

      const card = choiceCard(page);
      await expect(card.getByRole("heading")).toHaveText("Which version?");
      const versions = card.getByRole("listitem");
      await expect(versions).toHaveCount(2);
      await expect(versions.nth(0)).toContainText("Bulbasaur");
      await expect(
        versions.nth(0).getByRole("group", { name: "Finish of Bulbasaur" })
      ).toBeVisible();
      // The single-finish version is one button that names its finish after the set and number.
      await expect(versions.nth(1)).toContainText("Rare Candy");
      await expect(versions.nth(1).getByRole("button")).toHaveCount(1);
      await expect(versions.nth(1).getByRole("button")).toContainText(
        /Mega Evolution 125 · (Normal|Holo|Reverse Holo)/
      );
      await expectPageChecks(page, `${size.name} scanner, version prompt`);

      await pickFinish(page, "Normal", "Bulbasaur");
      await expect(card).toBeHidden();
      await expect(trayPeek(page)).toContainText("Bulbasaur");
      await expect(trayPeek(page)).toContainText("×1");
    });

    test("a card taken away with the prompt open is skipped and must leave before the next lock", async ({
      page,
    }) => {
      await signInFresh(page);
      const ids = await printingIds(page);
      const b = ids["Bulbasaur"];
      await installScript(page, {
        frames: [...holding(b, 100), ...empty(30), ...holding(b, 4)],
        walkAway: true,
      });
      await openScanner(page);
      const card = choiceCard(page);
      await expect(card).toBeVisible();
      await expect(card).toBeHidden({ timeout: 15_000 });
      await expect(trayPeek(page)).toContainText("Empty");
      // The worker was answered: the card placed again asks again.
      await expect(card).toBeVisible({ timeout: 15_000 });
      await expect(trayPeek(page)).toContainText("Empty");
    });

    test("changing a row's chip to a finish another row has merges the two rows", async ({
      page,
    }) => {
      await signInFresh(page);
      const ids = await printingIds(page);
      const b = ids["Bulbasaur"];
      await installScript(page, { frames: placements(b, b, b) });
      await openScanner(page);
      await pickFinish(page, "Reverse Holo");
      await pickFinish(page, "Normal");
      await pickFinish(page, "Normal");
      await expect(trayPeek(page)).toContainText("3 cards");
      await reviewTray(page);
      const rows = trayOpen(page).getByRole("listitem");
      // One Normal row with two copies on top of the Reverse Holo row with one.
      await expect(rows).toHaveCount(2);
      await rows
        .nth(1)
        .getByRole("button", { name: "Normal", exact: true })
        .click();
      await expect(rows).toHaveCount(1);
      await expect(
        rows.nth(0).getByRole("button", { name: "Normal", exact: true })
      ).toHaveAttribute("aria-pressed", "true");
      await expect(
        rows.nth(0).getByRole("group", { name: "Copies of Bulbasaur" })
      ).toContainText("3");
    });
  });
}
