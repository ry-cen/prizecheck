import { test, expect } from "./support/collectors";
import {
  createDeck,
  setLine,
  seedCatalog,
  hold,
  unsorted,
  ORIGIN,
} from "./support/loans";
import { expectTouchTarget } from "./support/touch-target";

const labels = ["This exact card", "Any finish", "Any card with the same name"];

for (const width of [320, 375, 390, 960, 1280]) {
  test(`Want List art and visible choices fit ${width}px and persist`, async ({
    collectors,
  }) => {
    const ids = seedCatalog();
    const page = (await collectors.signIn()).page;
    await page.setViewportSize({ width, height: 900 });
    await page.route(/^https:\/\/assets\.tcgdex\.net\//, (route) =>
      route.abort()
    );
    const deck = await createDeck(page, "Tile examples");
    await setLine(page, deck, ids["PAL 185"], 4);
    await setLine(page, deck, ids["SVE 13"], 2);
    // A missing artwork URL exercises the same placeholder used by Collection tiles.
    await page.route(
      (url) => url.pathname === "/api/want-list",
      async (route) => {
        const response = await route.fetch();
        const body = await response.json();
        for (const section of body.sections)
          for (const line of section.lines) line.image_url = null;
        await route.fulfill({ response, json: body });
      }
    );
    await page.goto(`${ORIGIN}/decks/want-list?deck=${deck}`);
    const list = page.getByRole("list", { name: "What Tile examples needs" });
    await expect(list.getByRole("listitem")).toHaveCount(2);
    const iono = list.getByRole("listitem").filter({
      has: page.getByRole("radiogroup", { name: /^Will accept for Iono / }),
    });
    const groups = list.getByRole("radiogroup", { name: /^Will accept for / });
    await expect(groups).toHaveCount(2);
    for (const group of await groups.all()) {
      await expect(group.getByRole("radio")).toHaveCount(3);
      await expect(
        group.getByRole("radio", { name: labels[0], exact: true })
      ).toBeChecked();
      for (const name of labels) {
        const radio = group.getByRole("radio", { name, exact: true });
        await expect(radio).toBeVisible();
        const label = radio.locator("..");
        await label.scrollIntoViewIfNeeded();
        if (width <= 760) {
          const box = await expectTouchTarget(label);
          expect(box.x).toBeGreaterThanOrEqual(0);
          expect(box.x + box.width).toBeLessThanOrEqual(width);
        }
        await expect
          .poll(() =>
            label.evaluate((element) => {
              const text = element.querySelector("span")!;
              const css = getComputedStyle(text);
              return (
                text.scrollWidth <= text.clientWidth &&
                text.scrollHeight <= text.clientHeight &&
                css.textOverflow !== "ellipsis" &&
                ["none", ""].includes(css.webkitLineClamp)
              );
            })
          )
          .toBe(true);
      }
    }
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)
      )
      .toBe(true);
    await expect(iono).toContainText("×4 of 4");
    await expect(iono).toContainText("None owned");
    await expect(iono.locator("img")).toHaveCount(0);
    // CopyArt's outer wrapper and card-shaped frame must survive without an image.
    // Selecting the frame (rather than the line's name) makes removing the art fail this test.
    const placeholder = iono.locator(
      ':scope > span[aria-hidden="true"] > span'
    );
    await expect(placeholder).toBeVisible();
    await expect(placeholder.getByText("Iono", { exact: true })).toBeVisible();
    await expect
      .poll(() =>
        placeholder.evaluate((frame) => {
          const box = frame.getBoundingClientRect();
          return {
            width: Math.round(box.width),
            hasHeight: box.height > 0,
            cardAspect: Math.abs(box.width / box.height - 245 / 342) < 0.01,
          };
        })
      )
      .toEqual({
        width: width <= 760 ? 64 : 145,
        hasHeight: true,
        cardAspect: true,
      });
    if (width === 1280) {
      await expect
        .poll(() =>
          list.evaluate((element) => {
            const [a, b] = [...element.children].map((child) =>
              child.getBoundingClientRect()
            );
            return (
              getComputedStyle(element).display === "grid" &&
              a.y === b.y &&
              b.x > a.x
            );
          })
        )
        .toBe(true);
    }
    await iono
      .getByRole("radiogroup")
      .getByRole("radio", { name: "Any finish", exact: true })
      .check();
    await expect(
      page.getByRole("region", { name: "Notifications" })
    ).toContainText(/^Trades will match any finish/);
    await page.reload();
    await expect(
      iono
        .getByRole("radiogroup")
        .getByRole("radio", { name: "Any finish", exact: true })
    ).toBeChecked();
  });
}

test("Swap Undo survives desktop and phone resizing; Deck panel keeps its select", async ({
  collectors,
}) => {
  const ids = seedCatalog();
  const page = (await collectors.signIn()).page;
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.route(/^https:\/\/assets\.tcgdex\.net\//, (route) =>
    route.abort()
  );
  const deck = await createDeck(page, "Swap tiles");
  await setLine(page, deck, ids["PAL 185"], 4);
  await hold(page, await unsorted(page), ids["PAL 254"], 1);
  await page.goto(`${ORIGIN}/decks/want-list?deck=${deck}`);
  const list = page.getByRole("list", { name: "What Swap tiles needs" });
  await list
    .getByRole("button", {
      name: "Swap 1 Iono Paldea Evolved 185 for PAL 254",
      exact: true,
    })
    .click();
  const undo = page
    .getByRole("region", { name: "Notifications" })
    .getByRole("button", { name: "Undo", exact: true });
  await expect(undo).toBeVisible();
  await expect(list).toContainText("×3 of 3");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(undo).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 900 });
  await undo.click();
  await expect(list).toContainText("×4 of 4");
  await page.goto(`${ORIGIN}/decks/${deck}`);
  await page
    .getByRole("button", { name: "Ways to get missing cards", exact: true })
    .click();
  await expect(
    page.getByRole("combobox", { name: /^Will accept for Iono / })
  ).toBeVisible();
  await expect(
    page.getByRole("radiogroup", { name: /^Will accept for / })
  ).toHaveCount(0);
});
