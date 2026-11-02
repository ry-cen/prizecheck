import type { Locator } from "@playwright/test";
import { test, expect, type OtherCollector } from "./support/collectors";
import {
  api,
  befriend,
  createDeck,
  hold,
  nameCollector,
  ORIGIN,
  seedCatalog,
  setLine,
  unsorted,
} from "./support/loans";
import { expectPageChecks } from "./support/page-check";
import { expectTouchTarget } from "./support/touch-target";

async function placeholder(frame: Locator, name: string, width: number) {
  await expect(frame).toBeVisible();
  await expect(frame.getByText(name, { exact: true })).toBeVisible();
  await expect
    .poll(() =>
      frame.evaluate((element) => {
        const box = element.getBoundingClientRect();
        return {
          width: Math.round(box.width),
          cardAspect: Math.abs(box.width / box.height - 245 / 342) < 0.01,
        };
      })
    )
    .toEqual({ width, cardAspect: true });
}

async function fits(container: Locator) {
  await expect
    .poll(() =>
      container.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return [
          ...element.querySelectorAll<HTMLElement>(
            "p, h3, label, button, [role=group], li, output"
          ),
        ].every((child) => {
          const rect = child.getBoundingClientRect();
          const css = getComputedStyle(child);
          return (
            rect.left >= bounds.left &&
            rect.right <= bounds.right + 0.5 &&
            child.scrollWidth <= child.clientWidth &&
            child.scrollHeight <= child.clientHeight &&
            css.textOverflow !== "ellipsis" &&
            ["none", ""].includes(css.webkitLineClamp)
          );
        });
      })
    )
    .toBe(true);
}

async function sectionExample(
  signIn: () => Promise<OtherCollector>,
  width: number
) {
  const ids = seedCatalog();
  const friend = (await signIn()).page;
  await nameCollector(friend, "Misty W");
  await hold(friend, await unsorted(friend), ids["PAL 185"], 3);
  const page = (await signIn()).page;
  await befriend(page, friend);
  await page.setViewportSize({ width, height: 900 });
  await page.route(/^https:\/\/assets\.tcgdex\.net\//, (route) =>
    route.abort()
  );
  const deck = await createDeck(page, "Tile sections");
  await setLine(page, deck, ids["PAL 185"], 2);
  await setLine(page, deck, ids["PAL 172"], 1);
  for (const key of ["PAL 254", "PAF 80"])
    await api(page, "PUT", `/api/trade-wants/${ids[key]}`, { quantity: "2" });
  // Missing URLs exercise a visible, sized fallback in every section without external image requests.
  await page.route(
    (url) =>
      url.pathname === "/api/want-list" || url.pathname === "/api/trade-wants",
    async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      if (body.sections) {
        for (const section of body.sections)
          for (const line of section.lines) line.image_url = null;
        for (const row of body.combined) row.image_url = null;
      } else for (const line of body.lines) line.image_url = null;
      await route.fulfill({ response, json: body });
    }
  );
  await page.goto(`${ORIGIN}/decks/want-list`);
  return page;
}

