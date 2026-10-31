import { Pool } from "pg";
import { startAsNewOwner } from "./support/owner";
import type { Page, TestInfo } from "@playwright/test";
import { expect, test } from "./support/collectors";
import { hold, nameCollector, seedCatalog, unsorted } from "./support/loans";
import { signInAsOwner } from "./support/sign-in";

const ORIGIN = process.env.TEST_ORIGIN || "http://localhost:5173";
const SIZES = {
  "320x568": { width: 320, height: 568 },
  "375x667": { width: 375, height: 667 },
  "390x844": { width: 390, height: 844 },
  "landscape 667x375": { width: 667, height: 375 },
};

async function doubleText(page: Page) {
  await page.addStyleTag({
    content: `:root, :root * { ${[
      ["2xs", 10],
      ["xs", 11],
      ["sm", 12],
      ["control", 13],
      ["md", 14],
      ["lg", 18],
      ["xl", 24],
    ]
      .map(
        ([name, px]) => `--font-size-${name}: ${Number(px) * 2}px !important;`
      )
      .join(" ")} }`,
  });
}

type Geometry = {
  scrollY: number;
  scrollHeight: number;
  viewport: { width: number; height: number };
  header: { top: number; bottom: number; position: string } | null;
  search: { top: number; bottom: number; visible: boolean } | null;
  tabbar: { top: number; bottom: number } | null;
  stickyBlockers: string[];
};

/** Reads the phone header, its Search box and the tab bar, plus every ancestor of the header that would stop
 * position: sticky from working (overflow other than visible, a transform, contain or filter). */
function geometry(page: Page, headerSelector: string): Promise<Geometry> {
  return page.evaluate((selector) => {
    const header = document.querySelector<HTMLElement>(selector);
    const search = header?.querySelector<HTMLElement>(
      'input[type="search"], [role="searchbox"]'
    );
    // Two navs share the name: the desktop header's (hidden on a phone) and the phone tab bar. Take the rendered one.
    const tabbar =
      Array.from(
        document.querySelectorAll<HTMLElement>('nav[aria-label="Main views"]')
      ).find((nav) => nav.getBoundingClientRect().height > 0) ?? null;
    const box = (el: HTMLElement) => el.getBoundingClientRect();
    const stickyBlockers: string[] = [];
    for (let el = header?.parentElement; el; el = el.parentElement) {
      const s = getComputedStyle(el);
      const why = [
        s.overflowX !== "visible" || s.overflowY !== "visible"
          ? `overflow ${s.overflowX}/${s.overflowY}`
          : "",
        s.transform !== "none" ? `transform ${s.transform}` : "",
        s.contain !== "none" ? `contain ${s.contain}` : "",
        s.filter !== "none" ? `filter ${s.filter}` : "",
      ].filter(Boolean);
      if (why.length)
        stickyBlockers.push(`${el.tagName.toLowerCase()}: ${why.join(", ")}`);
    }
    const vh = document.documentElement.clientHeight;
    return {
      scrollY: window.scrollY,
      scrollHeight: document.documentElement.scrollHeight,
      viewport: { width: document.documentElement.clientWidth, height: vh },
      header: header
        ? {
            top: box(header).top,
            bottom: box(header).bottom,
            position: getComputedStyle(header).position,
          }
        : null,
      search: search
        ? {
            top: box(search).top,
            bottom: box(search).bottom,
            visible: box(search).bottom > 0 && box(search).top < vh,
          }
        : null,
      tabbar: tabbar
        ? { top: box(tabbar).top, bottom: box(tabbar).bottom }
        : null,
      stickyBlockers,
    };
  }, headerSelector);
}

async function record(
  page: Page,
  testInfo: TestInfo,
  scenario: string,
  data: unknown
) {
  const slug = scenario.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  await testInfo.attach(`${slug}.json`, {
    body: JSON.stringify({ scenario, data }, null, 2),
    contentType: "application/json",
  });
}

const PHONE_HEADER = "[data-collection-page] > header";

