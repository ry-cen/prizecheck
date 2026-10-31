import { randomUUID } from "node:crypto";
import type { Locator, Page, TestInfo } from "@playwright/test";
import { expect, test } from "./support/collectors";
import { discoverable, seedZips } from "./support/conversations";
import {
  ORIGIN,
  accountId,
  api,
  befriend,
  hold,
  nameCollector,
  seedCatalog,
  unsorted,
} from "./support/loans";
import { signInAsOwner } from "./support/sign-in";
import { forTradeLeaf } from "./support/trades";

type Size = { width: number; height: number };
const SIZES: Record<string, Size> = {
  "320x568": { width: 320, height: 568 },
  "375x667": { width: 375, height: 667 },
  "390x844": { width: 390, height: 844 },
  "landscape 667x375": { width: 667, height: 375 },
  "landscape 844x390": { width: 844, height: 390 },
  "short 375x480": { width: 375, height: 480 },
};
const PHONE_WIDTHS = ["320x568", "375x667", "390x844"];

type Rect = { left: number; top: number; right: number; bottom: number };
type Bounds = {
  open: boolean;
  viewport: { width: number; height: number };
  panel: Rect | null;
  trigger: Rect | null;
  clippedBy: { node: string; rect: Rect }[];
  pageScrollWidth: number;
  items: { label: string; hit: boolean }[];
  activeIsTrigger: boolean;
  activeIsItem: boolean;
};

/** Reads the open menu's panel (the role="menu" list's parent), the trigger, each clipping ancestor and a hit test of
 * every item's centre. Reads only; nothing is scrolled or moved. */
function readBounds(page: Page, triggerName: string): Promise<Bounds> {
  return page.evaluate((name) => {
    const rect = (el: Element) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    };
    const trigger = Array.from(
      document.querySelectorAll<HTMLElement>('button[aria-haspopup="menu"]')
    ).find((b) => b.getAttribute("aria-label") === name);
    const list = document.querySelector<HTMLElement>('[role="menu"]');
    const panel = list?.closest<HTMLElement>("[data-menu-panel]") ?? null;
    const clippedBy: { node: string; rect: Rect }[] = [];
    let contained = false;
    for (let el = panel?.parentElement; el; el = el.parentElement) {
      const s = getComputedStyle(el);
      contained ||=
        [
          s.transform,
          s.translate,
          s.scale,
          s.rotate,
          s.perspective,
          s.filter,
          s.backdropFilter,
        ].some((value) => !!value && value !== "none") ||
        /layout|paint|strict|content/.test(s.contain) ||
        s.containerType !== "normal" ||
        /transform|translate|scale|rotate|perspective|filter|contain|container-type/.test(
          s.willChange
        );
      if (
        (contained &&
          [s.overflowX, s.overflowY].some((value) => value !== "visible")) ||
        /paint|strict|content/.test(s.contain)
      )
        clippedBy.push({ node: el.tagName, rect: rect(el) });
    }
    const items = Array.from(
      list?.querySelectorAll<HTMLElement>(
        '[role="menuitem"], [role="menuitemradio"]'
      ) ?? []
    ).map((item) => {
      const r = item.getBoundingClientRect();
      const hitEl = document.elementFromPoint(
        r.left + r.width / 2,
        r.top + r.height / 2
      );
      return {
        label: item.textContent ?? "",
        hit: !!hitEl && (hitEl === item || item.contains(hitEl)),
      };
    });
    return {
      open: !!list,
      viewport: {
        width: document.documentElement.clientWidth,
        height: document.documentElement.clientHeight,
      },
      panel: panel ? rect(panel) : null,
      trigger: trigger ? rect(trigger) : null,
      clippedBy,
      pageScrollWidth: document.documentElement.scrollWidth,
      items,
      activeIsTrigger: document.activeElement === trigger,
      activeIsItem:
        !!list &&
        !!document.activeElement &&
        list.contains(document.activeElement),
    };
  }, triggerName);
}

