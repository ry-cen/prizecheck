import { test, expect, type Locator, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { Pool } from "pg";

/*
 * Existing pages keep their look while Tailwind is added (ticket #161, ADR 0012). Preflight is not
 * loaded, and style.css holds back base.css, so the pages kept the look recorded before Tailwind. The
 * recorded baseline is gone (see below); what remains are the stage-7 checks.
 *
 * The checks read computed styles through roles and elements, never class names, so they hold on macOS and
 * Linux. style.css reaches only inside .legacy, so an unstyled element outside the old pages gets base.css's
 * focus ring, and one inside them keeps the browser's.
 *
 * Collection left the workspace CSS for the kit in #166, which deleted its two entries: its look is now the
 * kit's, checked by its own specs and the page check. Its tests keep the checks that hold until rollout stage
 * 7: a dark page down to <html>, <html> still at color-scheme normal, and base.css's focus ring.
 *
 * The Decks index left the old page for the kit in #181, which deleted the last two entries ("decks 1280" and
 * "decks 375") along with the baseline file and its comparison. Its tests keep the same stage-7 checks as
 * Collection's.
 */

type Styles = Record<string, string>;
type Look = Record<string, Styles>;

const origin = process.env.TEST_ORIGIN || "http://localhost:5173";

/** --color-accent and --color-focus in tokens.css (#e6bd57). */
const GOLD = "rgb(230, 189, 87)";

const PROPERTIES = [
  "display",
  "box-sizing",
  "color",
  "background-color",
  "background-image",
  "color-scheme",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "line-height",
  "letter-spacing",
  "text-transform",
  "text-decoration-line",
  "max-width",
  "gap",
  "margin-top",
  "margin-bottom",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "border-top-width",
  "border-right-width",
  "border-bottom-width",
  "border-left-width",
  "border-top-style",
  "border-top-color",
  "border-bottom-color",
  "border-top-left-radius",
  "border-bottom-right-radius",
  "box-shadow",
  "outline-style",
  "outline-width",
  "outline-color",
  "outline-offset",
  "opacity",
  "cursor",
  "appearance",
  "list-style-type",
];

function messages(path: string): string[] {
  try {
    return readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

async function signIn(page: Page) {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await pool.query("DELETE FROM auth_send_event");
  } finally {
    await pool.end();
  }
  const mail = process.env.MAIL_FILE || "/tmp/tcg-ticket01-mail";
  const before = messages(mail).length;
  await page.goto(`${origin}/collection`);
  await expect(page).toHaveURL(/\/collection$/);
  await expect(page.getByLabel("Email")).toBeVisible();
  await page
    .getByLabel("Email")
    .fill(process.env.OWNER_EMAIL || "owner@example.test");
  await page.getByRole("button", { name: "Send code" }).click();
  await expect.poll(() => messages(mail).length).toBeGreaterThan(before);
  await page
    .getByLabel("Six-digit code")
    .fill(JSON.parse(messages(mail).at(-1)!).otp);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/collection$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("All owned");
}

/** The element's computed styles. The browser's own focus ring colour differs by platform, so an
 * `auto` outline keeps only its style. */
async function computed(locator: Locator): Promise<Styles> {
  return locator.evaluate((element, properties) => {
    const style = getComputedStyle(element);
    const values: Record<string, string> = {};
    for (const property of properties)
      values[property] = style.getPropertyValue(property);
    if (values["outline-style"] === "auto") delete values["outline-color"];
    return values;
  }, PROPERTIES);
}

async function read(entries: Record<string, Locator>): Promise<Look> {
  const look: Look = {};
  for (const [name, locator] of Object.entries(entries)) {
    await expect(locator).toBeVisible();
    look[name] = await computed(locator);
  }
  return look;
}

/** Focuses the element by script and reads it while it shows a focus ring. */
async function focused(locator: Locator): Promise<Styles> {
  await locator.focus();
  await expect(locator).toBeFocused();
  expect(
    await locator.evaluate((element) => element.matches(":focus-visible"))
  ).toBe(true);
  return computed(locator);
}

/** A link with no focus rule of its own, as the first element of the page body (outside every old page)
 * or of the shown page's main region: it shows which focus ring an unstyled element gets there. */
async function addProbeLink(
  page: Page,
  where: "body" | "main"
): Promise<Locator> {
  const name = `Legacy look probe in ${where}`;
  await page.evaluate(
    ([where, name]) => {
      const link = document.createElement("a");
      link.href = "#legacy-look-probe";
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

/** Outside the old pages, base.css's ring: 2 px solid gold, 2 px off. */
async function expectBaseRing(probe: Locator) {
  const ring = await focused(probe);
  expect(ring["outline-style"]).toBe("solid");
  expect(ring["outline-width"]).toBe("2px");
  expect(ring["outline-color"]).toBe(GOLD);
  expect(ring["outline-offset"]).toBe("2px");
}

/** The Decks index on the kit (#181): the dark shell, <html> still at color-scheme normal until stage 7, and
 * base.css's focus ring everywhere, inside the page too, its Deck name field included. */
async function decksLook(page: Page) {
  await signIn(page);
  await page.goto(`${origin}/decks`);
  await expect(
    page.getByRole("heading", { level: 1, name: "Decks" })
  ).toBeVisible();
  const outside = await addProbeLink(page, "body");
  const inside = await addProbeLink(page, "main");
  const input = page.getByRole("textbox", { name: "Deck name" });
  const look = await read({ html: page.locator("html"), input });
  look["input:focus"] = await focused(input);
  await expectBaseRing(outside);
  await expectBaseRing(inside);

  // <html> keeps style.css's light :root until stage 7 (only a mounted Collection darkens it); the shell over it is dark.
  expect(look.html["color-scheme"]).toBe("normal");
  expect(
    await page
      .locator("#root > *")
      .first()
      .evaluate((element) => getComputedStyle(element).backgroundColor)
  ).toBe("rgb(18, 17, 16)");
  expect(look["input:focus"]["outline-style"]).toBe("solid");
  expect(look["input:focus"]["outline-width"]).toBe("2px");
  expect(look["input:focus"]["outline-color"]).toBe(GOLD);
}

async function workspaceLook(page: Page, phone: boolean): Promise<Look> {
  await signIn(page);
  // A fresh document, so nothing has been clicked in it.
  await page.goto(`${origin}/collection`);
  await expect(
    page.getByRole("heading", { level: 1, name: "All owned" })
  ).toBeVisible();
  const outside = await addProbeLink(page, "body");
  // The search sits in the workspace's own header on a phone and in the main region on a desktop.
  const search = page.getByRole("searchbox", { name: "Search cards" });
  const entries: Record<string, Locator> = {
    html: page.locator("html"),
    body: page.locator("body"),
    main: page.getByRole("main"),
    "page heading": page.getByRole("heading", { level: 1, name: "All owned" }),
    search,
  };
  if (phone) {
    const banner = page.getByRole("banner");
    entries.banner = banner;
    entries["open locations"] = banner.getByRole("button", {
      name: "Open locations",
    });
  } else {
    entries.sidebar = page.getByRole("complementary", { name: "Sidebar" });
  }
  const look = await read(entries);
  look["search:focus"] = await focused(search);
  await expectBaseRing(outside);

  expect(look.html["color-scheme"]).toBe("normal");
  expect(look.html["background-color"]).toBe("rgb(18, 17, 16)");
  expect(look["search:focus"]["outline-style"]).toBe("solid");
  expect(look["search:focus"]["outline-width"]).toBe("2px");
  expect(look["search:focus"]["outline-color"]).toBe(GOLD);
  return look;
}

test.describe("at 1280×800", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("the Decks index is on the dark shell, with base.css's focus ring", async ({
    page,
  }) => {
    await decksLook(page);
  });

  test("Collection is dark down to the page, with base.css's focus ring", async ({
    page,
  }) => {
    await workspaceLook(page, false);
  });

  test("themes still switch with data-theme on <html>", async ({ page }) => {
    await signIn(page);
    const html = page.locator("html");
    const root = page.locator("#root > *").first();
    const background = (locator: Locator) =>
      locator.evaluate((element) => getComputedStyle(element).backgroundColor);
    await expect(html).toHaveAttribute("data-theme", "prize-gold");
    // #root's first child is the app shell (#162): dark, on the tokens.
    expect(await background(root)).toBe("rgb(18, 17, 16)");
    expect(
      await root.evaluate((element) => getComputedStyle(element).colorScheme)
    ).toBe("dark");

    await page.addStyleTag({
      content:
        ':root[data-theme="legacy-look-probe"] { --color-bg: rgb(1, 2, 3); --color-text: rgb(4, 5, 6); }',
    });
    await html.evaluate((element) =>
      element.setAttribute("data-theme", "legacy-look-probe")
    );
    expect(await background(html)).toBe("rgb(1, 2, 3)");
    expect(await background(root)).toBe("rgb(1, 2, 3)");
    expect(
      await root.evaluate((element) => getComputedStyle(element).color)
    ).toBe("rgb(4, 5, 6)");

    await html.evaluate((element) =>
      element.setAttribute("data-theme", "prize-gold")
    );
    expect(await background(root)).toBe("rgb(18, 17, 16)");
  });
});

test.describe("at 375×812", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("the Decks index is on the dark shell, with base.css's focus ring", async ({
    page,
  }) => {
    await decksLook(page);
  });

  test("Collection is dark down to the page, with base.css's focus ring", async ({
    page,
  }) => {
    await workspaceLook(page, true);
  });
});