for (const width of [320, 375, 390, 960, 1280]) {
  test(`Combined total and Trade Wants preserve facts and controls at ${width}px`, async ({
    collectors,
  }) => {
    const page = await sectionExample(() => collectors.signIn(), width);
    const combined = page.getByRole("list", {
      name: "Cards to get",
      exact: true,
    });
    if (width <= 760)
      await page.getByText(/^Combined total \(Decks only\) · 3 cards/).click();
    else
      await expect(
        page.getByRole("heading", {
          name: /^Combined total \(Decks only\) · 3 cards/,
        })
      ).toBeVisible();
    await expect(combined.getByRole("listitem")).toHaveCount(2);
    const iono = combined.getByRole("listitem").filter({ hasText: "Iono" });
    await expect(iono.locator(":scope > div > span").first()).toHaveText("2");
    await expect(iono).toContainText("Tile sections 2");
    await expect(iono).toContainText("No price");
    await placeholder(
      iono.locator(':scope > span[aria-hidden="true"] > span'),
      "Iono",
      52
    );
    if (width === 1280) {
      // Simulate #463's future column width without changing the application's layout code.
      for (const asideWidth of [288, 352]) {
        await combined.evaluate((list, size) => {
          const aside = list.closest("aside")!;
          aside.style.width = `${size}px`;
          aside.parentElement!.style.gridTemplateColumns = `minmax(0,1fr) ${size}px`;
        }, asideWidth);
        await fits(combined);
      }
    }
    await fits(combined);
    const wants = page.getByRole("list", {
      name: "Your Trade Wants",
      exact: true,
    });
    const tradeLine = wants.getByRole("listitem").filter({ hasText: "254" });
    await placeholder(
      tradeLine.locator(':scope > span[aria-hidden="true"] > span'),
      "Iono",
      width <= 760 ? 64 : 145
    );
    const increase = tradeLine.getByRole("button", {
      name: /^Increase Iono \(Paldea Evolved · 254 /,
    });
    const decrease = tradeLine.getByRole("button", {
      name: /^Decrease Iono \(Paldea Evolved · 254 /,
    });
    await expect(increase).toBeVisible();
    await expect(decrease).toBeVisible();
    await expect(tradeLine.locator("output")).toHaveText("2");
    await expect(tradeLine.getByRole("radiogroup")).toHaveCount(0);
    await expect(tradeLine.getByRole("button", { name: /Swap/ })).toHaveCount(
      0
    );
    if (width <= 760) {
      await expectTouchTarget(increase);
      await expectTouchTarget(decrease);
    }
    if (width === 1280)
      await expect
        .poll(() =>
          wants.evaluate((list) => {
            const [a, b] = [...list.children].map((child) =>
              child.getBoundingClientRect()
            );
            return a.y === b.y && b.x > a.x;
          })
        )
        .toBe(true);
    const originalStepper = await tradeLine.getByRole("group").elementHandle();
    await page.setViewportSize({
      width: width <= 760 ? 1280 : 390,
      height: 900,
    });
    await expect
      .poll(() =>
        tradeLine
          .getByRole("group")
          .evaluate((node, original) => node === original, originalStepper)
      )
      .toBe(true);
    await page.setViewportSize({ width, height: 900 });
    await fits(wants);
    await expect(
      page.getByRole("button", { name: "Add a card", exact: true })
    ).toBeVisible();
    await expectPageChecks(
      page,
      `Combined total and Trade Wants at ${width}px`
    );
  });
  test(`From Friends preserves facts and controls at ${width}px`, async ({
    collectors,
  }) => {
    const page = await sectionExample(() => collectors.signIn(), width);
    const main = page.getByRole("main").filter({ visible: true });
    await expect(
      main.getByRole("link", { name: /^Trade Wants ·/ })
    ).toBeVisible();
    await main
      .getByRole("radiogroup", { name: "Show the Want List as" })
      .getByRole("radio", { name: "Get from Friends", exact: true })
      .check();
    await expect(
      main.getByRole("region", { name: "Trade Wants", exact: true })
    ).toHaveCount(0);
    await expect(
      main.getByRole("link", { name: /^Trade Wants ·/ })
    ).toHaveCount(0);
    const panel = main.getByRole("region", { name: /^Iono / });
    await expect(panel).toContainText("You need 2 · Tile sections");
    await expect(panel).toContainText("0 of 2 asked");
    await expect(
      page.getByText("Cards you need that Friends can lend.", { exact: true })
    ).toBeVisible();
    await expect(
      page.getByText("1 card you need isn't available from any Friend.", {
        exact: true,
      })
    ).toBeVisible();
    await placeholder(
      panel.locator(':scope > span[aria-hidden="true"] > span'),
      "Iono",
      width <= 760 ? 64 : 110
    );
    const friends = panel.getByRole("list", {
      name: /^Friends who can lend Iono, Paldea Evolved · 185 /,
    });
    await expect(friends.getByRole("listitem")).toHaveCount(1);
    await expect(friends).toContainText("Misty W @misty_");
    await expect(friends).toContainText("3 spare");
    const expectIdentityFits = async () => {
      if (width !== 320 && width !== 375) return;
      for (const row of await friends.getByRole("listitem").all()) {
        const name = row.getByText("Misty W", { exact: true });
        await expect(name).toBeVisible();
        await expect
          .poll(() =>
            name.evaluate((element) => {
              const style = getComputedStyle(element);
              const box = element.getBoundingClientRect();
              // Measure an unconstrained copy with the same font to catch letter-by-letter wrapping.
              const natural = element.cloneNode(true) as HTMLElement;
              Object.assign(natural.style, {
                position: "absolute",
                visibility: "hidden",
                display: "inline-block",
                whiteSpace: "nowrap",
                width: "max-content",
                font: style.font,
                letterSpacing: style.letterSpacing,
              });
              document.body.append(natural);
              const naturalBox = natural.getBoundingClientRect();
              natural.remove();
              // The page uses line-height: normal, whose computed value is not numeric.
              // Its unconstrained copy gives the browser's actual one-line height.
              const computedLineHeight = parseFloat(style.lineHeight);
              const lineHeight = Number.isFinite(computedLineHeight)
                ? computedLineHeight
                : naturalBox.height;
              return {
                singleLine: box.height < 1.6 * lineHeight,
                fullWidth: box.width + 0.5 >= naturalBox.width,
              };
            })
          )
          .toEqual({ singleLine: true, fullWidth: true });
      }
    };
    await expectIdentityFits();
    const ask = friends.getByRole("button", {
      name: "Ask Misty W for Iono",
      exact: true,
    });
    if (width <= 760) await expectTouchTarget(ask);
    await ask.click();
    await expect(panel).toContainText("1 of 2 asked");
    const copies = friends.getByRole("group", {
      name: "Copies of Iono to ask Misty W for",
      exact: true,
    });
    await expect(copies.locator("output")).toHaveText("1");
    await expect(
      copies.getByRole("button", {
        name: "Increase Copies of Iono to ask Misty W for",
        exact: true,
      })
    ).toBeVisible();
    await expect(
      copies.getByRole("button", {
        name: "Decrease Copies of Iono to ask Misty W for",
        exact: true,
      })
    ).toBeVisible();
    await expectIdentityFits();
    const original = await copies.elementHandle();
    await page.setViewportSize({
      width: width <= 760 ? 1280 : 390,
      height: 900,
    });
    await expect
      .poll(() => copies.evaluate((node, old) => node === old, original))
      .toBe(true);
    await expect(copies.locator("output")).toHaveText("1");
    await page.setViewportSize({ width, height: 900 });
    await expectIdentityFits();
    await fits(panel);
    await expectPageChecks(page, `From Friends at ${width}px`);
  });
}

for (const height of [800, 600]) {
  test(`sticky Combined total final row remains reachable at 1280x${height}`, async ({
    collectors,
  }) => {
    const page = (await collectors.signIn()).page;
    const ids = seedCatalog();
    const deck = await createDeck(page, "Long summary reachability Deck");
    await setLine(page, deck, ids["PAL 185"], 1);
    await page.route(
      (url) => url.pathname === "/api/want-list",
      async (route) => {
        const response = await route.fetch();
        const body = await response.json();
        const row = body.combined[0];
        body.combined = Array.from({ length: 8 }, (_, index) => ({
          ...row,
          edition_id: `${row.edition_id}-${index}`,
          name: `Summary row ${index + 1} with a long identifiable card label for reachability`,
          image_url: null,
        }));
        await route.fulfill({ response, json: body });
      }
    );
    await page.setViewportSize({ width: 1280, height });
    await page.goto(`${ORIGIN}/decks/want-list`);
    const aside = page.getByRole("complementary", { name: /^Combined total/ });
    const rows = aside.getByRole("listitem");
    await expect(rows).toHaveCount(8);
    const last = rows.last();
    await page.evaluate(() =>
      window.scrollTo(0, document.documentElement.scrollHeight)
    );
    await expect(last).toBeInViewport({ ratio: 1 });
    const evidence = await aside.evaluate((element) => {
      const last = element
        .querySelector("li:last-child")!
        .getBoundingClientRect();
      return {
        panelHeight: element.getBoundingClientRect().height,
        viewport: innerHeight,
        finalRow: { top: last.top, bottom: last.bottom, height: last.height },
      };
    });
    console.log("Sticky summary reachability", JSON.stringify(evidence));
    await test.info().attach("reachability", {
      body: JSON.stringify(evidence),
      contentType: "application/json",
    });
    // Summary rows currently contain no controls. Guard keyboard reachability if controls are added later.
    for (const control of await last
      .locator("a, button, input, select, [tabindex='0']")
      .all()) {
      await control.focus();
      await expect(control).toBeFocused();
      await expect(control).toBeInViewport();
    }
  });
}