/** What is wrong with an open menu's bounds, as readable strings; empty when the whole panel is usable. */
function problems(b: Bounds): string[] {
  const out: string[] = [];
  if (!b.open || !b.panel) return ["menu not open"];
  const p = b.panel;
  if (p.left < 7.5) out.push(`left edge ${p.left.toFixed(1)} < 0`);
  if (p.right > b.viewport.width - 7.5)
    out.push(`right edge ${p.right.toFixed(1)} > ${b.viewport.width}`);
  if (p.top < 7.5) out.push(`top edge ${p.top.toFixed(1)} < 0`);
  if (p.bottom > b.viewport.height - 7.5)
    out.push(`bottom edge ${p.bottom.toFixed(1)} > ${b.viewport.height}`);
  for (const c of b.clippedBy) {
    const r = c.rect;
    if (
      p.left < r.left - 0.5 ||
      p.right > r.right + 0.5 ||
      p.top < r.top - 0.5 ||
      p.bottom > r.bottom + 0.5
    )
      out.push(`clipped by ${c.node}`);
  }
  if (b.pageScrollWidth > b.viewport.width)
    out.push(
      `page scrolls sideways (${b.pageScrollWidth} > ${b.viewport.width})`
    );
  const missed = b.items.filter((i) => !i.hit).map((i) => i.label);
  if (missed.length) out.push(`items not hittable: ${missed.join(", ")}`);
  return out;
}

/** Waits for the menu to open, then records and softly asserts its bounds, with a screenshot. */
async function checkOpenMenu(
  page: Page,
  testInfo: TestInfo,
  triggerName: string,
  scenario: string
) {
  await expect(page.getByRole("menu")).toBeVisible();
  try {
    await expect
      .poll(async () => problems(await readBounds(page, triggerName)), {
        message: scenario,
      })
      .toEqual([]);
  } catch (error) {
    await testInfo.attach("menu-bounds.json", {
      body: JSON.stringify(await readBounds(page, triggerName)),
      contentType: "application/json",
    });
    await testInfo.attach("menu-bounds.png", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
    throw error;
  }
}

/** Closes an open menu with Escape and checks focus went back to its trigger. */
async function escapeTo(page: Page, trigger: Locator) {
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(trigger).toBeFocused();
}

/** Loan's panel should stay attached to a trigger with room for either preferred edge. */
async function expectAnchored(page: Page, triggerName: string) {
  await expect
    .poll(async () => {
      const { panel, trigger } = await readBounds(page, triggerName);
      if (!panel || !trigger) return false;
      return (
        Math.min(
          Math.abs(panel.top - trigger.bottom - 4),
          Math.abs(panel.bottom - trigger.top + 4)
        ) <= 1 &&
        Math.min(
          Math.abs(panel.left - trigger.left),
          Math.abs(panel.right - trigger.right)
        ) <= 1
      );
    })
    .toBe(true);
}

/** Sample the invariant after queued scroll events and animation frames, rather than accepting a transient hit. */
async function expectFocusedItemStaysHittable(item: Locator) {
  expect(
    await item.evaluate(async (el) => {
      for (let frame = 0; frame < 8; frame++) {
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve())
        );
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(
          r.left + r.width / 2,
          r.top + r.height / 2
        );
        if (
          document.activeElement !== el ||
          !hit ||
          !el.contains(hit) ||
          r.top < 8 ||
          r.bottom > innerHeight - 8
        )
          return false;
      }
      return true;
    })
  ).toBe(true);
}

/** Doubles every font-size token, as a reader's 200% text size setting does (app-shell.spec.ts's doubleText). */
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

