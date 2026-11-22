import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { startAsNewOwner } from "./support/owner";
import { signInAsOwner } from "./support/sign-in";
import type { Page } from "@playwright/test";
import { test, expect } from "./support/collectors";

const ORIGIN = process.env.TEST_ORIGIN || "http://localhost:5173";

// Headless shell can leave native background tabs uncommitted (even before its
// page event). Observe the trusted DOM event after React's handler instead:
// the browser receives the exact anchor's default action, with no app interception.
async function expectNativeActivation(
  page: Page,
  href: string | null,
  click: () => Promise<unknown>,
  type: "click" | "auxclick" = "click"
) {
  await page.bringToFront();
  const [activation] = await Promise.all([
    page.evaluate(
      (type) =>
        new Promise((resolve) => {
          document.addEventListener(
            type,
            (event) => {
              const target = event.target;
              resolve({
                href:
                  target instanceof Element
                    ? target.closest("a")?.getAttribute("href")
                    : null,
                defaultPrevented: event.defaultPrevented,
                trusted: event.isTrusted,
                button: event.button,
                controlOrMeta: event.ctrlKey || event.metaKey,
              });
            },
            { once: true }
          );
        }),
      type
    ),
    click(),
  ]);
  expect(href).not.toBeNull();
  expect(activation).toEqual({
    href,
    defaultPrevented: false,
    trusted: true,
    button: type === "auxclick" ? 1 : 0,
    controlOrMeta: type === "click",
  });
}
const tabs = (page: Page) =>
  page.getByRole("navigation", { name: "Main views" });
