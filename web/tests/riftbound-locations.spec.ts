import { expect, type Page } from "@playwright/test";
import { test } from "./support/art-upstream";
const origin = process.env.TEST_ORIGIN || "http://127.0.0.1:5173";
const entry = `${origin}/src/games/riftbound/local/index.html`;
const path = "/src/games/riftbound/local/collectionFixtures.ts";
async function inspect(page: Page, owner = "a", scenario = "normal") {
  return page.evaluate(
    async ({ path, owner, scenario }) => {
      const m = await import(path);
      return structuredClone(m.collectionFixtureStore(owner, scenario));
    },
    { path, owner, scenario }
  );
}
for (const width of [1280, 375]) {
  test(`ordinary fixture Location management at ${width}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: width === 375 ? 812 : 800 });
    const calls: string[] = [];
    page.on("request", (r) => {
      if (/^\/(api|auth)(\/|$)/.test(new URL(r.url()).pathname))
        calls.push(r.url());
    });
    await page.addInitScript(() =>
      localStorage.setItem(
        "prizecheck:workspace:preferences:v1:1",
        "wp3-sentinel"
      )
    );
    await page.goto(`${entry}#riftbound:section=collection`);
    const phone = width === 375;
    const drawer = page.getByRole("dialog", { name: "Locations", exact: true });
    const openNav = async () => {
      if (phone && !(await drawer.isVisible()))
        await page
          .getByRole("button", { name: "Locations", exact: true })
          .click();
    };
    const nav = () =>
      phone
        ? drawer
        : page.locator("aside").filter({
            has: page.getByRole("navigation", {
              name: "Locations",
              exact: true,
            }),
          });
    const dialog = page.getByRole("dialog", {
      name: "Create location",
      exact: true,
    });
    const settings = page.getByRole("dialog", {
      name: "Location settings",
      exact: true,
    });
    await openNav();
    await expect(
      nav().getByRole("button", { name: "Create location", exact: true })
    ).toBeVisible();
    const other = await inspect(page, "b");
    const shot = async (name: string) => {
      const filename = info.outputPath(`${name}-${width}.png`);
      await page.screenshot({ path: filename });
      await info.attach(name, { path: filename, contentType: "image/png" });
    };
    if (!phone)
      await nav()
        .getByRole("button", { name: "Empty binder", exact: true })
        .hover();
    await shot(phone ? "phone-drawer-tools" : "desktop-sidebar-tools");
    const create = async (name: string, parent = "") => {
      await openNav();
      await nav()
        .getByRole("button", { name: "Create location", exact: true })
        .click();
      await dialog
        .getByRole("textbox", { name: "Name", exact: true })
        .fill(name);
      await dialog
        .getByRole("combobox", { name: "Parent", exact: true })
        .selectOption(parent);
      await dialog
        .getByRole("button", { name: "Create location", exact: true })
        .click();
      await expect(dialog).toHaveCount(0);
    };
    await nav()
      .getByRole("button", { name: "Create location", exact: true })
      .focus();
    await page.keyboard.press("Enter");
    await dialog
      .getByRole("textbox", { name: "Name", exact: true })
      .fill("Travel box");
    await shot(phone ? "phone-create" : "desktop-create");
    await page.keyboard.press("Escape");
    await expect(
      nav().getByRole("button", { name: "Create location", exact: true })
    ).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(
      dialog.getByRole("textbox", { name: "Name", exact: true })
    ).toBeFocused();
    await page.keyboard.type("Travel box");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    await expect(dialog).toHaveCount(0);
    await expect(
      nav().getByRole("button", { name: "Create location", exact: true })
    ).toBeFocused();
    await create("Spare sleeves", "2");
    await openNav();
    await nav().getByRole("button", { name: "Binders", exact: true }).click();
    await nav()
      .getByRole("button", {
        name: "Add child location to Binders / Blue binder",
        exact: true,
      })
      .click();
    await expect(dialog.getByRole("combobox", { name: "Parent" })).toHaveValue(
      "3"
    );
    await dialog
      .getByRole("textbox", { name: "Name", exact: true })
      .fill("Blue pages");
    await dialog.getByRole("radio").check();
    await dialog
      .getByRole("button", { name: "Create location", exact: true })
      .click();
    await expect(dialog).toHaveCount(0);
    await expect(
      nav().getByRole("button", {
        name: "Add child location to Binders / Blue binder",
        exact: true,
      })
    ).toBeFocused();
    const converted = await inspect(page);
    const child = converted.locations.find(
      (n: { name: string }) => n.name === "Blue pages"
    );
    expect(
      converted.rows.some((r: { locationId: string }) => r.locationId === "3")
    ).toBe(false);
    expect(
      converted.rows.some(
        (r: { locationId: string }) => r.locationId === child.id
      )
    ).toBe(true);
    await openNav();
    await nav()
      .getByRole("button", { name: "Travel box", exact: true })
      .click();
    await openNav();
    await nav()
      .getByRole("button", { name: "Settings for Travel box", exact: true })
      .click();
    await shot("settings");
    await settings.getByRole("button", { name: "Rename", exact: true }).click();
    await settings.getByRole("textbox", { name: "New name" }).fill("Binders");
    await settings.getByRole("button", { name: "Save name" }).click();
    await expect(settings.getByRole("alert")).toContainText(
      "A sibling already has that name."
    );
    await settings
      .getByRole("textbox", { name: "New name" })
      .fill("Journey box");
    await settings.getByRole("button", { name: "Save name" }).click();
    await expect(settings).toHaveCount(0);
    await expect(
      nav().getByRole("button", {
        name: "Settings for Journey box",
        exact: true,
      })
    ).toBeFocused();
    await openNav();
    if (phone && (await drawer.isVisible()))
      await page.keyboard.press("Escape");
    await expect(
      page.getByRole("heading", { name: "Journey box", exact: true })
    ).toBeVisible();
    await openNav();
    await nav()
      .getByRole("button", { name: "Settings for Binders", exact: true })
      .click();
    await settings.getByRole("button", { name: "Move", exact: true }).click();
    await expect(
      settings.getByRole("combobox").locator('option[value="2"]')
    ).toHaveCount(0);
    await expect(
      settings.getByRole("combobox").locator('option[value="3"]')
    ).toHaveCount(0);
    await settings.getByRole("button", { name: "Cancel", exact: true }).click();
    await nav()
      .getByRole("button", { name: "Settings for Journey box", exact: true })
      .click();
    await settings.getByRole("button", { name: "Move", exact: true }).click();
    await settings.getByRole("combobox").selectOption("2");
    await settings
      .getByRole("button", { name: "Move location", exact: true })
      .click();
    await expect(settings).toHaveCount(0);
    await openNav();
    await nav()
      .getByRole("button", { name: "Settings for Binders", exact: true })
      .click();
    await settings.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(
      settings.getByRole("button", { name: "Delete location", exact: true })
    ).toBeDisabled();
    await expect(settings).toContainText("Only an empty Location");
    await settings.getByRole("button", { name: "Cancel", exact: true }).click();
    await nav()
      .getByRole("button", { name: "Settings for Unsorted", exact: true })
      .click();
    await expect(settings).toContainText(
      "Unsorted can't be renamed, moved or deleted here."
    );
    await expect(
      settings.getByRole("button", { name: /Rename|Move|Delete/ })
    ).toHaveCount(0);
    await page.keyboard.press("Escape");
    await nav()
      .getByRole("button", {
        name: "Add child location to Unsorted",
        exact: true,
      })
      .click();
    await expect(settings).toContainText(
      "Unsorted can't be renamed, moved or deleted here."
    );
    await page.keyboard.press("Escape");
    if (phone) await page.keyboard.press("Escape");
    await openNav();
    await nav()
      .getByRole("button", { name: "Empty binder", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Empty binder", exact: true })
    ).toBeVisible();
    await openNav();
    await nav()
      .getByRole("button", { name: "Settings for Empty binder", exact: true })
      .click();
    await settings.getByRole("button", { name: "Delete", exact: true }).click();
    await settings
      .getByRole("textbox", { name: "Location name" })
      .fill("wrong");
    await settings
      .getByRole("button", { name: "Delete location", exact: true })
      .click();
    await expect(settings.getByRole("alert")).toContainText(
      "Type Empty binder exactly"
    );
    await settings
      .getByRole("textbox", { name: "Location name" })
      .fill("Empty binder");
    await settings
      .getByRole("button", { name: "Delete location", exact: true })
      .click();
    await expect(settings).toHaveCount(0);
    if (phone && (await drawer.isVisible()))
      await page.keyboard.press("Escape");
    await expect(
      page.getByRole("heading", { name: "All owned", exact: true })
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "All owned", exact: true })
    ).toBeFocused();
    expect(await inspect(page, "b")).toEqual(other);
    expect(
      await page.evaluate(() =>
        localStorage.getItem("prizecheck:workspace:preferences:v1:1")
      )
    ).toBe("wp3-sentinel");
    expect(calls).toEqual([]);
  });
  for (const scenario of [
    "location-failure",
    "location-stale",
    "location-slow",
  ])
    test(`${scenario} lifecycle at ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: width === 375 ? 812 : 800 });
      await page.goto(
        `${entry}?collection=${scenario}#riftbound:section=collection`
      );
      if (width === 375)
        await page
          .getByRole("button", { name: "Locations", exact: true })
          .click();
      await page
        .getByRole("button", { name: "Settings for Empty binder", exact: true })
        .filter({ visible: true })
        .click();
      const dialog = page.getByRole("dialog", {
        name: "Location settings",
        exact: true,
      });
      await dialog.getByRole("button", { name: "Rename", exact: true }).click();
      await dialog
        .getByRole("textbox", { name: "New name" })
        .fill("Saved once");
      if (scenario === "location-slow")
        await page.evaluate(async (path) => {
          const m = await import(path);
          const writer = m.collectionFixtureWriter("a", "location-slow");
          const edit = writer.editLocation;
          // Deliberately ignore cancellation to simulate a server that confirms after navigation.
          writer.editLocation = (
            input: unknown,
            options: { signal: AbortSignal; idempotencyKey: string }
          ) =>
            edit(input, { ...options, signal: new AbortController().signal });
        }, path);
      await dialog.getByRole("button", { name: "Save name" }).click();
      if (scenario === "location-slow") {
        await page.evaluate(() => {
          location.hash = "#riftbound:section=catalog";
        });
        await expect(dialog).toHaveCount(0);
        await expect(
          page.getByRole("region", { name: "Catalog results" })
        ).toBeVisible();
        await expect
          .poll(async () => (await inspect(page, "a", scenario)).revision)
          .toBe(2);
        await expect(
          page.getByRole("region", { name: "Notifications" })
        ).not.toContainText("Renamed");
      } else {
        await expect(dialog.getByRole("alert")).toBeVisible();
        await dialog
          .getByRole("button", {
            name:
              scenario === "location-stale" ? "Reload and retry" : "Save name",
            exact: true,
          })
          .click();
        await expect(dialog).toHaveCount(0);
        await expect
          .poll(async () => (await inspect(page, "a", scenario)).revision)
          .toBe(2);
      }
    });
}
