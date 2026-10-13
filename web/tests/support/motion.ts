import type { Page } from "@playwright/test";

/**
 * Waits for every running finite CSS animation and transition to finish. Some drawers and sheets enter with a fade or
 * a slide that is still running once they are visible, so a measurement or an audit taken then sees a state no one
 * rests on. Infinite animations (a spinner) are left out; a paused finite one would hold the wait until the test's
 * timeout.
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