async function locations(page: Page, phone: boolean) {
  if (phone)
    await page
      .getByRole("button", { name: "Open locations", exact: true })
      .click();
  return page.getByRole("navigation", { name: "Locations", exact: true });
}
async function location(
  page: Page,
  name: string,
  parent: string | null = null
) {
  const origin = new URL(page.url()).origin;
  let version: number | null = null;
  if (parent) {
    const tree = await page.request.get(`${origin}/api/location-tree`);
    const body = await tree.json();
    version = body.locations.find(
      (node: { id: string; version: number }) => node.id === parent
    ).version;
  }
  const response = await page.request.post(`${origin}/api/location-tree`, {
    headers: { origin },
    data: {
      name,
      parent_id: parent,
      parent_version: version,
      idempotency_key: randomUUID(),
    },
  });
  expect(response.status()).toBe(201);
  return (await response.json()).location;
}
for (const viewport of [
  { width: 1280, height: 800 },
  { width: 375, height: 812 },
]) {
  const phone = viewport.width === 375;
  test.describe(`navigation links at ${viewport.width}px`, () => {
    test.use({ viewport, hasTouch: phone });
    test.beforeEach(async ({ page }) => {
      const pool = new Pool({ connectionString: process.env.DATABASE_URL });
      try {
        await startAsNewOwner(pool);
      } finally {
        await pool.end();
      }
      await signInAsOwner(page, "/collection");
    });
    test("tabs are links to their remembered addresses", async ({ page }) => {
      for (const [name, href] of [
        ["Decks", "/decks"],
        ["Loans", "/loans"],
        ["Trades", "/trades"],
        ...(!phone ? [["Card reports", "/reports"]] : []),
      ]) {
        await expect(
          tabs(page).getByRole("link", { name: new RegExp(`^${name}(,|$)`) })
        ).toHaveAttribute("href", href);
      }
      const shelf = await location(page, "Remembered shelf");
      await page.goto(`${ORIGIN}/collection?location=${shelf.id}&q=Arven`);
      const collection = tabs(page).getByRole("link", {
        name: "Collection",
        exact: true,
      });
      await expect(collection).toHaveAttribute("aria-current", "page");
      await expect(collection).toHaveAttribute(
        "href",
        `/collection?location=${shelf.id}&q=Arven`
      );
      await tabs(page)
        .getByRole("link", { name: "Catalog", exact: true })
        .click();
      await page
        .getByRole("searchbox", { name: "Search the catalog", exact: true })
        .fill("Pikachu");
      await expect(page).toHaveURL(/q=Pikachu/);
      const catalogAddress =
        new URL(page.url()).pathname + new URL(page.url()).search;
      await collection.click();
      await expect(page).toHaveURL(new RegExp(`location=${shelf.id}&q=Arven`));
      await expect(
        tabs(page).getByRole("link", { name: "Catalog", exact: true })
      ).toHaveAttribute("href", catalogAddress);
    });

    test("Location rows are links; folders stay buttons", async ({ page }) => {
      const folder = await location(page, "Link folder");
      const leaf = await location(page, "Link leaf", folder.id);
      const deckResponse = await page.request.post(`${ORIGIN}/api/decks`, {
        headers: { origin: ORIGIN },
        data: { name: "Link Deck", idempotency_key: randomUUID() },
      });
      expect(deckResponse.status()).toBe(201);
      const deck = (await deckResponse.json()).location;
      await page.goto(`${ORIGIN}/collection?q=Arven`);
      const nav = await locations(page, phone);
      const all = nav.getByRole("link", { name: "All owned", exact: true });
      await expect(all).toHaveAttribute("href", "/collection?q=Arven");
      await expect(all).toHaveAttribute("aria-current", "page");
      const disclosure = nav.getByRole("button", {
        name: folder.name,
        exact: true,
      });
      await disclosure.click();
      await expect(disclosure).toHaveAttribute("aria-expanded", "true");
      await expect(
        nav.getByRole("link", { name: leaf.name, exact: true })
      ).toHaveAttribute("href", `/collection?location=${leaf.id}&q=Arven`);
      await expect(
        nav.getByRole("link", { name: deck.name, exact: true })
      ).toHaveAttribute("href", `/collection?location=${deck.id}&q=Arven`);
    });

    test("a plain click on a tab or row navigates in place; Enter activates and Space does not", async ({
      page,
    }) => {
      const shelf = await location(page, "Keyboard shelf");
      const response = await page.request.post(`${ORIGIN}/api/decks`, {
        headers: { origin: ORIGIN },
        data: { name: "Heading focus Deck", idempotency_key: randomUUID() },
      });
      expect(response.status()).toBe(201);
      const deck = (await response.json()).location;
      await page.reload();
      const nav = await locations(page, phone);
      const row = nav.getByRole("link", { name: shelf.name, exact: true });
      const address = page.url();
      await row.focus();
      await row.press("Space");
      await expect(page).toHaveURL(address);
      await row.press("Enter");
      await expect(page).toHaveURL(`${ORIGIN}/collection?location=${shelf.id}`);
      const selected = (await locations(page, phone)).getByRole("link", {
        name: shelf.name,
        exact: true,
      });
      await expect(selected).toHaveAttribute("aria-current", "page");
      if (phone)
        await page
          .getByRole("button", { name: "Close locations", exact: true })
          .click();
      const decks = tabs(page).getByRole("link", {
        name: "Decks",
        exact: true,
      });
      await decks.focus();
      await decks.press("Space");
      await expect(page).toHaveURL(`${ORIGIN}/collection?location=${shelf.id}`);
      await decks.press("Enter");
      await expect(page).toHaveURL(`${ORIGIN}/decks`);
      await expect(decks).toHaveAttribute("aria-current", "page");
      await page
        .getByRole("navigation", { name: "Deck index" })
        .getByRole("link", { name: deck.name, exact: true })
        .click();
      await expect(
        page.getByRole("heading", { level: 1, name: deck.name, exact: true })
      ).toBeFocused();
      await tabs(page)
        .getByRole("link", { name: "Collection", exact: true })
        .click();
      const all = (await locations(page, phone)).getByRole("link", {
        name: "All owned",
        exact: true,
      });
      await all.click();
      await expect(page).toHaveURL(`${ORIGIN}/collection`);
    });

    if (!phone) {
      test("a ctrl or cmd click keeps native tab or row activation and leaves this page", async ({
        page,
      }) => {
        const shelf = await location(page, "New tab shelf");
        await page.reload();
        const address = page.url();
        for (const link of [
          tabs(page).getByRole("link", { name: "Catalog", exact: true }),
          (await locations(page, false)).getByRole("link", {
            name: shelf.name,
            exact: true,
          }),
        ]) {
          const href = await link.getAttribute("href");
          await expectNativeActivation(page, href, () =>
            link.click({ modifiers: ["ControlOrMeta"] })
          );
          await expect(page).toHaveURL(address);
          await expect(page.getByRole("dialog")).toHaveCount(0);
          await page.bringToFront();
        }
      });
      test("a real middle click keeps native tab activation and leaves this page", async ({
        page,
      }) => {
        const address = page.url();
        await expectNativeActivation(
          page,
          "/catalog",
          () =>
            page.click('nav[aria-label="Main views"] a[href="/catalog"]', {
              button: "middle",
            }),
          "auxclick"
        );
        await expect(page).toHaveURL(address);
      });
      test("All Decks keeps native activation on a modified click", async ({
        page,
      }) => {
        const response = await page.request.post(`${ORIGIN}/api/decks`, {
          headers: { origin: ORIGIN },
          data: { name: "New page Deck", idempotency_key: randomUUID() },
        });
        expect(response.status()).toBe(201);
        const deck = (await response.json()).location;
        await page.goto(`${ORIGIN}/decks/${deck.id}`);
        const address = page.url();
        const allDecks = page.getByRole("link", {
          name: "All Decks",
          exact: true,
        });
        await expect(allDecks).toHaveAttribute("href", "/decks");
        await expectNativeActivation(page, "/decks", () =>
          allDecks.click({ modifiers: ["ControlOrMeta"] })
        );
        await expect(page).toHaveURL(address);
      });
    }
  });
}
