// Issue #365: every panel size of the shared Dialog scrolls a body taller than the screen to its last row, with the
// frame inside the screen and the header's close button still in view: the left and right drawers, the wide panel
// (a centred panel on desktop, the whole screen on a phone) and the card panel (a centred panel on desktop, a bottom
// sheet on a phone). The centred panel and its phone bottom sheet are in panel-scroll.spec.ts and deck-editing.spec.ts.
// Each test opens the real panel and appends 3000 px of filler and a last row to its body, so no data is needed.
import { test, expect, type Locator, type Page } from "@playwright/test";
import { Pool } from "pg";
import { signInAsOwner } from "./support/sign-in";
import { startAsNewOwner } from "./support/owner";

async function signIn(page: Page, next: string) {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await startAsNewOwner(pool);
    await pool.query("DELETE FROM auth_send_event");
  } finally {
    await pool.end();
  }
  await signInAsOwner(page, next);
}

/** Fills the open panel's body with 3000 px and a last row, then scrolls it to the last row by wheel. */
async function expectBodyScrolls(page: Page, panel: Locator, close: string) {
  await expect(panel).toBeVisible();
  const body = panel.locator("div.overflow-auto").first();
  await body.evaluate((element) => {
    const spacer = document.createElement("div");
    spacer.style.height = "3000px";
    const last = document.createElement("p");
    last.textContent = "Last audit row";
    last.dataset.auditLast = "";
    element.append(spacer, last);
  });
  const viewport = page.viewportSize()!;
  const frame = (await panel.boundingBox())!;
  expect(frame.y).toBeGreaterThanOrEqual(0);
  expect(frame.y + frame.height).toBeLessThanOrEqual(viewport.height);
  expect(frame.x).toBeGreaterThanOrEqual(0);
  expect(frame.x + frame.width).toBeLessThanOrEqual(viewport.width);
  await expect
    .poll(() =>
      body.evaluate((element) => element.scrollHeight > element.clientHeight)
    )
    .toBe(true);
  await body.hover();
  // A panel that is still loading can swallow the first wheel, so wheel again until the body is at its end.
  await expect
    .poll(async () => {
      await page.mouse.wheel(0, 100_000);
      return body.evaluate(
        (element) =>
          element.scrollTop + element.clientHeight >= element.scrollHeight - 1
      );
    })
    .toBe(true);
  const last = panel.locator("[data-audit-last]");
  await expect(last).toBeInViewport({ ratio: 1 });
  await expect(panel.getByRole("button", { name: close })).toBeInViewport({
    ratio: 1,
  });
}

const SIZES = [
  { name: "desktop", viewport: { width: 1280, height: 800 }, touch: false },
  { name: "phone", viewport: { width: 375, height: 812 }, touch: true },
] as const;

for (const size of SIZES) {
  test.describe(size.name, () => {
    test.use({ viewport: size.viewport, hasTouch: size.touch });

    test("the right drawer (Filters & display) scrolls to its last row", async ({
      page,
    }) => {
      // Desktop draws the filters inline; only a phone opens them in the drawer.
      test.skip(!size.touch, "the filters are inline on a desktop screen");
      await signIn(page, "/collection");
      await page.getByRole("button", { name: /^Filters & display/ }).click();
      await expectBodyScrolls(
        page,
        page.getByRole("dialog", { name: /Filters & display/ }),
        "Close filters & display"
      );
    });

    test("the right drawer (Friends) scrolls to its last row", async ({
      page,
    }) => {
      await signIn(page, "/collection");
      await page.getByRole("button", { name: "Friends", exact: true }).click();
      await expect(page.getByText("Loading…")).toBeHidden();
      await expectBodyScrolls(
        page,
        page.getByRole("dialog", { name: "Friends" }),
        "Close"
      );
    });

    test("the wide panel (Manage locations) scrolls to its last row", async ({
      page,
    }) => {
      await signIn(page, "/collection");
      if (size.touch)
        await page.getByRole("button", { name: "Open locations" }).tap();
      await page
        .getByRole("button", { name: "Manage locations", exact: true })
        .click();
      await expectBodyScrolls(
        page,
        page.getByRole("dialog", { name: "Manage locations", exact: true }),
        "Close manage locations"
      );
    });

    test("the card panel (Make a new Invite Link?) scrolls to its last row", async ({
      page,
    }) => {
      await signIn(page, "/settings");
      await page
        .getByRole("region", { name: "Privacy" })
        .getByRole("button", { name: "Make a new link" })
        .click();
      await expectBodyScrolls(
        page,
        page.getByRole("dialog", { name: "Make a new Invite Link?" }),
        "Close"
      );
    });
  });
}

test.describe("phone", () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true });

  test("the left drawer (Locations) scrolls to its last row", async ({
    page,
  }) => {
    await signIn(page, "/collection");
    await page.getByRole("button", { name: "Open locations" }).tap();
    await expectBodyScrolls(
      page,
      page.getByRole("dialog", { name: "Locations", exact: true }),
      "Close locations"
    );
  });
});