const noArtwork = (page: Page) =>
  page.route(/^https:\/\/assets\.tcgdex\.net\//, (route) => route.abort());

test("the Loan screen's ⋯ menu stays wholly on screen on a phone", async ({
  page,
  collectors,
}, testInfo) => {
  // Two collectors, a catalog import and many viewport sizes: well over 30 s on a loaded host.
  test.slow();
  const ids = seedCatalog();
  const misty = (await collectors.signIn({ next: "/loans" })).page;
  await nameCollector(misty, "Misty W");
  await hold(misty, await unsorted(misty), ids["PAL 185"], 2);
  await noArtwork(page);
  await signInAsOwner(page, "/loans");
  await nameCollector(page, "Ash K");
  await befriend(page, misty);
  // Ash's pending Borrow Request: his side offers "Withdraw request" in the ⋯ menu.
  const request = (
    await api(page, "POST", "/api/loans", {
      lender_id: await accountId(misty),
      lines: [{ edition_id: ids["PAL 185"], quantity: "1" }],
      deck_id: null,
      idempotency_key: randomUUID(),
    })
  ).id as string;
  const name = "More for this Loan";
  const more = page.getByRole("button", { name });

  for (const [label, size] of Object.entries(SIZES)) {
    await page.setViewportSize(size);
    await page.goto(`${ORIGIN}/loans/${request}`);
    await expect(more).toBeVisible();
    await more.click();
    await checkOpenMenu(page, testInfo, name, `click ${label}`);
    await escapeTo(page, more);
  }

  for (const label of PHONE_WIDTHS) {
    const size = SIZES[label];
    await page.setViewportSize(size);
    await page.goto(`${ORIGIN}/loans/${request}`);
    await expect(more).toBeVisible();

    // Keyboard: Enter opens on the first item, ArrowUp on the last; Escape returns focus to the ⋯.
    await more.focus();
    await page.keyboard.press("Enter");
    await checkOpenMenu(page, testInfo, name, `Enter ${label}`);
    await escapeTo(page, more);
    await page.keyboard.press("ArrowUp");
    await checkOpenMenu(page, testInfo, name, `ArrowUp ${label}`);
    await escapeTo(page, more);

    // Repeated toggles by tap on the trigger, and one press outside.
    for (let i = 0; i < 4; i++) {
      await more.click();
      await expect(page.getByRole("menu")).toBeVisible();
      await more.click();
      await expect(page.getByRole("menu")).toHaveCount(0);
    }
    await more.click();
    await checkOpenMenu(page, testInfo, name, `after toggles ${label}`);
    // A press outside, on the page heading (a neutral spot: a corner can land on the phone tab bar and leave the page).
    await page
      .getByRole("heading", { level: 1 })
      .click({ position: { x: 2, y: 2 } });
    await expect(page.getByRole("menu")).toHaveCount(0);

    // Scrolled: the page scrolled down by part of a screen, then the ⋯ brought back into view and opened.
    await page.mouse.wheel(0, size.height / 2);
    await more.scrollIntoViewIfNeeded();
    await more.click();
    await checkOpenMenu(page, testInfo, name, `scrolled ${label}`);
    await escapeTo(page, more);

    await page.evaluate(() => window.scrollTo(0, 0));
    await more.click();
    await expectAnchored(page, name);
    const beforeScroll = await more.evaluate(
      (el) => el.getBoundingClientRect().top
    );
    await page.evaluate(() => {
      document.body.style.paddingBottom = "1000px";
      window.scrollBy(0, 12);
    });
    await expect
      .poll(() => more.evaluate((el) => el.getBoundingClientRect().top))
      .toBeLessThan(beforeScroll - 5);
    await checkOpenMenu(page, testInfo, name, `scroll while open ${label}`);
    await expectAnchored(page, name);
    await escapeTo(page, more);
    await more.scrollIntoViewIfNeeded();

    // Rotation while open: the panel must still fit the new viewport.
    await more.click();
    await expect(page.getByRole("menu")).toBeVisible();
    await page.setViewportSize({ width: size.height, height: size.width });
    await checkOpenMenu(
      page,
      testInfo,
      name,
      `rotated while open from ${label}`
    );
    await expectAnchored(page, name);
    await escapeTo(page, more);
    await page.setViewportSize(size);

    await page.goto(`${ORIGIN}/loans/${request}`);
    await more.evaluate((el) => {
      // A page-sized fixed containing block with a separate, nested clipping ancestor.
      // Leave enough vertical room for the full menu rather than clipping it to the trigger's 44 px anchor.
      const container = el.closest<HTMLElement>("#main-content")!;
      const main = el.closest<HTMLElement>("main")!;
      main.style.transform = "translateX(13px)";
      container.style.overflow = "hidden";
      main.style.overflow = "hidden";
      main.style.minHeight = "320px";
    });
    await more.click();
    await checkOpenMenu(page, testInfo, name, `translated ancestor ${label}`);
    await escapeTo(page, more);

    // Text at 200%.
    await page.goto(`${ORIGIN}/loans/${request}`);
    await doubleText(page);
    await expect(more).toBeVisible();
    await more.click();
    await checkOpenMenu(page, testInfo, name, `text 200% ${label}`);
    await escapeTo(page, more);
  }

  for (const name of ["Amber A", "Brock B", "Clemont C", "Dawn D", "Erika E"]) {
    const friend = (await collectors.signIn()).page;
    await nameCollector(friend, name);
    await befriend(page, friend);
  }

  // Friends drawer row ⋯ (inside a Dialog's scroll body), on the same signed-in page.
  const friendsMenu = "More for Misty W";
  for (const label of PHONE_WIDTHS) {
    await page.setViewportSize(SIZES[label]);
    await page.goto(`${ORIGIN}/loans`);
    await page.getByRole("button", { name: "Friends", exact: true }).click();
    const drawer = page.getByRole("dialog", { name: "Friends" });
    const rowMore = drawer.getByRole("button", { name: friendsMenu });
    await rowMore.scrollIntoViewIfNeeded();
    await rowMore.click();
    await checkOpenMenu(page, testInfo, friendsMenu, `friends drawer ${label}`);
    await escapeTo(page, rowMore);
    await drawer.getByRole("button", { name: "Close Friends" }).click();
  }

  // The Account menu (right of the header).
  for (const label of ["desktop"]) {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${ORIGIN}/loans`);
    const account = page.getByRole("button", { name: "Account" }).first();
    await account.click();
    await checkOpenMenu(page, testInfo, "Account", `account ${label}`);
    await page.keyboard.press("End");
    const tallLast = page.getByRole("menuitem").last();
    await expect(tallLast).toBeFocused();
    await expectFocusedItemStaysHittable(tallLast);
    await page.setViewportSize({ width: 1280, height: 160 });
    await expectFocusedItemStaysHittable(tallLast);
    await escapeTo(page, account);
    await account.click();
    await page.keyboard.press("End");
    const last = page.getByRole("menuitem").last();
    await expect(last).toBeFocused();
    await expectFocusedItemStaysHittable(last);
    // Repositioning from a real resize must preserve the scrolling list's offset too.
    await page.setViewportSize({ width: 1270, height: 160 });
    await expectFocusedItemStaysHittable(last);
    await page.keyboard.press("Home");
    await expect(page.getByRole("menuitem").first()).toBeFocused();
    const viewport = page
      .locator("[data-menu-panel] [role=menu]")
      .locator("..");
    await expect.poll(() => viewport.evaluate((el) => el.scrollTop)).toBe(0);
    await viewport.hover();
    await page.mouse.wheel(0, 1000);
    await expect
      .poll(() => viewport.evaluate((el) => el.scrollTop))
      .toBeGreaterThan(0);
    await page.keyboard.press("End");
    await expectFocusedItemStaysHittable(last);
    await escapeTo(page, account);
    await account.press("ArrowUp");
    await expectFocusedItemStaysHittable(last);
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("menuitem").first()).toBeFocused();
    await escapeTo(page, account);
  }
});

test("a Near you row's ⋯ menu stays wholly on screen on a phone", async ({
  page,
  collectors,
}, testInfo) => {
  // Two collectors, a catalog import and zip seeding: well over 30 s on a loaded host.
  test.slow();
  const ids = seedCatalog();
  const misty = (await collectors.signIn()).page;
  await nameCollector(misty, "Misty W");
  await hold(
    misty,
    await forTradeLeaf(misty, "Misty Binder"),
    ids["PAL 185"],
    1
  );
  await api(misty, "PUT", `/api/trade-wants/${ids["SVI 166"]}`, {
    quantity: "1",
  });
  await noArtwork(page);
  await signInAsOwner(page, "/collection");
  await nameCollector(page, "Ash K");
  await hold(page, await forTradeLeaf(page, "Ash Shelf"), ids["SVI 166"], 1);
  await api(page, "PUT", `/api/trade-wants/${ids["PAL 185"]}`, {
    quantity: "1",
  });
  await seedZips();
  await discoverable(misty, "00011");
  await discoverable(page, "00010");
  const name = "More for Misty W";

  for (const label of [...PHONE_WIDTHS, "landscape 667x375"]) {
    for (const big of [false, true]) {
      await page.setViewportSize(SIZES[label]);
      await page.goto(`${ORIGIN}/trades/find`);
      if (big) await doubleText(page);
      const near = page
        .getByRole("main")
        .getByRole("region", { name: "Near you", exact: true });
      const row = near
        .getByRole("list", { name: "Matches near you" })
        .locator("> li")
        .first();
      await row.getByRole("button", { name: /Misty W/ }).click();
      const more = row.getByRole("button", { name });
      await more.scrollIntoViewIfNeeded();
      await more.click();
      await checkOpenMenu(
        page,
        testInfo,
        name,
        `near you ${label}${big ? " text 200%" : ""}`
      );
      await escapeTo(page, more);
    }
  }
});
