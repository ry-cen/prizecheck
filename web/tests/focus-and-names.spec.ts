import type { Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { expect, test } from "./support/collectors";
import {
  api,
  hold,
  ORIGIN,
  seedCatalog,
  unsorted,
  befriend,
  nameCollector,
} from "./support/loans";
import { signInAsOwner } from "./support/sign-in";

test.describe("phone", () => {
  test.use({
    viewport: { width: 375, height: 812 },
    isMobile: true,
    hasTouch: true,
  });
  for (const kind of ["Move", "Remove"] as const) {
    test(`focus goes to the Collection heading after a tapped ${kind} from the details sheet`, async ({
      page,
    }) => {
      const ids = seedCatalog();
      await signInAsOwner(page, "/collection");
      const source = (
        await api(page, "POST", "/api/decks", {
          name: `Source ${randomUUID()}`,
          idempotency_key: randomUUID(),
        })
      ).location.id;
      await hold(page, source, ids["PAL 185"], 1);
      await page.goto(`${ORIGIN}/collection?location=${source}`);
      await page
        .getByRole("region", { name: "Cards", exact: true })
        .getByRole("button", { name: /Iono/ })
        .first()
        .tap();
      await page
        .getByRole("dialog")
        .getByRole("button", { name: `${kind}…`, exact: true })
        .tap();
      const dialog = page.getByRole("dialog").last();
      if (kind === "Move")
        await dialog
          .getByRole("button", { name: "Unsorted", exact: true })
          .tap();
      await dialog
        .getByRole("button", { name: `${kind} 1 copy`, exact: true })
        .tap();
      await expect(
        page.getByRole("region", { name: "Notifications" })
      ).toContainText(kind === "Move" ? "Moved 1 copy" : "Removed 1 copy");
      await expect(page.locator("#ws-heading")).toBeFocused();
      await expect(
        page
          .getByRole("region", { name: "Cards", exact: true })
          .getByRole("button", { name: /Iono/ })
      ).toHaveCount(0);
      await expect(page.getByRole("main")).toContainText(
        "0 copies · 0 editions"
      );
      await expect
        .poll(() => page.evaluate(() => document.activeElement?.id))
        .toBe("ws-heading");
    });
  }
});

for (const [label, options] of [
  ["desktop", { viewport: { width: 1280, height: 800 } }],
  [
    "phone",
    { viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true },
  ],
] as const) {
  test.describe(label, () => {
    test.use(options);
    test("a closed card dialog keeps no Loading card details status", async ({
      page,
    }) => {
      seedCatalog();
      await signInAsOwner(page, "/catalog?q=Iono");
      for (const surface of ["Catalog", "Add cards"]) {
        if (surface === "Add cards") {
          await page.goto(`${ORIGIN}/collection`);
          await page
            .getByRole("button", { name: "Add cards", exact: true })
            .click();
        }
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        await page.route("**/api/catalog/printings/*", async (route) => {
          await gate;
          await route.continue();
        });
        const results = page.getByRole("region", { name: "Catalog results" });
        await results.getByRole("button", { name: /Iono/ }).first().click();
        const loading = page
          .getByRole("status")
          .filter({ hasText: "Loading card details…" });
        await expect(loading).toBeVisible();
        release();
        await expect(
          page.getByRole("button", { name: "Close card details", exact: true })
        ).toBeVisible();
        await expect(loading).toHaveCount(0);
        await page.keyboard.press("Escape");
        await test.info().attach(`${surface}-closed-aria`, {
          body: await page.locator("body").ariaSnapshot(),
          contentType: "text/plain",
        });
        await test.info().attach(`${surface}-closed-status`, {
          body: JSON.stringify(
            await page.getByRole("status").allTextContents()
          ),
          contentType: "application/json",
        });
        await expect(
          page.locator('[role="status"]', { hasText: "Loading card details…" })
        ).toHaveCount(0);
        await page.unroute("**/api/catalog/printings/*");
      }
    });
  });
}

async function setupCopy(page: Page) {
  const ids = seedCatalog();
  await signInAsOwner(page, "/collection");
  const source = (
    await api(page, "POST", "/api/decks", {
      name: `Focus ${randomUUID()}`,
      idempotency_key: randomUUID(),
    })
  ).location.id;
  await hold(page, source, ids["PAL 185"], 1);
  await page.goto(`${ORIGIN}/collection?location=${source}`);
  return page
    .getByRole("region", { name: "Cards", exact: true })
    .getByRole("button", { name: /Iono/ })
    .first();
}

test.describe("phone action lifecycle", () => {
  test.use({
    viewport: { width: 375, height: 812 },
    isMobile: true,
    hasTouch: true,
  });
  for (const kind of ["Move", "Remove"] as const) {
    test(`cancelling ${kind} returns focus to the sheet opener`, async ({
      page,
    }) => {
      await (await setupCopy(page)).tap();
      const opener = page
        .getByRole("dialog")
        .getByRole("button", { name: `${kind}…`, exact: true });
      await opener.tap();
      await page.keyboard.press("Escape");
      await expect(opener).toBeFocused();
    });
    test(`a failed ${kind} keeps focus in its dialog`, async ({ page }) => {
      await (await setupCopy(page)).tap();
      await page
        .getByRole("dialog")
        .getByRole("button", { name: `${kind}…`, exact: true })
        .tap();
      const dialog = page.getByRole("dialog").last();
      if (kind === "Move")
        await dialog
          .getByRole("button", { name: "Unsorted", exact: true })
          .tap();
      await page.route("**/api/moves/manifests", (route) =>
        route.fulfill({ status: 503, json: { detail: "Unavailable" } })
      );
      await dialog
        .getByRole("button", { name: `${kind} 1 copy`, exact: true })
        .tap();
      await expect(dialog.getByRole("alert")).toBeVisible();
      await expect(page.locator("#ws-heading")).not.toBeFocused();
      await expect
        .poll(() =>
          dialog.evaluate((node) => node.contains(document.activeElement))
        )
        .toBe(true);
    });
  }
  test("keyboard Move focuses the heading", async ({ page }) => {
    const tile = await setupCopy(page);
    await tile.focus();
    await page.keyboard.press("Enter");
    const move = page
      .getByRole("dialog")
      .getByRole("button", { name: "Move…", exact: true });
    await page.keyboard.press("Tab");
    await expect(move).toBeFocused();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog").last();
    await dialog.getByRole("button", { name: "Unsorted", exact: true }).focus();
    await page.keyboard.press("Enter");
    await dialog
      .getByRole("button", { name: "Move 1 copy", exact: true })
      .focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#ws-heading")).toBeFocused();
    await expect(tile).toHaveCount(0);
    await expect(page.getByRole("main")).toContainText("0 copies · 0 editions");
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.id))
      .toBe("ws-heading");
  });
});

