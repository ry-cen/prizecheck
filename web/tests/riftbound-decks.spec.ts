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
    await expect(page.getByText("Artwork unavailable").first()).toBeVisible();
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
    await page.goBack();
    await expect(
      page.getByRole("tabpanel", { name: "Library", exact: true })
    ).toBeVisible();
    await expect(sheet).not.toBeVisible();
    await expect(
      page.getByRole("heading", { name: "First Light", exact: true })
    ).toBeFocused();
    await page.goForward();
    await expect(page.getByRole("tabpanel", { name: /^Deck / })).toBeVisible();
    await expect(sheet).not.toBeVisible();
    await edit.focus();
    await page.keyboard.press("Enter");
    await expect(sheet).toBeVisible();
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
    await nav.getByRole("button", { name: "Collection", exact: true }).click();
    await page
      .getByRole("region", { name: "Collection results" })
      .getByRole("button", {
        name: "Ember Scout, FL 001, Standard, Unsorted",
        exact: true,
      })
      .first()
      .click();
    if (width === 375) {
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Move…", exact: true })
        .click();
    } else {
      await page.getByRole("button", { name: "Actions", exact: true }).focus();
      await page.keyboard.press("Enter");
      await page.keyboard.press("Enter");
    }
    const move = page.getByRole("dialog", { name: "Move 1 copy", exact: true });
    await move
      .getByRole("combobox", { name: "Location" })
      .selectOption("deck-2");
    await move
      .getByRole("button", { name: "Move 1 copy", exact: true })
      .click();
    const notifications = page.getByRole("region", { name: "Notifications" });
    await expect(notifications).toContainText("Moved 1 copy to New ideas");
    await decksNav.click();
    await page
      .getByRole("button", {
        name: "New ideas 1 cards in this Deck",
        exact: true,
      })
      .click();
    await expect(
      page.getByRole("tabpanel", { name: /^Deck / }).getByText(/In this Deck 1/)
    ).toBeVisible();
    await notifications
      .getByRole("button", { name: "Undo", exact: true })
      .click();
    await expect(
      page.getByRole("tabpanel", { name: /^Deck / }).getByText(/In this Deck 0/)
    ).toBeVisible();
    await expect(
      page.getByRole("tab", { name: "Deck 1", exact: true })
    ).toBeVisible();
    await page.goto(`${entry}?owner=b#riftbound:section=decks&deck=deck-1`);
    await expect(
      page.getByRole("heading", { name: "Beacon Brigade", exact: true })
    ).toBeVisible();
    await expect(
      page.getByText("Forgotten Sentinel", { exact: true })
    ).toHaveCount(0);
    expect(
      await page.evaluate(() =>
        localStorage.getItem("prizecheck:workspace:preferences:v1:1")
      )
    ).toBe("decks-sentinel");
    expect(calls).toEqual([]);
  });
  test(`removing a retained line preserves its copies and returns focus at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await page.goto(`${entry}#riftbound:section=decks&deck=deck-1`);
    await page
      .getByRole("button", {
        name: "Edit Forgotten Sentinel Standard",
        exact: true,
      })
      .click();
    const sheet = page.getByRole("dialog", {
      name: "Forgotten Sentinel",
      exact: true,
    });
    await sheet
      .getByRole("button", { name: "Decrease quantity", exact: true })
      .click();
    await expect(sheet).not.toBeVisible();
    await expect(
      page.getByRole("heading", { name: "First Light", exact: true })
    ).toBeFocused();
    await expect(
      page.getByRole("tab", { name: "Deck 8", exact: true })
    ).toBeVisible();
    await expect
      .poll(
        async () =>
          (await state(page)).rows.find(
            (row: { edition: { id: string } }) => row.edition.id === "retained"
          )?.quantity
      )
      .toBe(1);
    await page.getByRole("tab", { name: "Library", exact: true }).click();
    await page.goBack();
    await expect(
      page.getByRole("tab", { name: "Deck 8", exact: true })
    ).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });
  test(`corrects refused create and rename names at ${width}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height });
    await page.goto(`${entry}#riftbound:section=decks`);
    await page.getByLabel("Deck name").fill("First Light");
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
    await expect(create.getByRole("alert")).toContainText("already exists");
    await expect(create.getByLabel("Deck name")).toBeEnabled();
    await expect(create.getByLabel("Deck name")).toBeFocused();
    expect(
      await create
        .getByLabel("Deck name")
        .evaluate((input: HTMLInputElement) => [
          input.selectionStart,
          input.selectionEnd,
        ])
    ).toEqual([0, "First Light".length]);
    await expect(
      create.getByRole("button", { name: "Retry", exact: true })
    ).toHaveCount(0);
    await create.getByLabel("Deck name").fill("Corrected create");
    await create
      .getByRole("button", { name: "Create Deck", exact: true })
      .click();
    await expect(
      page.getByRole("button", {
        name: "Corrected create 0 cards in this Deck",
      })
    ).toBeVisible();
    await page
      .getByRole("button", { name: "First Light 9 cards in this Deck" })
      .click();
    await page.getByRole("button", { name: "Rename", exact: true }).click();
    const rename = page.getByRole("dialog", {
      name: "Rename Deck",
      exact: true,
    });
    await rename.getByLabel("Deck name").fill("New ideas");
    await rename
      .getByRole("button", { name: "Rename Deck", exact: true })
      .click();
    await expect(rename.getByRole("alert")).toContainText("already exists");
    await expect(rename.getByLabel("Deck name")).toBeEnabled();
    await expect(rename.getByLabel("Deck name")).toBeFocused();
    expect(
      await rename
        .getByLabel("Deck name")
        .evaluate((input: HTMLInputElement) => [
          input.selectionStart,
          input.selectionEnd,
        ])
    ).toEqual([0, "New ideas".length]);
    await page.screenshot({
      path: info.outputPath(`rename-refusal-${width}.png`),
      fullPage: true,
    });
    await rename.getByLabel("Deck name").fill("Corrected rename");
    await rename
      .getByRole("button", { name: "Rename Deck", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Corrected rename", exact: true })
    ).toBeVisible();
  });
  test(`slow rename preserves queued edits and retained refusal recovers at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await page.goto(
      `${entry}?decks=decks-slow#riftbound:section=decks&deck=deck-1&deckTab=library`
    );
    const add = page.getByRole("button", {
      name: "Add Ember Scout Standard",
      exact: true,
    });
    await add.evaluate((button) => {
      button.click();
      button.click();
    });
    await page.getByRole("button", { name: "Rename", exact: true }).click();
    const rename = page.getByRole("dialog", {
      name: "Rename Deck",
      exact: true,
    });
    await rename.getByLabel("Deck name").fill("Slow renamed");
    await rename
      .getByRole("button", { name: "Rename Deck", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Slow renamed", exact: true })
    ).toBeVisible();
    await expect(page.getByRole("status")).toHaveCount(0);
    await page.getByRole("tab", { name: "Deck 11", exact: true }).click();
    await page
      .getByRole("button", { name: "Edit Ember Scout Standard", exact: true })
      .click();
    await expect(
      page.getByRole("dialog").getByText("4 on Deck List", { exact: true })
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await page
      .getByRole("button", {
        name: "Edit Forgotten Sentinel Standard",
        exact: true,
      })
      .click();
    await page.getByRole("dialog").evaluate((dialog) => {
      (
        dialog.querySelector(
          '[aria-label="Decrease quantity"]'
        ) as HTMLButtonElement
      ).click();
      (
        dialog.querySelector(
          '[aria-label="Increase quantity"]'
        ) as HTMLButtonElement
      ).click();
    });
    await expect(page.getByRole("alert")).toContainText("can't be added");
    await expect(
      page.getByRole("button", { name: "Retry", exact: true })
    ).toHaveCount(0);
    await expect(page.getByRole("status")).toHaveCount(0);
    await page
      .getByRole("button", { name: "Edit Ember Scout Standard", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Increase quantity", exact: true })
      .click();
    await expect(
      page.getByRole("dialog").getByText("5 on Deck List", { exact: true })
    ).toBeVisible();
    await expect(page.getByRole("status")).toHaveCount(0);
  });
  for (const mixed of [false, true]) {
    test(`retained refusal preserves ${mixed ? "mixed batch" : "later queued"} changes at ${width}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await page.goto(
        `${entry}?decks=decks-slow#riftbound:section=decks&deck=deck-1`
      );
      await expect(
        page.getByRole("heading", { name: "First Light", exact: true })
      ).toBeVisible();
      const calls: {
        listRevision: number;
        changes: { editionId: string; quantity: number }[];
      }[] = [];
      page.on("console", (message) => {
        if (message.text().startsWith("deck-write "))
          calls.push(JSON.parse(message.text().slice(11)));
      });
      await page.evaluate(async () => {
        const path = "/src/games/riftbound/local/deckFixtures.ts";
        const api = (await import(path)).deckFixture("a", "decks-slow");
        const original = api.changeDeckList;
        api.changeDeckList = async (input: unknown, options: unknown) => {
          console.debug("deck-write " + JSON.stringify(input));
          return original(input, options);
        };
      });
      await page
        .getByRole("button", {
          name: "Edit Forgotten Sentinel Standard",
          exact: true,
        })
        .click();
      await page.getByRole("dialog").evaluate((dialog) => {
        (
          dialog.querySelector(
            '[aria-label="Decrease quantity"]'
          ) as HTMLButtonElement
        ).click();
        (
          dialog.querySelector(
            '[aria-label="Increase quantity"]'
          ) as HTMLButtonElement
        ).click();
      });
      if (!mixed) await expect.poll(() => calls.length).toBe(2);
      await page.keyboard.press("Escape");
      await page
        .getByRole("button", { name: "Edit Ember Scout Standard", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Increase quantity", exact: true })
        .click();
      await expect(page.getByRole("alert")).toContainText(
        "Your other changes are still being saved"
      );
      await expect(
        page.getByRole("button", { name: "Retry", exact: true })
      ).toHaveCount(0);
      await expect(page.getByRole("alert")).toContainText(
        "Your other changes were saved",
        { timeout: 10000 }
      );
      expect(calls).toHaveLength(3);
      expect(calls[1].changes).toHaveLength(mixed ? 2 : 1);
      expect(calls[2]).toMatchObject({
        listRevision: 2,
        changes: [{ editionId: "1", quantity: 3 }],
      });
      const final = await page.evaluate(async () => {
        const decksPath = "/src/games/riftbound/local/deckFixtures.ts";
        return (await import(decksPath))
          .deckFixture("a", "decks-slow")
          .deck("deck-1", new AbortController().signal);
      });
      expect(final.listRevision).toBe(3);
      expect(
        final.lines.find(
          (line: { edition: { id: string } }) => line.edition.id === "1"
        ).quantity
      ).toBe(3);
      expect(
        final.lines.some(
          (line: { edition: { id: string } }) => line.edition.id === "retained"
        )
      ).toBe(false);
    });
  }
  test(`isolates available new additions from a retained refusal at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await page.goto(
      `${entry}?decks=decks-slow#riftbound:section=decks&deck=deck-1`
    );
    await page
      .getByRole("button", {
        name: "Edit Forgotten Sentinel Standard",
        exact: true,
      })
      .click();
    await page.getByRole("dialog").evaluate((dialog) => {
      (
        dialog.querySelector(
          '[aria-label="Decrease quantity"]'
        ) as HTMLButtonElement
      ).click();
      (
        dialog.querySelector(
          '[aria-label="Increase quantity"]'
        ) as HTMLButtonElement
      ).click();
    });
    await page.keyboard.press("Escape");
    await page.getByRole("tab", { name: "Library", exact: true }).click();
    await page
      .getByRole("button", {
        name: "Add Moonlit Crossing Standard",
        exact: true,
      })
      .click();
    await expect(page.getByRole("alert")).toContainText(
      "Your other changes were saved",
      { timeout: 15000 }
    );
    const final = await page.evaluate(async () => {
      const path = "/src/games/riftbound/local/deckFixtures.ts";
      return (await import(path))
        .deckFixture("a", "decks-slow")
        .deck("deck-1", new AbortController().signal);
    });
    expect(
      final.lines.find((l: { edition: { id: string } }) => l.edition.id === "4")
        .quantity
    ).toBe(1);
    expect(
      final.lines.some(
        (l: { edition: { id: string } }) => l.edition.id === "retained"
      )
    ).toBe(false);
  });
  test(`immediate second rename and delete use the returned Location at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await page.goto(
      `${entry}?decks=decks-slow#riftbound:section=decks&deck=deck-1`
    );
    for (const name of ["First rename", "Second rename"]) {
      await page.getByRole("button", { name: "Rename", exact: true }).click();
      const dialog = page.getByRole("dialog", {
        name: "Rename Deck",
        exact: true,
      });
      await dialog.getByLabel("Deck name").fill(name);
      await dialog
        .getByRole("button", { name: "Rename Deck", exact: true })
        .click();
      await expect(
        page.getByRole("heading", { name, exact: true })
      ).toBeVisible();
    }
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    const dialog = page.getByRole("dialog", {
      name: "Delete Deck",
      exact: true,
    });
    await expect(dialog).toContainText("Type Second rename exactly");
    await dialog.getByLabel("Deck name").fill("Second rename");
    await dialog
      .getByRole("button", { name: "Delete Deck", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Decks", exact: true })
    ).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
  });
  test(`background Location refresh preserves a locked Delete confirmation at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await page.goto(
      `${entry}?decks=decks-slow#riftbound:section=decks&deck=deck-1`
    );
    await expect(
      page.getByRole("heading", { name: "First Light", exact: true })
    ).toBeVisible();
    await page.evaluate(async () => {
      const path = "/src/games/riftbound/local/deckFixtures.ts";
      const api = (await import(path)).deckFixture("a", "decks-slow");
      const read = api.deck,
        remove = api.deleteDeck;
      let refreshed = false,
        failed = false;
      api.deck = async (id: string, signal: AbortSignal) => {
        if (!refreshed) {
          refreshed = true;
          await api.renameDeck(
            { id, name: "Background rename", version: 2 },
            { signal, idempotencyKey: crypto.randomUUID() }
          );
        }
        return read(id, signal);
      };
      api.deleteDeck = async (input: unknown, options: unknown) => {
        if (!failed) {
          failed = true;
          throw new Error("Uncertain response");
        }
        return remove(input, options);
      };
    });
    await page.getByRole("button", { name: "Rename", exact: true }).click();
    let dialog = page.getByRole("dialog", { name: "Rename Deck", exact: true });
    await dialog.getByLabel("Deck name").fill("Foreground rename");
    await dialog
      .getByRole("button", { name: "Rename Deck", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Foreground rename", exact: true })
    ).toBeVisible();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "Delete Deck", exact: true });
    await dialog.getByLabel("Deck name").fill("Foreground rename");
    await dialog
      .getByRole("button", { name: "Delete Deck", exact: true })
      .click();
    await expect(dialog.getByLabel("Deck name")).toBeDisabled();
    // The response was uncertain: the attempt, its key and its version stay,
    // even once a background read shows the Deck was renamed.
    await expect(dialog).toContainText("may not have been saved", {
      timeout: 10000,
    });
    await expect(dialog.getByLabel("Deck name")).toBeDisabled();
    await expect(dialog.getByLabel("Deck name")).toHaveValue(
      "Foreground rename"
    );
    // Retry replays the original attempt; the server refuses it definitively
    // because it never applied and the Deck has moved on.
    await dialog.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(dialog).toContainText("Type Background rename exactly", {
      timeout: 10000,
    });
    await expect(dialog.getByLabel("Deck name")).toBeEnabled();
    await expect(dialog.getByLabel("Deck name")).toHaveValue(
      "Foreground rename"
    );
    await expect(
      dialog.getByRole("button", { name: "Delete Deck", exact: true })
    ).toBeDisabled();
    await dialog.getByLabel("Deck name").fill("Background rename");
    await dialog
      .getByRole("button", { name: "Delete Deck", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Decks", exact: true })
    ).toBeVisible();
  });
  test(`background Location refresh preserves a Rename draft at ${width}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height });
    await page.goto(
      `${entry}?decks=decks-slow#riftbound:section=decks&deck=deck-1`
    );
    await expect(
      page.getByRole("heading", { name: "First Light", exact: true })
    ).toBeVisible();
    await page.evaluate(async () => {
      const path = "/src/games/riftbound/local/deckFixtures.ts";
      const api = (await import(path)).deckFixture("a", "decks-slow");
      const read = api.deck,
        remove = api.deleteDeck;
      let refreshed = false,
        failed = false;
      api.deck = async (id: string, signal: AbortSignal) => {
        if (!refreshed) {
          refreshed = true;
          await api.renameDeck(
            { id, name: "Background rename", version: 2 },
            { signal, idempotencyKey: crypto.randomUUID() }
          );
        }
        return read(id, signal);
      };
      api.deleteDeck = async (input: unknown, options: unknown) => {
        if (!failed) {
          failed = true;
          throw new Error("Uncertain response");
        }
        return remove(input, options);
      };
    });
    await page.getByRole("button", { name: "Rename", exact: true }).click();
    let dialog = page.getByRole("dialog", { name: "Rename Deck", exact: true });
    await dialog.getByLabel("Deck name").fill("Foreground rename");
    await dialog
      .getByRole("button", { name: "Rename Deck", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Foreground rename", exact: true })
    ).toBeVisible();
    await page.getByRole("button", { name: "Rename", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "Rename Deck", exact: true });
    await dialog.getByLabel("Deck name").fill("My retained draft");
    await expect(
      dialog.getByText("This Deck was renamed elsewhere.")
    ).toBeVisible({ timeout: 10000 });
    await expect(dialog.getByLabel("Deck name")).toHaveValue(
      "My retained draft"
    );
    await expect(dialog.getByLabel("Deck name")).toBeFocused();
    await page.screenshot({
      path: info.outputPath(`rename-note-${width}.png`),
      fullPage: true,
    });
    await dialog
      .getByRole("button", { name: "Rename Deck", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "My retained draft", exact: true })
    ).toBeVisible();
  });
  // The Deck's sheet closes as soon as a removed line leaves the list, so a
  // collector cannot click the refused line again from the page. This spec
  // builds its own DeckEdits instance in the page and drives it against the
  // same slow fixture and a real browser clock: it covers the queue, not the
  // page's mounted queue.
  for (const reclick of ["again", "to zero"])
    test(`keeps an available new Edition when a refused line is changed ${reclick} while its batch is in flight at ${width}`, async ({
      page,
    }) => {
      test.setTimeout(90000);
      await page.setViewportSize({ width, height });
      await page.goto(
        `${entry}?decks=decks-slow#riftbound:section=decks&deck=deck-1`
      );
      const result = await page.evaluate(async (again) => {
        const { DeckEdits } = await import(
          "/src/games/riftbound/deckEdits.ts" as string
        );
        const api = (
          await import("/src/games/riftbound/local/deckFixtures.ts" as string)
        ).deckFixture("a", "decks-slow");
        const signal = new AbortController().signal;
        const sent: string[][] = [];
        let started!: () => void;
        const second = new Promise<void>((r) => {
          started = r;
        });
        const writer = {
          owner: "a",
          changeDeckList: (
            input: { changes: { editionId: string }[] },
            o: unknown
          ) => {
            sent.push(input.changes.map((c) => c.editionId));
            if (sent.length === 2) started();
            return api.changeDeckList(input, o);
          },
        };
        const edits = new DeckEdits(
          await api.deck("deck-1", signal),
          writer,
          () => {}
        );
        edits.reload = (s: AbortSignal) => api.deck("deck-1", s);
        edits.adjust("retained", -1);
        edits.adjust("retained", 1);
        edits.adjust("4", 1);
        await second;
        edits.adjust("retained", again ? 1 : -1);
        for (let i = 0; i < 200 && edits.busy; i++)
          await new Promise((r) => setTimeout(r, 100));
        const final = await api.deck("deck-1", signal);
        const quantity = (id: string) =>
          final.lines.find(
            (l: { edition: { id: string } }) => l.edition.id === id
          )?.quantity ?? 0;
        const out = {
          sent,
          busy: edits.busy,
          four: quantity("4"),
          retained: quantity("retained"),
          pending: edits.quantity("retained"),
        };
        edits.dispose();
        return out;
      }, reclick === "again");
      expect(result).toMatchObject({
        busy: false,
        four: 1,
        retained: 0,
        pending: 0,
      });
      expect(result.sent.slice(1)).toEqual(
        reclick === "again"
          ? [["retained", "4"], ["retained"], ["4"]]
          : [["retained", "4"], ["4"]]
      );
    });
  test(`tells a refusal and a change elsewhere apart at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await page.goto(
      `${entry}?decks=decks-slow#riftbound:section=decks&deck=deck-1`
    );
    await page.evaluate(async () => {
      const path = "/src/games/riftbound/local/deckFixtures.ts";
      const hooks = "/src/games/riftbound/local/deckTestHooks.ts";
      const api = (await import(path)).deckFixture("a", "decks-slow");
      const { changeFixtureDeckLine } = await import(hooks);
      const write = api.changeDeckList,
        read = api.deck;
      let armed = false;
      api.changeDeckList = async (input: unknown, options: unknown) => {
        try {
          return await write(input, options);
        } catch (e) {
          armed = true;
          throw e;
        }
      };
      api.deck = async (id: string, signal: AbortSignal) => {
        if (armed) {
          armed = false;
          changeFixtureDeckLine("a", "deck-1", "1", 7);
        }
        return read(id, signal);
      };
    });
    await page
      .getByRole("button", {
        name: "Edit Forgotten Sentinel Standard",
        exact: true,
      })
      .click();
    await page.getByRole("dialog").evaluate((dialog) => {
      (
        dialog.querySelector(
          '[aria-label="Decrease quantity"]'
        ) as HTMLButtonElement
      ).click();
      (
        dialog.querySelector(
          '[aria-label="Increase quantity"]'
        ) as HTMLButtonElement
      ).click();
    });
    await page.keyboard.press("Escape");
    await page
      .getByRole("button", { name: "Edit Ember Scout Standard", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Increase quantity", exact: true })
      .click();
    await expect(page.getByRole("alert")).toHaveText(
      "That card can't be added any more, and this Deck changed somewhere else, so some changes weren’t saved. Review the Deck List.",
      { timeout: 15000 }
    );
  });
  test(`keeps focus in the rename field through version changes at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await page.goto(
      `${entry}?decks=decks-slow#riftbound:section=decks&deck=deck-1`
    );
    type Hooks = {
      __arm: () => void;
      __listRelease: () => void;
      __renameRelease: () => void;
      __listDone: boolean;
      __renameApplied: boolean;
      __holdRename: boolean;
      __renameRaw: (...args: unknown[]) => Promise<unknown>;
    };
    await page.evaluate(async () => {
      const path = "/src/games/riftbound/local/deckFixtures.ts";
      const api = (await import(path)).deckFixture("a", "decks-slow");
      const w = window as unknown as Hooks & Record<string, Promise<void>>;
      // Each arm() makes the next list write and rename wait for a release.
      w.__arm = () => {
        w.__listDone = false;
        w.__renameApplied = false;
        w.__holdRename = true;
        w.__listGate = new Promise<void>((r) => {
          w.__listRelease = r;
        });
        w.__renameGate = new Promise<void>((r) => {
          w.__renameRelease = r;
        });
      };
      w.__holdRename = false;
      w.__renameRaw = api.renameDeck.bind(api);
      const write = api.changeDeckList,
        rename = api.renameDeck;
      api.changeDeckList = async (input: unknown, options: unknown) => {
        if (w.__holdRename) await w.__listGate;
        const result = await write(input, options);
        w.__listDone = true;
        return result;
      };
      api.renameDeck = async (input: unknown, options: unknown) => {
        const result = await rename(input, options);
        w.__renameApplied = true;
        if (w.__holdRename) await w.__renameGate;
        return result;
      };
    });
    const call = (name: "__arm" | "__listRelease" | "__renameRelease") =>
      page.evaluate((n) => (window as unknown as Hooks)[n](), name);
    const start = async (name: string) => {
      await page.getByRole("button", { name: "Rename", exact: true }).click();
      const dialog = page.getByRole("dialog", {
        name: "Rename Deck",
        exact: true,
      });
      await dialog.getByLabel("Deck name").fill(name);
      await dialog
        .getByRole("button", { name: "Rename Deck", exact: true })
        .click();
      await expect(dialog.getByLabel("Deck name")).toBeDisabled();
      return dialog;
    };
    const addInLibrary = async () => {
      await page.getByRole("tab", { name: "Library", exact: true }).click();
      await page
        .getByRole("button", { name: "Add Ember Scout Standard", exact: true })
        .click();
      await page.getByRole("tab", { name: /^Deck/ }).click();
    };
    const elsewhere = (version: number) =>
      page.evaluate(async (version) => {
        await (window as unknown as Hooks).__renameRaw(
          { id: "deck-1", name: `Elsewhere ${version}`, version },
          {
            signal: new AbortController().signal,
            idempotencyKey: crypto.randomUUID(),
          }
        );
      }, version);
    // 1. The collector's own rename: a list write delivers the version it
    //    produced while the rename is still returning, and is not mistaken
    //    for a change elsewhere.
    await call("__arm");
    await addInLibrary();
    let dialog = await start("Own rename");
    await page.waitForFunction(
      () => (window as unknown as Hooks).__renameApplied
    );
    await call("__listRelease");
    await page.waitForFunction(() => (window as unknown as Hooks).__listDone);
    await expect(dialog.getByLabel("Deck name")).toBeDisabled();
    await expect(
      dialog.getByText("This Deck was renamed elsewhere.")
    ).toHaveCount(0);
    await call("__renameRelease");
    await expect(
      page.getByRole("heading", { name: "Own rename", exact: true })
    ).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    // 2. Another rename lands while the collector's is still returning, so the
    //    change cannot be attributed to it: the draft stays and focus returns.
    await call("__arm");
    await addInLibrary();
    dialog = await start("Mid-flight draft");
    await page.waitForFunction(
      () => (window as unknown as Hooks).__renameApplied
    );
    await elsewhere(3);
    await call("__listRelease");
    await page.waitForFunction(() => (window as unknown as Hooks).__listDone);
    await call("__renameRelease");
    await expect(
      dialog.getByText("This Deck was renamed elsewhere.")
    ).toBeVisible();
    await expect(dialog.getByLabel("Deck name")).toHaveValue(
      "Mid-flight draft"
    );
    await expect(dialog.getByLabel("Deck name")).toBeEnabled();
    await expect(dialog.getByLabel("Deck name")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    // 3. A stale rename: someone else renamed first. The draft stays, the Deck
    //    reloads and focus returns to the field.
    await page.evaluate(() => {
      (window as unknown as Hooks).__holdRename = false;
    });
    void elsewhere(4);
    dialog = await start("Stale draft");
    await expect(
      dialog.getByText("This Deck was renamed elsewhere.")
    ).toBeVisible({ timeout: 15000 });
    await expect(dialog.getByLabel("Deck name")).toHaveValue("Stale draft");
    await expect(dialog.getByLabel("Deck name")).toBeFocused();
  });
  test(`retries a rename whose response was lost with the same key and applies it once at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await page.goto(
      `${entry}?decks=decks-slow#riftbound:section=decks&deck=deck-1`
    );
    type Lost = { __listRelease: () => void; __lostRelease: () => void };
    await page.evaluate(async () => {
      const path = "/src/games/riftbound/local/deckFixtures.ts";
      const hooks = "/src/games/riftbound/local/deckTestHooks.ts";
      const api = (await import(path)).deckFixture("a", "decks-slow");
      const { loseNextRenameResponse } = await import(hooks);
      const w = window as unknown as Lost & Record<string, unknown>;
      const listGate = new Promise<void>((r) => {
        w.__listRelease = r;
      });
      const lostGate = new Promise<void>((r) => {
        w.__lostRelease = r;
      });
      w.__lostApplied = false;
      const rename = api.renameDeck.bind(api);
      api.renameDeck = async (...args: unknown[]) => {
        const result = await rename(...args);
        w.__lostApplied = true;
        return result;
      };
      loseNextRenameResponse(api, lostGate);
      const write = api.changeDeckList;
      api.changeDeckList = async (input: unknown, options: unknown) => {
        await listGate;
        const result = await write(input, options);
        w.__listDone = true;
        return result;
      };
    });
    // A list write is in flight when the rename applies; its response is the
    // background read that observes the version the rename produced.
    await page.getByRole("tab", { name: "Library", exact: true }).click();
    await page
      .getByRole("button", { name: "Add Ember Scout Standard", exact: true })
      .click();
    await page.getByRole("tab", { name: /^Deck/ }).click();
    await page.getByRole("button", { name: "Rename", exact: true }).click();
    const dialog = page.getByRole("dialog", {
      name: "Rename Deck",
      exact: true,
    });
    await dialog.getByLabel("Deck name").fill("Lost response rename");
    await dialog
      .getByRole("button", { name: "Rename Deck", exact: true })
      .click();
    await page.waitForFunction(
      () => (window as unknown as Record<string, unknown>).__lostApplied
    );
    await page.evaluate(() => (window as unknown as Lost).__listRelease());
    await page.waitForFunction(
      () => (window as unknown as Record<string, unknown>).__listDone
    );
    await page.evaluate(() => (window as unknown as Lost).__lostRelease());
    await expect(dialog).toContainText("may not have been saved");
    await expect(dialog.getByText("renamed elsewhere")).toHaveCount(0);
    await dialog.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Lost response rename", exact: true })
    ).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByText("renamed elsewhere")).toHaveCount(0);
    const location = await page.evaluate(async () => {
      const path = "/src/games/riftbound/local/deckFixtures.ts";
      return (await import(path))
        .deckFixture("a", "decks-slow")
        .deck("deck-1", new AbortController().signal)
        .then((d: { location: unknown }) => d.location);
    });
    // One mutation: version 1 to 2, not 3.
    expect(location).toMatchObject({
      name: "Lost response rename",
      version: 2,
    });
    expect(
      await page.evaluate(() => document.activeElement !== document.body)
    ).toBe(true);
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
    await expect(page.getByRole("alert")).toContainText(
      "Your last Deck List change may not have been saved"
    );
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
