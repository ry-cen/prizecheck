import { test, expect, type Locator, type Page } from "@playwright/test";
import { signInAsOwner } from "./support/sign-in";
import { Pool } from "pg";

/*
 * The app's look once the old global stylesheet is gone (#184, spec "Sign-in, Sign-ins, loading and first paint";
 * ADR 0012). Formerly legacy-look.spec.ts, which held the old pages' look while Tailwind came in (#161) and kept
 * the checks for this last stage.
 *
 * - The served HTML paints dark, with the static wordmark, before any script runs, in the tokens' colours.
 * - base.css is in charge: <html> is dark with color-scheme dark on every page, and every unstyled element gets its
 *   one focus ring (2 px solid gold, 2 px off), inside pages and outside them.
 * - Preflight is on: bare button, input, select, heading and list elements get no look.
 * - Themes still switch with data-theme on <html>, the first-paint style included.
 *
 * The checks read computed styles through roles and elements, never class names.
 */

const origin = process.env.TEST_ORIGIN || "http://localhost:5173";

/** --color-bg in tokens.css (#121110), which web/index.html's first-paint style copies. */
const DARK = "rgb(18, 17, 16)";
/** --color-accent and --color-focus in tokens.css (#e6bd57). */
const GOLD = "rgb(230, 189, 87)";

async function signIn(page: Page) {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    // The owner's code-send limits (shared by every test on this stack) start empty.
    await pool.query("DELETE FROM auth_send_event");
  } finally {
    await pool.end();
  }
  await signInAsOwner(page, "/collection");
  await expect(page).toHaveURL(/\/collection$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("All owned");
}

const style = (locator: Locator, property: string) =>
  locator.evaluate(
    (element, name) => getComputedStyle(element).getPropertyValue(name),
    property
  );

/** <html> is dark with the dark color-scheme. */
async function expectDarkPage(page: Page) {
  const html = page.locator("html");
  expect(await style(html, "background-color")).toBe(DARK);
  expect(await style(html, "color-scheme")).toBe("dark");
}

/** Focuses the element by script and checks base.css's ring on it: 2 px solid gold, 2 px off. */
async function expectBaseRing(locator: Locator) {
  await locator.focus();
  await expect(locator).toBeFocused();
  expect(
    await locator.evaluate((element) => element.matches(":focus-visible"))
  ).toBe(true);
  expect(await style(locator, "outline-style")).toBe("solid");
  expect(await style(locator, "outline-width")).toBe("2px");
  expect(await style(locator, "outline-color")).toBe(GOLD);
  expect(await style(locator, "outline-offset")).toBe("2px");
}

/** A link with no focus rule of its own, as the first element of the page body or of the shown page's main
 * region: it shows which focus ring an unstyled element gets there. */
async function addProbeLink(
  page: Page,
  where: "body" | "main"
): Promise<Locator> {
  const name = `Look probe in ${where}`;
  await page.evaluate(
    ([where, name]) => {
      const link = document.createElement("a");
      link.href = "#look-probe";
      link.textContent = name;
      const parent =
        where === "body"
          ? document.body
          : Array.from(document.querySelectorAll("main")).find(
              (main) => main.getClientRects().length > 0
            )!;
      parent.prepend(link);
    },
    [where, name]
  );
  return page.getByRole("link", { name });
}

/** The Decks index and Collection: a dark page down to <html>, and base.css's focus ring everywhere. */
async function pageLook(page: Page, path: "/decks" | "/collection") {
  await signIn(page);
  // A fresh document, so nothing has been clicked in it.
  await page.goto(`${origin}${path}`);
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: path === "/decks" ? "Decks" : "All owned",
    })
  ).toBeVisible();
  await expectDarkPage(page);
  expect(
    await style(page.locator("#root > *").first(), "background-color")
  ).toBe(DARK);
  await expectBaseRing(await addProbeLink(page, "body"));
  await expectBaseRing(await addProbeLink(page, "main"));
  await expectBaseRing(
    path === "/decks"
      ? page.getByRole("textbox", { name: "Deck name" })
      : page.getByRole("searchbox", { name: "Search cards" })
  );
}

test.describe("before any script runs", () => {
  test.use({
    viewport: { width: 1280, height: 800 },
    javaScriptEnabled: false,
  });

  test("the served HTML is dark from the first paint, with the static wordmark", async ({
    page,
  }) => {
    await page.goto(`${origin}/collection`);
    await expectDarkPage(page);
    await expect(page.locator("#root")).toHaveText("✦ PrizeCheck");
    await expect(page.locator('meta[name="color-scheme"]')).toHaveAttribute(
      "content",
      "dark"
    );
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute(
      "content",
      "#121110"
    );
    // The wordmark sits in the middle of the page in the loading screen's muted text, 18 px bold.
    const wordmark = page.locator("#first-paint");
    expect(await style(wordmark, "color")).toBe("rgb(185, 176, 163)");
    expect(await style(wordmark, "font-size")).toBe("18px");
    expect(await style(wordmark, "font-weight")).toBe("700");
    const box = (await wordmark.boundingBox())!;
    expect(box.height).toBe(800);
    expect(await style(page.locator("body"), "margin-top")).toBe("0px");
  });
});

