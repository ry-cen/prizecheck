import { expect, type Page, type Locator } from "@playwright/test";
import { test } from "./support/art-upstream";
const origin = process.env.TEST_ORIGIN || "http://127.0.0.1:5173";
const entry = `${origin}/src/games/riftbound/local/index.html`;
const fixturePath = "/src/games/riftbound/local/collectionFixtures.ts";
const collectionHash = "#riftbound:section=collection";
async function inspect(page: Page, owner = "a", scenario = "normal") {
  return page.evaluate(
    async ({ path, owner, scenario }) => {
      const module = await import(path);
      const store = module.collectionFixtureStore(owner, scenario);
      return {
        revision: store.revision,
        rows: store.rows.map(
          (r: {
            edition: { id: string };
            locationId: string;
            quantity: number;
          }) => ({
            editionId: r.edition.id,
            locationId: r.locationId,
            quantity: r.quantity,
          })
        ),
      };
    },
    { path: fixturePath, owner, scenario }
  );
}
for (const width of [1280, 375]) {
  test(`fixture write confirmations, Add duplication, Undo and keyboard at ${width}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: width === 375 ? 812 : 800 });
    const calls: string[] = [];
    page.on("request", (request) => {
      if (/^\/(api|auth)(\/|$)/.test(new URL(request.url()).pathname))
        calls.push(request.url());
    });
    await page.addInitScript(() =>
      localStorage.setItem(
        "prizecheck:workspace:preferences:v1:1",
        "wp2-sentinel"
      )
    );
    await page.goto(entry);
    const catalog = page.getByRole("region", { name: "Catalog results" });
    const tile = catalog.getByRole("button", {
      name: "Ember Scout, FL 001, Standard",
      exact: true,
    });
    await expect(tile).toBeVisible();
    const before = await inspect(page);
    const otherBefore = await inspect(page, "b");
    await tile.focus();
    await page.keyboard.press("Enter");
    await page
      .getByRole("button", { name: "Add to Collection", exact: true })
      .focus();
    await page.keyboard.press("Enter");
    const add = page.getByRole("dialog", {
      name: "Add to Collection",
      exact: true,
    });
    await expect(add.getByRole("combobox", { name: "Location" })).toHaveValue(
      "1"
    );
    const addShot = info.outputPath(`add-${width}.png`);
    await page.screenshot({ path: addShot });
    await info.attach("Add dialog", {
      path: addShot,
      contentType: "image/png",
    });
    // Dispatch two native clicks in one turn, before React can commit disabled state.
    await add
      .getByRole("button", { name: "Add 1 copy", exact: true })
      .evaluate((button) => {
        (button as HTMLButtonElement).click();
        (button as HTMLButtonElement).click();
      });
    const notifications = page.getByRole("region", { name: "Notifications" });
    await expect(notifications).toContainText("Added 1 copy to Unsorted");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(tile).toBeFocused();
    await expect(
      notifications.getByRole("button", { name: "Undo", exact: true })
    ).toHaveCount(0);
    const after = await inspect(page);
    expect(after.revision).toBe(before.revision + 1);
    expect(after.rows[0].quantity).toBe(before.rows[0].quantity + 1);
    await page.keyboard.press("Escape");
    const nav = page.getByRole("navigation", {
      name: width === 375 ? "Mobile navigation" : "Main navigation",
    });
    await nav.getByRole("button", { name: "Collection", exact: true }).click();
    const results = page.getByRole("region", { name: "Collection results" });
    await expect(results.getByRole("listitem")).toHaveCount(24);
    await expect(
      results.getByRole("button", {
        name: "Ember Scout, FL 001, Standard, Unsorted",
        exact: true,
      })
    ).toHaveCount(4);
    const copy = results.getByRole("button").first();
    await copy.focus();
    await page.keyboard.press("Enter");
    if (width === 1280) {
      await expect(
        page.getByText("1 copy selected", { exact: true })
      ).toBeVisible();
      const lastRow = page
        .getByRole("complementary", { name: "Card details" })
        .getByText("Binders / Blue binder · 2", { exact: true });
      await expect(lastRow).toBeVisible();
      await lastRow.scrollIntoViewIfNeeded();
      const rowBox = await lastRow.boundingBox();
      const pillBox = await page
        .locator('[aria-label="Selected copies"]')
        .boundingBox();
      expect(
        rowBox &&
          pillBox &&
          (rowBox.y + rowBox.height <= pillBox.y ||
            rowBox.x >= pillBox.x + pillBox.width ||
            rowBox.x + rowBox.width <= pillBox.x)
      ).toBe(true);
      const selectionShot = info.outputPath("selection-desktop.png");
      await page.screenshot({ path: selectionShot });
      await info.attach("Selection bar", {
        path: selectionShot,
        contentType: "image/png",
      });
      await page.getByRole("button", { name: "Actions", exact: true }).focus();
      await page.keyboard.press("Enter");
      await page.keyboard.press("Enter");
    } else {
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Move…", exact: true })
        .focus();
      await page.keyboard.press("Enter");
    }
    const move = page.getByRole("dialog", { name: "Move 1 copy", exact: true });
    await expect(page.getByRole("dialog")).toHaveCount(1);
    await move.getByRole("combobox", { name: "Location" }).selectOption("5");
    await expect(move).toContainText("To Empty binder");
    if (width === 1280) {
      const path = info.outputPath("move-desktop.png");
      await page.screenshot({ path });
      await info.attach("Move dialog", { path, contentType: "image/png" });
    }
    await move
      .getByRole("button", { name: "Move 1 copy", exact: true })
      .focus();
    await page.keyboard.press("Enter");
    await expect(notifications).toContainText("Moved 1 copy to Empty binder");
    await expect(
      page.getByRole("heading", { name: "All owned", exact: true })
    ).toBeFocused();
    if (width === 375) {
      await expect(results.getByRole("listitem")).toHaveCount(24);
      const path = info.outputPath("undo-phone.png");
      await page.screenshot({ path });
      await info.attach("Undo toast", { path, contentType: "image/png" });
    }
    await notifications
      .getByRole("button", { name: "Undo", exact: true })
      .click();
    await expect(notifications).toContainText("Undone");
    await expect
      .poll(async () => (await inspect(page)).rows[0].quantity)
      .toBe(after.rows[0].quantity);
    await copy.click();
    if (width === 1280) {
      await page.getByRole("button", { name: "Actions", exact: true }).click();
      await page
        .getByRole("menuitem", { name: "Remove…", exact: true })
        .click();
    } else
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Remove…", exact: true })
        .click();
    const remove = page.getByRole("dialog", {
      name: "Remove 1 copy from your Collection",
      exact: true,
    });
    await expect(remove).toBeVisible();
    expect((await inspect(page)).rows[0].quantity).toBe(after.rows[0].quantity);
    await remove
      .getByRole("button", { name: "Remove 1 copy", exact: true })
      .click();
    await expect(notifications).toContainText(
      "Removed 1 copy from your Collection"
    );
    await notifications
      .getByRole("button", { name: "Undo", exact: true })
      .click();
    await expect(notifications).toContainText("Undone");
    await expect
      .poll(async () => (await inspect(page)).rows[0].quantity)
      .toBe(after.rows[0].quantity);
    if (width === 375) {
      await copy.focus();
      const bounds = await copy.boundingBox();
      const tabs = await nav.boundingBox();
      expect(bounds && tabs && bounds.y + bounds.height <= tabs.y).toBe(true);
    }
    expect(await inspect(page, "b")).toEqual(otherBefore);
    expect(
      await page.evaluate(() =>
        localStorage.getItem("prizecheck:workspace:preferences:v1:1")
      )
    ).toBe("wp2-sentinel");
    expect(calls).toEqual([]);
  });
  test(`stale retry has one dialog and write failure retries at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 375 ? 812 : 800 });
    await page.goto(`${entry}?collection=stale${collectionHash}`);
    const results = page.getByRole("region", { name: "Collection results" });
    await results.getByRole("button").first().click();
    if (width === 1280) {
      await page.getByRole("button", { name: "Actions", exact: true }).click();
      await page.getByRole("menuitem", { name: "Move…", exact: true }).click();
    } else
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Move…", exact: true })
        .click();
    const move = page.getByRole("dialog", { name: "Move 1 copy", exact: true });
    await move.getByRole("combobox", { name: "Location" }).selectOption("5");
    await move
      .getByRole("button", { name: "Move 1 copy", exact: true })
      .click();
    await expect(move.getByRole("alert")).toContainText("These cards changed");
    await expect(page.getByRole("dialog")).toHaveCount(1);
    await expect(
      page.getByRole("region", { name: "Notifications" })
    ).not.toContainText("Moved");
    await move.getByRole("button", { name: "Reload and retry" }).click();
    await expect(
      page.getByRole("region", { name: "Notifications" })
    ).toContainText("Moved 1 copy");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    const moved = await inspect(page, "a", "stale");
    expect(moved.revision).toBe(2);
    expect(
      moved.rows.find(
        (r) => r.editionId === moved.rows[0].editionId && r.locationId === "1"
      )?.quantity
    ).toBe(2);
    expect(
      moved.rows.filter((r) => r.locationId === "5").map((r) => r.quantity)
    ).toEqual([1]);
    await page.goto(`${entry}?collection=write-failure`);
    await page.evaluate(async (path) => {
      const module = await import(path);
      const writer = module.collectionFixtureWriter("a", "write-failure");
      const original = writer.add;
      const keys: string[] = [];
      writer.add = (input: unknown, options: { idempotencyKey: string }) => {
        keys.push(options.idempotencyKey);
        return original(input, options);
      };
      // Test-only receipt kept on the fixture module, never the production window.
      module.collectionFixtureStore("a", "write-failure").testKeys = keys;
    }, fixturePath);
    await page
      .getByRole("button", {
        name: "Ember Scout, FL 001, Standard",
        exact: true,
      })
      .click();
    await page
      .getByRole("button", { name: "Add to Collection", exact: true })
      .click();
    const add = page.getByRole("dialog", {
      name: "Add to Collection",
      exact: true,
    });
    await add.getByRole("button", { name: "Add 1 copy", exact: true }).click();
    await expect(add.getByRole("alert")).toContainText("couldn't be saved");
    expect((await inspect(page, "a", "write-failure")).revision).toBe(1);
    await add.getByRole("button", { name: "Add 1 copy", exact: true }).click();
    await expect(
      page.getByRole("region", { name: "Notifications" })
    ).toContainText("Added 1 copy");
    expect((await inspect(page, "a", "write-failure")).revision).toBe(2);
    const keys = await page.evaluate(async (path) => {
      const module = await import(path);
      return module.collectionFixtureStore("a", "write-failure").testKeys;
    }, fixturePath);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });
  test(`slow write navigation and newest-only Undo at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 375 ? 812 : 800 });
    await page.goto(`${entry}?collection=write-slow`);
    await page
      .getByRole("button", {
        name: "Ember Scout, FL 001, Standard",
        exact: true,
      })
      .click();
    await page
      .getByRole("button", { name: "Add to Collection", exact: true })
      .click();
    await page
      .getByRole("dialog", { name: "Add to Collection", exact: true })
      .getByRole("button", { name: "Add 1 copy", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Saving…", exact: true })
    ).toBeDisabled();
    await page.evaluate((hash) => {
      location.hash = hash;
    }, collectionHash);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(
      page
        .getByRole("region", { name: "Collection results" })
        .getByRole("listitem")
    ).toHaveCount(24);
    await page.clock.install();
    await page.clock.fastForward(3000);
    await expect(
      page.getByRole("region", { name: "Notifications" })
    ).not.toContainText("Added");
    expect((await inspect(page, "a", "write-slow")).revision).toBe(1);
    // A previous Undo is intentionally not exposed by the one-toast UI. Exercise its game-owned contract here.
    const code = await page.evaluate(async (path) => {
      const module = await import(path);
      const writer = module.collectionFixtureWriter("a");
      const store = module.collectionFixtureStore("a");
      const options = () => ({
        signal: new AbortController().signal,
        idempotencyKey: crypto.randomUUID(),
      });
      const item = () => ({
        editionId: store.rows[0].edition.id,
        sourceId: "1",
        quantity: 1,
        expectedVersion: store.rows[0].version,
      });
      const old = await writer.remove({ items: [item()] }, options());
      await writer.remove({ items: [item()] }, options());
      try {
        await writer.undo(old.undo.id, options());
      } catch (error) {
        return (error as { code: string }).code;
      }
      return "unexpected-success";
    }, fixturePath);
    expect(code).toBe("UNDO_NOT_NEWEST");
  });
}

// Each Tab is a deliberate navigation step, rather than a timed polling loop.
async function tabTo(page: Page, target: Locator) {
  for (let step = 0; step < 60; step++) {
    if (await target.evaluate((element) => element === document.activeElement))
      return;
    await page.keyboard.press("Tab");
  }
  await expect(target).toBeFocused();
}
for (const width of [1280, 375]) {
  test(`keyboard-only Move and Undo at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 375 ? 812 : 800 });
    await page.goto(`${entry}${collectionHash}`);
    const tile = page
      .getByRole("region", { name: "Collection results" })
      .getByRole("button")
      .first();
    await tile.focus();
    await page.keyboard.press("Enter");
    if (width === 1280) {
      await tabTo(
        page,
        page.getByRole("button", { name: "Actions", exact: true })
      );
      await page.keyboard.press("Enter");
      await page.keyboard.press("Enter");
    } else {
      await tabTo(
        page,
        page
          .getByRole("dialog")
          .getByRole("button", { name: "Move…", exact: true })
      );
      await page.keyboard.press("Enter");
    }
    const move = page.getByRole("dialog", { name: "Move 1 copy", exact: true });
    await tabTo(page, move.getByRole("combobox", { name: "Location" }));
    await page.keyboard.press("End");
    await expect(move.getByRole("combobox", { name: "Location" })).toHaveValue(
      "5"
    );
    await tabTo(
      page,
      move.getByRole("button", { name: "Move 1 copy", exact: true })
    );
    await page.keyboard.press("Enter");
    const notifications = page.getByRole("region", { name: "Notifications" });
    await expect(notifications).toContainText("Moved 1 copy to Empty binder");
    await expect(
      page.getByRole("heading", { name: "All owned", exact: true })
    ).toBeFocused();
    await tabTo(
      page,
      notifications.getByRole("button", { name: "Undo", exact: true })
    );
    await page.keyboard.press("Enter");
    await expect(notifications).toContainText("Undone");
  });
}

