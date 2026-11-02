// #399: no browser scroll bar takes width on desktop; the app draws an overlay bar for the page instead.
// Signed out, the sign-in page is enough: the page's own scroller is what is under test.
import { test, expect, type Page } from "@playwright/test";
import { sandboxedLaunchOptions } from "./support/launch-options";

const ORIGIN = process.env.TEST_ORIGIN || "http://localhost:5173";
const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 800 };

const RAIL = "[data-overlay-scrollbar='page']";

// Playwright's Chromium hides scroll bars by default (--hide-scrollbars), which would make the width checks pass
// whatever the CSS does. Keep the browser's real ones.
test.use({
  launchOptions: sandboxedLaunchOptions({
    ignoreDefaultArgs: ["--hide-scrollbars"],
  }),
});

/** The width the layout has: the viewport minus any scroll bar the browser draws. */
function layoutWidth(page: Page) {
  return page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    inner: window.innerWidth,
    scrollbarWidth: getComputedStyle(document.documentElement).scrollbarWidth,
  }));
}

function addFiller(page: Page, height: number) {
  return page.evaluate((px) => {
    const filler = document.createElement("div");
    filler.id = "scrollbar-filler";
    filler.style.height = `${px}px`;
    document.body.append(filler);
  }, height);
}

test.describe("the page scroll bar", () => {
  test("never takes width from the content, scrolling or not", async ({
    page,
  }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto(`${ORIGIN}/collection`);
    await expect(page.locator("#first-paint")).toHaveCount(0);
    const short = await layoutWidth(page);
    expect(short.scrollbarWidth).toBe("none");
    expect(short.client).toBe(short.inner);
    await expect(page.locator(RAIL)).toBeHidden();

    await addFiller(page, 6000);
    const long = await layoutWidth(page);
    expect(long.client).toBe(long.inner);
    expect(long.client).toBe(short.client);
  });

  test("never takes width in a narrow desktop window either", async ({
    page,
  }) => {
    await page.setViewportSize(PHONE);
    await page.goto(`${ORIGIN}/collection`);
    await addFiller(page, 6000);
    const narrow = await layoutWidth(page);
    expect(narrow.scrollbarWidth).toBe("none");
    expect(narrow.client).toBe(narrow.inner);
  });

  test("shows a rail only while the page can scroll, and dragging it scrolls the page", async ({
    page,
  }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto(`${ORIGIN}/collection`);
    await expect(page.locator(RAIL)).toBeHidden();
    await addFiller(page, 6000);
    const rail = page.locator(RAIL);
    await expect(rail).toBeVisible();
    await expect(rail).toHaveAttribute("aria-hidden", "true");
    const thumb = rail.locator("div");
    const box = (await thumb.boundingBox())!;
    expect(box.height).toBeGreaterThan(20);
    expect(box.height).toBeLessThan(DESKTOP.height);

    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 60, {
      steps: 4,
    });
    await page.mouse.up();
    await expect
      .poll(() => page.evaluate(() => window.scrollY))
      .toBeGreaterThan(100);
    // The thumb followed the page.
    await expect
      .poll(async () => (await thumb.boundingBox())!.y)
      .toBeGreaterThan(box.y + 30);

    // The page still scrolls by keyboard, and the rail goes when the content shrinks.
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.keyboard.press("End");
    await expect
      .poll(() => page.evaluate(() => window.scrollY))
      .toBeGreaterThan(1000);
    await page.evaluate(() =>
      document.getElementById("scrollbar-filler")?.remove()
    );
    await expect(rail).toBeHidden();
  });

  test("the rail takes no clicks, and the thumb fades out when idle", async ({
    page,
  }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto(`${ORIGIN}/collection`);
    await addFiller(page, 6000);
    const rail = page.locator(RAIL);
    await expect(rail).toBeVisible();
    await expect(rail).toHaveCSS("pointer-events", "none");
    await expect(rail.locator("div")).toHaveCSS("pointer-events", "auto");
    // Idle: no scroll, no hover on the region. The thumb is transparent.
    await page.mouse.move(10, 400);
    await expect(rail.locator("div")).toHaveCSS("opacity", "0");
    await page.mouse.wheel(0, 300);
    await expect(rail.locator("div")).toHaveCSS("opacity", "1");
  });

  test("hides while a modal dialog is open", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto(`${ORIGIN}/collection`);
    await addFiller(page, 6000);
    const rail = page.locator(RAIL);
    await expect(rail).toBeVisible();
    await page.evaluate(() => {
      const dialog = document.createElement("dialog");
      dialog.id = "scrollbar-modal";
      dialog.textContent = "Modal";
      document.body.append(dialog);
      dialog.showModal();
    });
    await expect(rail).toBeHidden();
    await page.evaluate(() =>
      (document.getElementById("scrollbar-modal") as HTMLDialogElement).close()
    );
    await expect(rail).toBeVisible();
  });

  test("leaves a touch phone with the browser's own scrolling", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      hasTouch: true,
      viewport: PHONE,
    });
    try {
      const page = await context.newPage();
      await page.goto(`${ORIGIN}/collection`);
      await addFiller(page, 6000);
      await expect(page.locator(RAIL)).toHaveCount(0);
      expect((await layoutWidth(page)).scrollbarWidth).not.toBe("none");
    } finally {
      await context.close();
    }
  });
});