test.describe("at 1280×800", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("the first paint's colours are the tokens', and React replaces the static wordmark", async ({
    page,
  }) => {
    await page.goto(`${origin}/sign-in`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Sign in to PrizeCheck"
    );
    await expect(page.locator("#first-paint")).toHaveCount(0);
    const html = page.locator("html");
    // web/index.html copies these two token values; a token change must change the copy too.
    expect(
      await html.evaluate((element) => {
        const probe = document.createElement("span");
        probe.style.color = "var(--color-text-muted)";
        probe.style.backgroundColor = "var(--color-bg)";
        element.appendChild(probe);
        const read = getComputedStyle(probe);
        const values = [read.backgroundColor, read.color];
        probe.remove();
        return values;
      })
    ).toEqual([DARK, "rgb(185, 176, 163)"]);
  });

  test("Preflight is on: bare buttons, fields, headings and lists get no look", async ({
    page,
  }) => {
    await page.goto(`${origin}/sign-in`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Sign in to PrizeCheck"
    );
    const looks = await page.evaluate(() => {
      const holder = document.createElement("div");
      holder.style.fontSize = "13px";
      holder.innerHTML =
        '<button type="button">Bare button</button><input aria-label="Bare input"><select aria-label="Bare select"><option>One</option></select><h2>Bare heading</h2><ul><li>Bare item</li></ul>';
      document.body.appendChild(holder);
      const read = (selector: string) => {
        const s = getComputedStyle(holder.querySelector(selector)!);
        return {
          background: s.backgroundColor,
          border: s.borderTopWidth,
          margin: s.marginTop,
          padding: s.paddingLeft,
          fontSize: s.fontSize,
          fontWeight: s.fontWeight,
          listStyle: s.listStyleType,
        };
      };
      const values = {
        button: read("button"),
        input: read("input"),
        select: read("select"),
        heading: read("h2"),
        list: read("ul"),
      };
      holder.remove();
      return values;
    });
    for (const control of [looks.button, looks.input, looks.select]) {
      expect(control.background).toBe("rgba(0, 0, 0, 0)");
      expect(control.border).toBe("0px");
      expect(control.margin).toBe("0px");
      expect(control.fontSize).toBe("13px");
    }
    expect(looks.button.padding).toBe("0px");
    expect(looks.heading).toMatchObject({
      margin: "0px",
      fontSize: "13px",
      fontWeight: "400",
    });
    expect(looks.list).toMatchObject({
      margin: "0px",
      padding: "0px",
      listStyle: "none",
    });
  });

  test("the Decks index is dark down to the page, with base.css's focus ring", async ({
    page,
  }) => {
    await pageLook(page, "/decks");
  });

  test("Collection is dark down to the page, with base.css's focus ring", async ({
    page,
  }) => {
    await pageLook(page, "/collection");
  });

  test("themes still switch with data-theme on <html>", async ({ page }) => {
    await signIn(page);
    const html = page.locator("html");
    const root = page.locator("#root > *").first();
    await expect(html).toHaveAttribute("data-theme", "prize-gold");
    // #root's first child is the app shell (#162): dark, on the tokens.
    expect(await style(root, "background-color")).toBe(DARK);
    expect(await style(root, "color-scheme")).toBe("dark");

    await page.addStyleTag({
      content:
        ':root[data-theme="look-probe"] { --color-bg: rgb(1, 2, 3); --color-text: rgb(4, 5, 6); }',
    });
    await html.evaluate((element) =>
      element.setAttribute("data-theme", "look-probe")
    );
    // base.css follows the theme down to <html>, over the first-paint style's copy of the default.
    expect(await style(html, "background-color")).toBe("rgb(1, 2, 3)");
    expect(await style(root, "background-color")).toBe("rgb(1, 2, 3)");
    expect(await style(root, "color")).toBe("rgb(4, 5, 6)");

    await html.evaluate((element) =>
      element.setAttribute("data-theme", "prize-gold")
    );
    expect(await style(root, "background-color")).toBe(DARK);
  });
});

test.describe("at 375×812", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("the Decks index is dark down to the page, with base.css's focus ring", async ({
    page,
  }) => {
    await pageLook(page, "/decks");
  });

  test("Collection is dark down to the page, with base.css's focus ring", async ({
    page,
  }) => {
    await pageLook(page, "/collection");
  });
});