test.describe("desktop action", () => {
  test.use({ viewport: { width: 1280, height: 800 } });
  test("Actions Move still focuses the heading", async ({ page }) => {
    await (await setupCopy(page)).click();
    const selection = page.getByRole("region", { name: "Selection" });
    await selection
      .getByRole("button", { name: "Actions", exact: true })
      .click();
    await selection.getByRole("button", { name: "Move…", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Unsorted", exact: true }).click();
    await dialog
      .getByRole("button", { name: "Move 1 copy", exact: true })
      .click();
    await expect(page.locator("#ws-heading")).toBeFocused();
  });
});

for (const [label, options] of [
  ["desktop names", { viewport: { width: 1280, height: 800 } }],
  [
    "phone names",
    { viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true },
  ],
] as const) {
  test.describe(label, () => {
    test.use(options);
    test("Friend Collection and Catalog distinguish borrow names by finish; Find trades names only the collector", async ({
      page,
      collectors,
    }) => {
      const ids = seedCatalog();
      const friend = (
        await collectors.signIn({
          next: "/collection",
          contextOptions: options,
        })
      ).page;
      await nameCollector(friend, "Misty W");
      const handle = (await api(friend, "GET", "/api/profile")).handle;
      await hold(friend, await unsorted(friend), ids["PAL 172"], 2);
      await hold(
        friend,
        await unsorted(friend),
        ids["PAL 172 Reverse Holo"],
        2
      );
      await signInAsOwner(page, "/collection");
      await befriend(page, friend);
      await page.goto(`${ORIGIN}/friends/${handle}`);
      await page
        .getByRole("button", { name: "All cards", exact: true })
        .click();
      for (const suffix of ["", ", Reverse Holo"]) {
        await expect(
          page.getByRole("button", {
            name: `Ask to borrow Boss's Orders from Misty W (PAL 172${suffix})`,
            exact: true,
          })
        ).toHaveCount(1);
      }
      await page.goto(`${ORIGIN}/catalog?q=Boss`);
      await page
        .getByRole("region", { name: "Catalog results" })
        .getByRole("button", { name: /Boss's Orders, PAL 172/ })
        .first()
        .click();
      const friends = page.getByRole("list", { name: "Friends who have this" });
      for (const suffix of ["", ", Reverse Holo"]) {
        await expect(
          friends.getByRole("button", {
            name: `Ask to borrow Boss's Orders from Misty W (PAL 172${suffix})`,
            exact: true,
          })
        ).toHaveCount(1);
      }
      await page.keyboard.press("Escape");
      const location = await api(friend, "POST", "/api/location-tree", {
        name: `Trades ${randomUUID()}`,
        parent_id: null,
        parent_version: null,
        idempotency_key: randomUUID(),
      });
      await api(
        friend,
        "PUT",
        `/api/location-tree/${location.location.id}/for-trade`,
        {
          for_trade: true,
          version: location.location.version,
          idempotency_key: randomUUID(),
        }
      );
      await hold(friend, location.location.id, ids["PAL 185"], 1);
      await api(page, "PUT", `/api/trade-wants/${ids["PAL 185"]}`, {
        quantity: "1",
      });
      await page.goto(`${ORIGIN}/trades`);
      await page.getByRole("tab", { name: "Find trades", exact: true }).click();
      await expect(
        page.getByRole("heading", { level: 3, name: "Misty W", exact: true })
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Misty W", exact: true })
      ).toHaveAccessibleDescription(/Misty W has 1 card you want/);
    });
  });
}

test.describe("completion ordering", () => {
  test.use({
    viewport: { width: 375, height: 812 },
    isMobile: true,
    hasTouch: true,
  });
  test("navigation away while Move settles does not steal focus", async ({
    page,
  }) => {
    await (await setupCopy(page)).tap();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Move…", exact: true })
      .tap();
    const dialog = page.getByRole("dialog").last();
    await dialog.getByRole("button", { name: "Unsorted", exact: true }).tap();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const request = new Promise<void>((resolve) => {
      started = resolve;
    });
    await page.route("**/api/moves/manifests/*/commit", async (route) => {
      const response = await route.fetch();
      started();
      await gate;
      await route.fulfill({ response });
    });
    await dialog
      .getByRole("button", { name: "Move 1 copy", exact: true })
      .tap();
    await request;
    await page.evaluate(() => {
      history.pushState(null, "", "/catalog");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    const heading = page.getByRole("heading", {
      level: 1,
      name: "Catalog",
      exact: true,
    });
    await expect(heading).toBeVisible();
    const search = page.getByRole("searchbox", { name: "Search the catalog" });
    await search.focus();
    const settled = page.waitForResponse("**/api/moves/manifests/*/commit");
    release();
    await settled;
    await expect(search).toBeFocused();
    await expect(page.locator("#ws-heading")).not.toBeFocused();
  });
});
