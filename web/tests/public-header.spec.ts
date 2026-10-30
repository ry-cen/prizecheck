// The slim public header fits the page at every width down to 320 px (WCAG 1.4.10 Reflow), on the landing page and
// Discover: under 360 px its Discover decks link shows Discover and keeps Discover decks as its name, and the header
// is one 64 px row at the usual text size. It also fits with the page zoomed to 200% (a 1280 px window is 640 px wide)
// and with text alone enlarged to 200% at desktop and phone widths, where its links wrap onto a second row. The page's
// overlay scroll bar always starts at the header's bottom edge, and a control focused by Tab is never hidden behind
// the header: it shows whole below it.
import { test, expect, type Page } from "@playwright/test";
import { expectPageChecks } from "./support/page-check";

const ORIGIN = process.env.TEST_ORIGIN || "http://localhost:5173";

const banner = (page: Page) => page.getByRole("banner");

/** Enlarges every element's text to `factor` times its size, as a browser's text-only zoom does. */
async function enlargeText(page: Page, factor: number) {
  await page.evaluate((factor) => {
    const all = Array.from(document.querySelectorAll<HTMLElement>("body *"));
    const sizes = all.map((el) => parseFloat(getComputedStyle(el).fontSize));
    all.forEach((el, i) =>
      el.style.setProperty("font-size", `${sizes[i] * factor}px`, "important")
    );
  }, factor);
}

/** Both header links lie wholly inside the viewport, and the Discover link keeps its full name. */
async function expectHeaderInView(page: Page, width: number) {
  const discover = banner(page).getByRole("link", {
    name: "Discover decks",
    exact: true,
  });
  const signIn = banner(page).getByRole("link", {
    name: "Sign in",
    exact: true,
  });
  for (const link of [discover, signIn]) {
    const box = (await link.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
  }
  await expect(discover).toHaveText("Discover decks");
}

/**
 * The page's overlay scroll bar (a mouse or trackpad screen draws one; headless Chromium does) is drawn exactly when the
 * page scrolls (useOverlayScrollbar sets the rail's `hidden` otherwise), and then starts at the header's bottom edge.
 */
async function expectRailBelowHeader(page: Page) {
  const bottom = (await banner(page).boundingBox())!.height;
  const rail = page.locator('[data-overlay-scrollbar="page"]');
  if ((await rail.count()) === 0) return;
  const scrolls = await page.evaluate(
    () =>
      document.documentElement.scrollHeight >
      document.documentElement.clientHeight
  );
  if (!scrolls) {
    await expect(rail).toBeHidden();
    return;
  }
  await expect(rail).toBeVisible();
  await expect
    .poll(async () => Math.round((await rail.boundingBox())!.y))
    .toBe(Math.round(bottom));
}

test.describe("public header", () => {
  for (const path of ["/", "/discover"])
    for (const [width, height] of [
      [320, 568],
      [359, 700],
      [375, 812],
      [640, 400],
      [1280, 800],
    ] as const)
      test(`${path} at ${width} px keeps the header inside the page`, async ({
        page,
      }, testInfo) => {
        await page.setViewportSize({ width, height });
        await page.goto(`${ORIGIN}${path}`);
        await expect(banner(page)).toBeVisible();
        await expectHeaderInView(page, width);
        // One 64 px row at the usual text size.
        expect((await banner(page).boundingBox())!.height).toBe(64);
        await expectRailBelowHeader(page);
        await expectPageChecks(page, `${path} at ${width} px`);
        if (path === "/")
          await page.screenshot({
            path: testInfo.outputPath(`header-${width}.png`),
          });
      });

  test("from 360 px the Discover decks link shows its whole name on one line", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 360, height: 700 });
    await page.goto(`${ORIGIN}/`);
    const discover = banner(page).getByRole("link", {
      name: "Discover decks",
      exact: true,
    });
    await expect(discover).toHaveJSProperty("innerText", "Discover decks");
  });

  // At 375 and 320 px the three header items can't share one row at 200% text: the links wrap onto a second row.
  for (const [width, height] of [
    [1280, 800],
    [640, 400],
    [375, 812],
    [320, 568],
  ] as const)
    test(`text enlarged to 200% at ${width} px keeps the header and the landing page inside the page`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height });
      await page.goto(`${ORIGIN}/`);
      await expect(banner(page)).toBeVisible();
      await enlargeText(page, 2);
      await expectHeaderInView(page, width);
      await expectRailBelowHeader(page);
      await expectPageChecks(page, `text at 200% at ${width} px`);
      await page.screenshot({
        path: testInfo.outputPath(`header-text-200-${width}.png`),
      });
    });

  for (const [width, height] of [
    [375, 812],
    [320, 568],
  ] as const)
    test(`with text at 200% at ${width} px, every control focused by Tab or Shift+Tab shows below the header`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height });
      await page.goto(`${ORIGIN}/`);
      await expect(banner(page)).toBeVisible();
      await enlargeText(page, 2);
      // Forward to the last control, then back to the first: going back scrolls each one up to the header's edge.
      const stops = await page.evaluate(
        () =>
          document.querySelectorAll("a[href], button:not([disabled])").length
      );
      for (const key of ["Tab", "Shift+Tab"])
        for (let i = 0; i < stops; i++) {
          await page.keyboard.press(key);
          const problem = await page.evaluate(() => {
            const focused = document.activeElement as HTMLElement | null;
            const header = document.querySelector("header")!;
            if (!focused || focused === document.body) return null;
            if (header.contains(focused)) return null;
            const box = focused.getBoundingClientRect();
            const edge = header.getBoundingClientRect().bottom;
            const shown =
              box.top >= edge - 0.5 && box.bottom <= window.innerHeight + 0.5;
            return shown
              ? null
              : `${focused.textContent?.trim().slice(0, 30)}: ${Math.round(box.top)}-${Math.round(box.bottom)}, header ends at ${Math.round(edge)}`;
          });
          expect(problem, `${key} focus at ${width} px`).toBeNull();
        }
      await page.screenshot({
        path: testInfo.outputPath(`header-focus-200-${width}.png`),
      });
    });
});
