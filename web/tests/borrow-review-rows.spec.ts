import type { Locator } from "@playwright/test";
import { expect, test } from "./support/collectors";
import {
  seedCatalog,
  nameCollector,
  hold,
  unsorted,
  befriend,
} from "./support/loans";
import { signInAsOwner } from "./support/sign-in";
import { expectTouchTarget } from "./support/touch-target";

// A Friend who holds two finishes of one card (Boss's Orders PAL 172, Normal and Reverse Holo) gets one row each in the
// card popup's "Friends who have this". Asking for the finishes puts both in the same draft to that Friend, which has
// one Review: it sits on one row that is in the draft, never on a row that isn't, and never twice.
const REVIEW = "Review Borrow Request to Misty W";
const ASK_NORMAL = "Ask to borrow Boss's Orders from Misty W (PAL 172)";
const ASK_REVERSE =
  "Ask to borrow Boss's Orders from Misty W (PAL 172, Reverse Holo)";
const STEPPER_NORMAL = "Copies of Boss's Orders to ask Misty W for (PAL 172)";
const STEPPER_REVERSE =
  "Copies of Boss's Orders to ask Misty W for (PAL 172, Reverse Holo)";

const rowsOf = (popup: Locator) =>
  popup
    .getByRole("list", { name: "Friends who have this" })
    .getByRole("listitem");
// The popup shows the Normal Edition, so only the other finish's row carries a "Reverse Holo" pill.
const normalRow = (popup: Locator) =>
  rowsOf(popup).filter({ hasNotText: "Reverse Holo" });
const reverseRow = (popup: Locator) =>
  rowsOf(popup).filter({ hasText: "Reverse Holo" });

/** Nothing in the popup sticks out sideways, and the page doesn't scroll sideways. */
async function expectNoHorizontalOverflow(popup: Locator) {
  const overflow = await popup.evaluate((dialog) => {
    const own = dialog.getBoundingClientRect();
    const sticking = Array.from(dialog.querySelectorAll("*")).filter((el) => {
      const box = el.getBoundingClientRect();
      return (
        box.width > 0 && (box.left < own.left - 1 || box.right > own.right + 1)
      );
    });
    return {
      dialog: dialog.scrollWidth - dialog.clientWidth,
      page:
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
      sticking: sticking.map((el) => el.outerHTML.slice(0, 80)),
    };
  });
  expect(overflow).toEqual({ dialog: 0, page: 0, sticking: [] });
}

