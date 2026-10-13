import { expect, type Locator } from "@playwright/test";
import { animationsFinished } from "./motion";

type Box = { x: number; y: number; width: number; height: number };

// Touch targets on a phone are at least 44 CSS px. A 44 px button inside a drawer that was still sliding in (every
// drawer and sheet enters with a translate, which never changes a size) measured 43.99998 px, so targets are measured
// once entry animations finish. A box measured from transformed or fractional layout can still carry floating-point
// error, so half a pixel is allowed, as the accessibility audit's smallTargets also does; a target a finger could
// notice is still a failure.
const TOUCH_TARGET = 44;
const ALLOWANCE = 0.5;

/** `locator`'s box once it is visible and every entry animation has finished, so a drawer or sheet has stopped moving. */
export async function settledBox(locator: Locator): Promise<Box> {
  await expect(locator).toBeVisible();
  await animationsFinished(locator.page());
  const box = await locator.boundingBox();
  expect(box, `${locator} has a box`).not.toBeNull();
  return box!;
}

/** Asserts `locator` is a 44 px touch target in `dimensions` once it has settled, and returns that settled box. */
export async function expectTouchTarget(
  locator: Locator,
  dimensions: ("width" | "height")[] = ["width", "height"]
): Promise<Box> {
  const box = await settledBox(locator);
  for (const dimension of dimensions)
    expect(box[dimension], `${dimension} of ${locator}`).toBeGreaterThanOrEqual(
      TOUCH_TARGET - ALLOWANCE
    );
  return box;
}