for (const width of [1280, 375]) {
  test(`Move and Remove cancellation preserve selection and Actions focus at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 375 ? 812 : 800 });
    await page.goto(`${entry}${collectionHash}`);
    const results = page.getByRole("region", { name: "Collection results" });
    await results.getByRole("button").first().click();
    if (width === 375) {
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Move…", exact: true })
        .click();
    } else {
      await page.getByRole("button", { name: "Actions", exact: true }).click();
      await page.getByRole("menuitem", { name: "Move…", exact: true }).click();
    }
    await expect(
      page.getByRole("dialog", { name: "Move 1 copy", exact: true })
    ).toBeVisible();
    await page.keyboard.press("Escape");
    const actions = page.getByRole("button", { name: "Actions", exact: true });
    await expect(actions).toBeFocused();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(results.locator('button[aria-pressed="true"]')).toHaveCount(1);
    await page.keyboard.press("Enter");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    const remove = page.getByRole("dialog", {
      name: "Remove 1 copy from your Collection",
      exact: true,
    });
    await expect(remove).toBeVisible();
    await remove.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(actions).toBeFocused();
    await expect(results.locator('button[aria-pressed="true"]')).toHaveCount(1);
    expect((await inspect(page)).revision).toBe(1);
    if (width === 375) {
      const box = await page
        .locator('[aria-label="Selected copies"]')
        .boundingBox();
      const tabs = await page
        .getByRole("navigation", { name: "Mobile navigation" })
        .boundingBox();
      expect(box && tabs && box.y + box.height <= tabs.y).toBe(true);
    }
  });
  test(`slow Undo survives Location navigation at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 375 ? 812 : 800 });
    await page.goto(`${entry}?collection=write-slow${collectionHash}`);
    await page
      .getByRole("region", { name: "Collection results" })
      .getByRole("button")
      .first()
      .click();
    if (width === 375)
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Remove…", exact: true })
        .click();
    else {
      await page.getByRole("button", { name: "Actions", exact: true }).click();
      await page
        .getByRole("menuitem", { name: "Remove…", exact: true })
        .click();
    }
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Remove 1 copy", exact: true })
      .click();
    const toast = page.getByRole("region", { name: "Notifications" });
    await expect(toast).toContainText("Removed 1 copy");
    await toast.getByRole("button", { name: "Undo", exact: true }).click();
    await page.evaluate(() => {
      location.hash = "#riftbound:section=collection&location=5";
    });
    await expect(
      page.getByRole("heading", { name: "Empty binder", exact: true })
    ).toBeVisible();
    await expect(toast).toContainText("Undone");
    const restored = await inspect(page, "a", "write-slow");
    expect(restored.revision).toBe(3);
    expect(restored.rows[0].quantity).toBe(3);
  });
}
