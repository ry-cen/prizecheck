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