test("Collection's phone header while the gallery scrolls", async ({
  page,
}, testInfo) => {
  // A catalog import, 120 copies and many viewport sizes: well over 30 s on a loaded host.
  test.slow();
  const ids = seedCatalog();
  await page.route(/^https:\/\/assets\.tcgdex\.net\//, (route) =>
    route.abort()
  );
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await startAsNewOwner(pool);
  } finally {
    await pool.end();
  }
  await signInAsOwner(page, "/collection");
  await nameCollector(page, "Ash K");
  await hold(page, await unsorted(page), Object.values(ids)[0], 120);

  for (const [label, size] of Object.entries(SIZES)) {
    for (const big of [false, true]) {
      const scenario = `collection ${label}${big ? " text 200%" : ""}`;
      await page.setViewportSize(size);
      await page.goto(`${ORIGIN}/collection`);
      if (big) await doubleText(page);
      const header = page.locator(PHONE_HEADER);
      const search = header.getByRole("searchbox");
      // Readiness, as app-shell.spec.ts's signIn waits: Collection's own page (not the shell's stand-in) has mounted.
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(
        "All owned"
      );
      await expect(search).toBeVisible();
      // Make sure the page really scrolls before judging stickiness: it must be at least a screen and a half tall.
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              document.documentElement.scrollHeight >
              document.documentElement.clientHeight * 1.5
          )
        )
        .toBe(true);
      const top = await geometry(page, PHONE_HEADER);
      await page.evaluate(() =>
        window.scrollTo(0, document.documentElement.scrollHeight / 2)
      );
      await expect
        .poll(() => page.evaluate(() => window.scrollY))
        .toBeGreaterThan(0);
      const scrolled = await geometry(page, PHONE_HEADER);

      // Focus a tile deep in the gallery and check the fixed tab bar doesn't cover it.
      // The gallery is virtualized against the window's scroll (Gallery.tsx), so only tiles near the scroll position
      // are mounted: take the lowest mounted tile whose top is on screen, the one the tab bar is likeliest to cover.
      const TILES = 'section[aria-label="Cards"] button';
      const lowestOnScreen = () =>
        page.evaluate((selector) => {
          const vh = document.documentElement.clientHeight;
          const all = Array.from(
            document.querySelectorAll<HTMLElement>(selector)
          );
          let last = -1;
          all.forEach((b, i) => {
            const r = b.getBoundingClientRect();
            if (r.height > 0 && r.top >= 0 && r.top < vh) last = i;
          });
          return last;
        }, TILES);
      // The gallery mounts the rows for a new scroll position on its next frame, so wait for them.
      await expect
        .poll(lowestOnScreen, {
          message: `${scenario}: a mounted tile is on screen`,
        })
        .toBeGreaterThanOrEqual(0);
      const tileIndex = await lowestOnScreen();
      // Focusing may scroll and remount virtual rows: preserve the copy's identity rather than reusing
      // an nth locator whose element changes when the mounted window shifts.
      const tileName = await page
        .locator(TILES)
        .nth(tileIndex)
        .getAttribute("aria-label");
      if (!tileName) throw new Error("Mounted tile has no accessible name");
      const tile = page.getByRole("button", { name: tileName, exact: true });
      await tile.focus();
      await expect(tile).toBeFocused();
      const tileBox = await tile.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom };
      });
      const tabTop = (await geometry(page, PHONE_HEADER)).tabbar?.top ?? null;
      const obscuredTop = await collectionClearance(page);

      if (size.height > 480) {
        expect(scrolled.header?.top).toBeCloseTo(0, 0);
        await expect(header).toHaveCSS("--layout-sticky-top", "64px");
      }
      // Keyboard: from that tile, focus Search (as Shift+Tab back up the page would) and see where the page goes.
      if (size.height > 480) {
        await expect
          .poll(() => page.evaluate(() => window.scrollY))
          .toBeGreaterThan(0);
      }
      await search.focus();
      const afterFocus = await geometry(page, PHONE_HEADER);
      if (size.height > 480) expect(afterFocus.scrollY).toBeGreaterThan(0);

      if (size.height > 480) {
        for (const [open, close] of [
          ["Open locations", "Close locations"],
          ["Filters & display", "Close filters & display"],
        ]) {
          const opener = header.getByRole("button", {
            name: open,
            exact: true,
          });
          await opener.click();
          await page.getByRole("button", { name: close, exact: true }).click();
          await expect(opener).toBeFocused();
        }
      }
      await record(page, testInfo, scenario, {
        top,
        scrolled,
        focusedTile: { ...tileBox, tabbarTop: tabTop },
        afterSearchFocus: afterFocus,
      });
      expect
        .soft(
          size.height <= 480
            ? scrolled.header?.position === "static"
            : scrolled.search?.visible,
          `${scenario}: Search stays on screen while the gallery is scrolled (scrollY ${scrolled.scrollY}, header top ${scrolled.header?.top.toFixed(1)}, position ${scrolled.header?.position})`
        )
        .toBe(true);
      expect(tileBox.top).toBeGreaterThanOrEqual(obscuredTop - 0.5);
      if (tabTop !== null)
        expect
          .soft(
            tileBox.bottom <= tabTop + 0.5,
            `${scenario}: a focused tile (bottom ${tileBox.bottom.toFixed(1)}) clears the tab bar (top ${tabTop.toFixed(1)})`
          )
          .toBe(true);
      expect
        .soft(
          scrolled.stickyBlockers,
          `${scenario}: no ancestor of the header would break position: sticky`
        )
        .toEqual([]);
    }
  }

  // Control: the desktop shell header is sticky by design.
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${ORIGIN}/collection`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("All owned");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.documentElement.scrollHeight >
          document.documentElement.clientHeight * 1.5
      )
    )
    .toBe(true);
  await page.evaluate(() =>
    window.scrollTo(0, document.documentElement.scrollHeight / 2)
  );
  await expect
    .poll(() => page.evaluate(() => window.scrollY))
    .toBeGreaterThan(0);
  const desktop = await page.evaluate(() => {
    const h = document.querySelector("header");
    const r = h!.getBoundingClientRect();
    return {
      scrollY: window.scrollY,
      top: r.top,
      position: getComputedStyle(h!).position,
    };
  });
  await record(page, testInfo, "desktop shell header control", desktop);
  expect.soft(desktop.top, "desktop shell header stays at the top").toBe(0);
});

/** The opaque pinned controls that a focused gallery tile must clear, measured rather than assumed. */
function collectionClearance(page: Page) {
  return page.evaluate(() => {
    const header = document.querySelector<HTMLElement>(
      "[data-collection-page] > header"
    )!;
    const banner = document.querySelector<HTMLElement>(
      "[data-collection-stale-banner]"
    )!;
    return Math.max(
      0,
      getComputedStyle(header).position === "sticky"
        ? header.getBoundingClientRect().bottom
        : 0,
      banner.getBoundingClientRect().height > 0
        ? banner.getBoundingClientRect().bottom
        : 0
    );
  });
}

for (const scenario of [
  { name: "320 px", width: 320, height: 568, big: false },
  { name: "320 px with 200% text", width: 320, height: 568, big: true },
  { name: "short landscape", width: 667, height: 375, big: false },
]) {
  test(`stale Collection clearance follows the banner on ${scenario.name}`, async ({
    page,
  }) => {
    await page.setViewportSize({
      width: scenario.width,
      height: scenario.height,
    });
    const ids = seedCatalog();
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    try {
      await startAsNewOwner(pool);
    } finally {
      await pool.end();
    }
    await page.route(/^https:\/\/assets\.tcgdex\.net\//, (route) =>
      route.abort()
    );
    await signInAsOwner(page, "/collection");
    const location = await unsorted(page);
    const edition = Object.values(ids)[0];
    await hold(page, location, edition, 120);
    await page.reload();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "All owned"
    );
    const tiles = page.locator('section[aria-label="Cards"] button');
    await expect(tiles.first()).toBeVisible();
    if (scenario.big) await doubleText(page);
    await hold(page, location, edition, 1);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    const reload = page.getByRole("button", { name: "Reload", exact: true });
    await expect(reload).toBeVisible();
    const banner = page.locator("[data-collection-stale-banner]");
    const expectedHeader =
      scenario.height > 480
        ? await page
            .locator(PHONE_HEADER)
            .evaluate((el) => el.getBoundingClientRect().height)
        : 0;
    const expectPadding = async (withBanner: boolean) => {
      await expect
        .poll(() =>
          page.evaluate(
            ({ header, shown }) => {
              const height = document
                .querySelector<HTMLElement>("[data-collection-stale-banner]")!
                .getBoundingClientRect().height;
              return Math.abs(
                parseFloat(
                  getComputedStyle(document.documentElement).scrollPaddingTop
                ) -
                  header -
                  (shown ? height : 0)
              );
            },
            { header: expectedHeader, shown: withBanner }
          )
        )
        .toBeLessThan(0.5);
    };
    await expectPadding(true);
    await page.evaluate(() =>
      window.scrollTo(0, document.documentElement.scrollHeight / 2)
    );
    await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(0);
    await expect
      .poll(() => banner.evaluate((el) => el.getBoundingClientRect().top))
      .toBeCloseTo(expectedHeader, 0);
    if (scenario.height > 480) {
      await expect(page.locator(PHONE_HEADER)).toHaveCSS("position", "sticky");
      await expect
        .poll(() =>
          page
            .locator(PHONE_HEADER)
            .evaluate((el) => el.getBoundingClientRect().bottom)
        )
        .toBeCloseTo(expectedHeader, 0);
    } else {
      await expect(page.locator(PHONE_HEADER)).toHaveCSS("position", "static");
    }
    // Preserve a mounted copy's identity across window virtualization and focus scrolling.
    await expect
      .poll(() =>
        tiles.evaluateAll((all) =>
          all.some((el) => {
            const r = el.getBoundingClientRect();
            return r.top > 100 && r.top < innerHeight - 56;
          })
        )
      )
      .toBe(true);
    const name = await tiles.evaluateAll((all) =>
      all
        .find((el) => {
          const r = el.getBoundingClientRect();
          return r.top > 100 && r.top < innerHeight - 56;
        })!
        .getAttribute("aria-label")
    );
    if (!name) throw new Error("Visible copy has no accessible name");
    const tile = page.getByRole("button", { name, exact: true });
    const expectClear = async () => {
      await expect(tile).toBeFocused();
      await expect
        .poll(() =>
          tile.evaluate((el) => {
            const r = el.getBoundingClientRect();
            const b = document
              .querySelector<HTMLElement>("[data-collection-stale-banner]")!
              .getBoundingClientRect();
            const tabs = Array.from(
              document.querySelectorAll('nav[aria-label="Main views"]')
            )
              .find((nav) => nav.getBoundingClientRect().height > 0)!
              .getBoundingClientRect();
            const hit = document.elementFromPoint(
              r.left + r.width / 2,
              r.top + 1
            );
            return (
              r.top >= b.bottom - 0.5 &&
              r.bottom <= tabs.top + 0.5 &&
              !!hit &&
              el.contains(hit)
            );
          })
        )
        .toBe(true);
    };
    await tile.evaluate((el) => el.scrollIntoView({ block: "start" }));
    await tile.focus();
    await expectClear();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    await expectClear();
    // Start slightly behind the banner, then ask nearest scrolling to reveal the same focused copy.
    await page.evaluate(() => window.scrollBy(0, 12));
    await tile.evaluate((el) => el.scrollIntoView({ block: "nearest" }));
    await expectClear();
    if (!scenario.big && scenario.height > 480) {
      await doubleText(page); // ResizeObserver must also account for wrapping after the banner appears.
      await expectPadding(true);
    }
    // Kept pages must not leave their banner height on the document while another page is shown.
    const tabs = page.locator('nav[aria-label="Main views"]:visible');
    await tabs.getByRole("button", { name: "Catalog", exact: true }).click();
    await expect
      .poll(() =>
        page.evaluate(() =>
          document.documentElement.style.getPropertyValue(
            "--collection-stale-height"
          )
        )
      )
      .toBe("");
    await tabs.getByRole("button", { name: "Collection", exact: true }).click();
    await expect(reload).toBeVisible();
    await expectPadding(true);
    await reload.click();
    await expect(reload).toHaveCount(0);
    await expectPadding(false);
    await expect
      .poll(() =>
        page.evaluate(() =>
          document.documentElement.style.getPropertyValue(
            "--collection-stale-height"
          )
        )
      )
      .toBe("");
  });
}
