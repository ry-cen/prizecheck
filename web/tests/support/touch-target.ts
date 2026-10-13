import { expect, type Locator } from "@playwright/test";

type Box = { x: number; y: number; width: number; height: number };

// Touch targets on a phone are at least 44 CSS px. A box measured from transformed layout carries floating-point
// error: a 44 px button inside a drawer that is still sliding in (every drawer and sheet enters with a translate,
// which never changes a size) measures 43.99998 px. Half a pixel is the allowance the accessibility audit's
// smallTargets also uses; a target a finger could notice is still a failure.
const TOUCH_TARGET = 44;
const ALLOWANCE = 0.5;

const same = (a: Box | null, b: Box | null) =>
  !!a &&
  !!b &&
  a.x === b.x &&
  a.y === b.y &&
  a.width === b.width &&
  a.height === b.height;

/** `locator`'s box once two measurements in a row agree, so an entering drawer or sheet has finished moving. */
export async function settledBox(locator: Locator): Promise<Box> {
  let previous = await locator.boundingBox();
  await expect
    .poll(
      async () => {
        const current = await locator.boundingBox();
        const settled = same(previous, current);
        previous = current;
        return settled;
      },
      { message: `${locator} to stop moving` }
    )
    .toBe(true);
  return previous!;
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