for (const viewport of [
  { width: 1280, height: 800 },
  { width: 375, height: 812 },
]) {
  const phone = viewport.width < 600;
  test(`Asking for two finishes from one Friend shows one Review, beside the row's stepper, at ${viewport.width}`, async ({
    page,
    collectors,
  }) => {
    await page.setViewportSize(viewport);
    const ids = seedCatalog();
    const friend = await collectors.signIn({ next: "/loans" });
    await nameCollector(friend.page, "Misty W");
    const place = await unsorted(friend.page);
    await hold(friend.page, place, ids["PAL 172"], 3);
    await hold(friend.page, place, ids["PAL 172 Reverse Holo"], 2);
    await signInAsOwner(page, "/catalog");
    await befriend(page, friend.page);

    await page
      .getByRole("region", { name: "Catalog results" })
      .getByRole("button", { name: /^Boss's Orders, PAL 172, .*Normal,/ })
      .click();
    const popup = page.getByRole("dialog");
    await expect(rowsOf(popup)).toHaveCount(2);
    const review = popup.getByRole("button", { name: REVIEW });

    // Nothing is drafted yet: no Review, and both rows ask.
    await expect(review).toHaveCount(0);
    await expect(
      normalRow(popup).getByRole("button", { name: ASK_NORMAL })
    ).toBeVisible();
    await expect(
      reverseRow(popup).getByRole("button", { name: ASK_REVERSE })
    ).toBeVisible();

    // Asking for the Normal finish: Review comes on that row; the Reverse Holo row still asks and has no Review.
    await popup.getByRole("button", { name: ASK_NORMAL }).click();
    await expect(review).toHaveCount(1);
    await expect(
      normalRow(popup).getByRole("group", { name: STEPPER_NORMAL })
    ).toBeVisible();
    await expect(
      normalRow(popup).getByRole("button", { name: REVIEW })
    ).toHaveCount(1);
    await expect(
      reverseRow(popup).getByRole("button", { name: REVIEW })
    ).toHaveCount(0);
    await expect(
      reverseRow(popup).getByRole("button", { name: ASK_REVERSE })
    ).toBeVisible();

    // Both finishes drafted: still exactly one Review in the popup.
    await popup.getByRole("button", { name: ASK_REVERSE }).click();
    await expect(
      reverseRow(popup).getByRole("group", { name: STEPPER_REVERSE })
    ).toBeVisible();
    await expect(review).toHaveCount(1);
    // The drafts tray behind the popup has its own single Review for the Friend.
    await expect(
      page
        .getByRole("region", { name: "Borrow Request drafts" })
        .getByRole("button", { name: REVIEW })
    ).toHaveCount(1);

    // Each row keeps its own unique names.
    for (const name of [STEPPER_NORMAL, STEPPER_REVERSE])
      await expect(popup.getByRole("group", { name })).toHaveCount(1);

    // The Review stays on its row's line: level with the stepper, inside the row, and a full-size target on a phone.
    const row = normalRow(popup);
    const stepper = row.getByRole("group", { name: STEPPER_NORMAL });
    const rowBox = (await row.boundingBox())!;
    const stepperBox = (await stepper.boundingBox())!;
    const reviewBox = (await review.boundingBox())!;
    expect(Math.abs(reviewBox.y - stepperBox.y)).toBeLessThanOrEqual(1);
    expect(reviewBox.y).toBeGreaterThanOrEqual(rowBox.y - 1);
    expect(reviewBox.y + reviewBox.height).toBeLessThanOrEqual(
      rowBox.y + rowBox.height + 1
    );
    expect(reviewBox.x).toBeGreaterThan(stepperBox.x);
    if (phone) {
      await expectTouchTarget(review);
      for (const label of ["Decrease", "Increase"])
        await expectTouchTarget(
          stepper.getByRole("button", { name: new RegExp(`^${label} `) })
        );
    }
    await expectNoHorizontalOverflow(popup);

    // Taking the Normal finish out hands the one Review to the Reverse Holo row, which is still in the draft.
    await stepper
      .getByRole("button", { name: `Decrease ${STEPPER_NORMAL}` })
      .click();
    await expect(
      normalRow(popup).getByRole("button", { name: ASK_NORMAL })
    ).toBeVisible();
    await expect(review).toHaveCount(1);
    await expect(
      reverseRow(popup).getByRole("button", { name: REVIEW })
    ).toHaveCount(1);
    await expect(
      normalRow(popup).getByRole("button", { name: REVIEW })
    ).toHaveCount(0);
    await expectNoHorizontalOverflow(popup);

    // With the last finish out, the popup has no Review at all.
    await reverseRow(popup)
      .getByRole("button", { name: `Decrease ${STEPPER_REVERSE}` })
      .click();
    await expect(review).toHaveCount(0);
    await expect(
      popup.getByRole("button", { name: ASK_REVERSE })
    ).toBeVisible();

    // Review itself still opens the one composer for the Friend, with both lines when both are asked again.
    await popup.getByRole("button", { name: ASK_NORMAL }).click();
    await popup.getByRole("button", { name: ASK_REVERSE }).click();
    await expect(review).toHaveCount(1);
    await review.click();
    const composer = page.getByRole("dialog", {
      name: "Borrow Request to Misty W",
    });
    await expect(composer).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(1);
    await expect(
      composer
        .getByRole("list", { name: "Cards to borrow" })
        .getByRole("listitem")
    ).toHaveCount(2);
  });
}
