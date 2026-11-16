import { expect, type Page } from "@playwright/test";
import { test } from "./support/art-upstream";
import { expectTouchTarget } from "./support/touch-target";
const origin = process.env.TEST_ORIGIN || "http://127.0.0.1:5173";
const entry = `${origin}/src/games/riftbound/local/index.html`;
const storePath = "/src/games/riftbound/local/collectionFixtures.ts";
async function state(page: Page) {
  return page.evaluate(
    async (path) =>
      structuredClone((await import(path)).collectionFixtureStore("a")),
    storePath
  );
}
for (const width of [1280, 375]) {
  const height = width === 375 ? 812 : 800;
  test(`Deck fixture journeys, history, copy edits and isolation at ${width}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height });
    const shot = async (name: string) => {
      const path = info.outputPath(name);
      await page.screenshot({ path, fullPage: true });
      await info.attach(name, { path, contentType: "image/png" });
    };
    const calls: string[] = [];
    page.on("request", (r) => {
      if (/^\/(api|auth)(\/|$)/.test(new URL(r.url()).pathname))
        calls.push(r.url());
    });
    await page.addInitScript(() =>
      localStorage.setItem(
        "prizecheck:workspace:preferences:v1:1",
        "decks-sentinel"
      )
    );
    await page.goto(entry);
    const nav = page.getByRole("navigation", {
      name: width === 375 ? "Mobile navigation" : "Main navigation",
      exact: true,
    });
    const decksNav = nav.getByRole("button", { name: "Decks", exact: true });
    await decksNav.focus();
    await page.keyboard.press("Enter");
    await expect(decksNav).toHaveAttribute("aria-current", "page");
    await expect(
      page.getByRole("heading", { name: "Decks", exact: true })
    ).toBeFocused();
    await expect(
      page.getByRole("button", { name: "First Light 9 cards in this Deck" })
    ).toBeVisible();
    await shot(`decks-index-${width}.png`);
    await page
      .getByRole("button", { name: "First Light 9 cards in this Deck" })
      .click();
    await expect(
      page.getByRole("heading", { name: "First Light", exact: true })
    ).toBeVisible();
    await expect(page.getByText("No image available").first()).toBeVisible();
    await shot(`deck-editor-${width}.png`);
    await page.getByRole("tab", { name: "Library", exact: true }).click();
    await expect(page.getByRole("tabpanel", { name: "Library" })).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: "Add Ember Scout Standard",
        exact: true,
      })
    ).toBeVisible();
    await shot(`deck-library-${width}.png`);
    await page.goBack();
    await expect(page.getByRole("tabpanel", { name: /^Deck / })).toBeVisible();
    await page.goForward();
    await expect(page.getByRole("tabpanel", { name: "Library" })).toBeVisible();
    await page
      .getByRole("button", { name: "Add Ember Scout Standard", exact: true })
      .click();
    await expect(page.getByRole("status")).toHaveCount(0);
    await page.getByRole("tab", { name: "Deck 10", exact: true }).click();
    const edit = page.getByRole("button", {
      name: "Edit Ember Scout Standard",
      exact: true,
    });
    await edit.focus();
    await page.keyboard.press("Enter");
    const sheet = page.getByRole("dialog", {
      name: "Ember Scout",
      exact: true,
    });
    await expect(
      sheet.getByText("2 in this Deck", { exact: true })
    ).toBeVisible();
    await expect(
      sheet.getByText("3 in Unsorted", { exact: true })
    ).toBeVisible();
    await shot(`deck-copy-sheet-${width}.png`);
    if (width === 375) {
      await expectTouchTarget(
        sheet.getByRole("button", { name: "Increase quantity" })
      );
    }
    await sheet
      .getByRole("button", { name: "Increase quantity" })
      .evaluate((button) => {
        button.click();
        button.click();
        button.click();
      });
    await expect(
      sheet.getByText("6 on Deck List", { exact: true })
    ).toBeVisible();
    await expect(page.getByRole("status")).toHaveCount(0);
    await sheet.getByRole("button", { name: "Decrease quantity" }).click();
    await expect(
      sheet.getByText("5 on Deck List", { exact: true })
    ).toBeVisible();
    await expect(page.getByRole("status")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(edit).toBeFocused();
    if (width === 375) {
      await expect
        .poll(async () => {
          const box = await edit.boundingBox();
          return box ? box.y + box.height : Infinity;
        })
        .toBeLessThanOrEqual(height - 56);
    }
    await page
      .getByRole("button", { name: "‹ All Decks", exact: true })
      .click();
    await expect(
      page.getByRole("button", {
        name: "First Light 12 cards in this Deck",
        exact: true,
      })
    ).toBeVisible();
    await page
      .getByRole("button", {
        name: "First Light 12 cards in this Deck",
        exact: true,
      })
      .click();
    await expect(
      page.getByRole("tab", { name: "Deck 12", exact: true })
    ).toBeVisible();
    await page.getByRole("button", { name: "Rename", exact: true }).click();
    const rename = page.getByRole("dialog", {
      name: "Rename Deck",
      exact: true,
    });
    await rename.getByLabel("Deck name").fill("Dawn patrol");
    await rename
      .getByRole("button", { name: "Rename Deck", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Dawn patrol", exact: true })
    ).toBeVisible();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    const deletion = page.getByRole("dialog", {
      name: "Delete Deck",
      exact: true,
    });
    await expect(
      deletion.getByText(/Its cards return to Unsorted/)
    ).toBeVisible();
    await deletion.getByLabel("Deck name").fill("Dawn patrol");
    await deletion
      .getByRole("button", { name: "Delete Deck", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Decks", exact: true })
    ).toBeVisible();
    await expect
      .poll(
        async () =>
          (await state(page)).rows.find(
            (r: { locationId: string; edition: { id: string } }) =>
              r.locationId === "1" && r.edition.id === "1"
          )?.quantity
      )
      .toBe(5);
    await nav.getByRole("button", { name: "Collection", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "All owned", exact: true })
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Dawn patrol", exact: true })
    ).toHaveCount(0);
    await expect(
      page
        .getByRole("region", { name: "Collection results" })
        .getByRole("button", {
          name: "Ember Scout, FL 001, Standard, Unsorted",
          exact: true,
        })
    ).toHaveCount(5);
    await decksNav.click();
    await page.getByLabel("Deck name").fill("Fresh deck");
    await page
      .getByRole("button", { name: "Create Deck", exact: true })
      .click();
    const create = page.getByRole("dialog", {
      name: "Create Deck",
      exact: true,
    });
    await create
      .getByRole("button", { name: "Create Deck", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Fresh deck 0 cards in this Deck" })
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Fresh deck 0 cards in this Deck" })
      .click();
    await expect(
      page.getByText("This Deck is empty. Add cards from the Library.")
    ).toBeVisible();
    expect(
      await page.evaluate(() =>
        localStorage.getItem("prizecheck:workspace:preferences:v1:1")
      )
    ).toBe("decks-sentinel");
    expect(calls).toEqual([]);
    await page.goto(`${entry}?owner=b#riftbound:section=decks&deck=deck-1`);
    await expect(
      page.getByRole("heading", { name: "Beacon Brigade", exact: true })
    ).toBeVisible();
    await expect(
      page.getByText("Forgotten Sentinel", { exact: true })
    ).toHaveCount(0);
  });
  test(`keyboard Deck creation and tab navigation at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await page.goto(`${entry}#riftbound:section=decks`);
    await page.getByLabel("Deck name").focus();
    await page.keyboard.type("Keyboard deck");
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", {
      name: "Create Deck",
      exact: true,
    });
    await dialog
      .getByRole("button", { name: "Create Deck", exact: true })
      .focus();
    await page.keyboard.press("Enter");
    const card = page.getByRole("button", {
      name: "Keyboard deck 0 cards in this Deck",
    });
    await expect(card).toBeVisible();
    await card.focus();
    await page.keyboard.press("Enter");
    await page.getByRole("tab", { name: "Deck 0", exact: true }).focus();
    await page.keyboard.press("ArrowLeft");
    await expect(
      page.getByRole("tab", { name: "Library", exact: true })
    ).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("tabpanel", { name: "Library", exact: true })
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Add Ember Scout Standard", exact: true })
      .focus();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("tab", { name: "Deck 1", exact: true })
    ).toBeVisible();
  });
  test(`Deck failure, stale, missing and empty states at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await page.goto(`${entry}?decks=decks-empty#riftbound:section=decks`);
    await expect(
      page.getByText("No Decks yet. Create your first Deck.")
    ).toBeVisible();
    await page.goto(`${entry}#riftbound:section=decks&deck=deleted`);
    await expect(
      page.getByRole("heading", { name: "This Deck isn't available" })
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "This Deck isn't available" })
    ).toBeFocused();
    await page.getByRole("link", { name: "All Decks", exact: true }).click();
    await page.goto(`${entry}?decks=decks-failure#riftbound:section=decks`);
    await expect(page.getByRole("alert")).toContainText("couldn't be loaded");
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await page
      .getByRole("button", { name: "First Light 9 cards in this Deck" })
      .click();
    await page
      .getByRole("button", { name: "Edit Ember Scout Standard", exact: true })
      .click();
    let sheet = page.getByRole("dialog", { name: "Ember Scout", exact: true });
    await sheet.getByRole("button", { name: "Increase quantity" }).click();
    await expect(page.getByRole("alert")).toContainText("Unable to save");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(page.getByRole("status")).toHaveCount(0);
    await page.goto(
      `${entry}?decks=deck-stale#riftbound:section=decks&deck=deck-1`
    );
    await page
      .getByRole("button", { name: "Edit Ember Scout Standard", exact: true })
      .click();
    sheet = page.getByRole("dialog", { name: "Ember Scout", exact: true });
    await sheet.getByRole("button", { name: "Increase quantity" }).click();
    await expect(page.getByRole("alert")).toContainText(
      "This Deck changed somewhere else"
    );
    await expect(
      sheet.getByText("3 on Deck List", { exact: true })
    ).toBeVisible();
    await sheet.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(sheet.getByRole("alert")).toHaveCount(0);
    await expect(sheet.getByRole("status")).toHaveCount(0);
    await page.goto(
      `${entry}?decks=decks-slow#riftbound:section=decks&deck=deck-1&deckTab=library`
    );
    await page
      .getByRole("button", { name: "Add Ember Scout Standard", exact: true })
      .click();
    await expect(page.getByRole("status")).toContainText("Saving");
    await page
      .getByRole("navigation", {
        name: width === 375 ? "Mobile navigation" : "Main navigation",
        exact: true,
      })
      .getByRole("button", { name: "Catalog", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Catalog", exact: true })
    ).toBeVisible();
    await expect(page.getByText("Saving changes…")).toHaveCount(0);
    await expect(page.getByText(/Deck List changed:|Saved/)).toHaveCount(0);
  });
}
