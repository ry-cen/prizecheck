import type { Page } from "@playwright/test";

/**
 * Waits for every running finite animation to finish. Dialogs, drawers and sheets enter with a fade or a slide that is
 * still running once they are visible, so a measurement or an audit taken then sees a state no one rests on.
 * Infinite animations (a spinner) are left out so the wait always ends.
 */
export async function animationsFinished(page: Page) {
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter(
          (animation) =>
            animation.effect?.getComputedTiming().iterations !== Infinity
        )
        .map((animation) => animation.finished.catch(() => undefined))
    )
  );
}
