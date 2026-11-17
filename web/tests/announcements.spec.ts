import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { expect, test as plain, type Page } from "@playwright/test";
import { Pool } from "pg";
import {
  test,
  type OtherCollector,
  type OtherCollectorOptions,
} from "./support/collectors";
import { api, createDeck, ORIGIN, seedCatalog, setLine } from "./support/loans";
import { startAsNewOwner } from "./support/owner";
import { signInAsOwner } from "./support/sign-in";

// One announcement per action (Opus m11 F3). A screen reader speaks a polite region when its words change, so each
// add, remove or load must change exactly one live region with words, never a bare number, and a price summary must not
// be a live region at all. `watch` records what a screen reader would be told: every change to a live region's text,
// except a region switched off (aria-live="off"), a region inside a Toast host that is silenced, and anything outside
// the open modal dialog (inert, so unheard). `snapshot` is the other way to see it, and the one a reviewer's script
// uses: the text of every `[aria-live]`, `[role=status]` and `[role=alert]` on the page right now.

const PHONE = { width: 375, height: 812 };
const DESKTOP = { width: 1280, height: 800 };
const BARE_NUMBER = /^[\s\d.,]+$/;

/** Starts recording on this page now and on every page it loads next. */
async function watch(page: Page) {
  await page.addInitScript(recorder);
  await page.evaluate(recorder);
}

function recorder() {
  const selector = '[aria-live], [role="status"], [role="alert"], output';
  const clean = (text: string | null) =>
    (text ?? "").replace(/\s+/g, " ").trim();
  const updates: string[] = [];
  const spoken = (region: Element) => {
    // The nearest aria-live decides: "off" silences the region and what is inside it.
    if (region.closest("[aria-live]")?.getAttribute("aria-live") === "off")
      return false;
    // A modal dialog makes the rest of the page inert, so nothing outside it is spoken.
    const modal = [...document.querySelectorAll("dialog[open]")].at(-1);
    return !modal || modal.contains(region);
  };
  // What a screen reader says for a live region is the text added to it (not what stays), and a region that appears with
  // words in it.
  new MutationObserver((records) => {
    const added = new Map<Element, string[]>();
    const note = (region: Element | null, text: string) => {
      if (!region || !text || !spoken(region)) return;
      added.set(region, [...(added.get(region) ?? []), text]);
    };
    for (const record of records) {
      if (record.type === "characterData")
        note(
          (record.target.parentElement ?? null)?.closest(selector) ?? null,
          clean(record.target.textContent)
        );
      else
        record.addedNodes.forEach((node) => {
          const el = node instanceof Element ? node : node.parentElement;
          const inside = (record.target as Element).closest?.(selector);
          if (inside) note(inside, clean(node.textContent));
          else if (node instanceof Element) {
            if (node.matches(selector)) note(node, clean(node.textContent));
            node
              .querySelectorAll(selector)
              .forEach((region) => note(region, clean(region.textContent)));
          } else if (el) note(el.closest(selector), clean(node.textContent));
        });
    }
    for (const texts of added.values()) updates.push(clean(texts.join(" ")));
    document.documentElement.dataset.liveUpdates = JSON.stringify(updates);
  }).observe(document.documentElement, {
    childList: true,
    characterData: true,
    subtree: true,
  });
  document.documentElement.dataset.liveUpdates = "[]";
}

const heard = (page: Page) =>
  page.evaluate(
    () =>
      JSON.parse(
        document.documentElement.dataset.liveUpdates ?? "[]"
      ) as string[]
  );

/** The text of every live region a script would find, leaving out the ones switched off (a silenced toast). */
const snapshot = (page: Page) =>
  page.evaluate(() =>
    [
      ...document.querySelectorAll(
        '[aria-live], [role="status"], [role="alert"]'
      ),
    ]
      .filter(
        (el) => el.closest("[aria-live]")?.getAttribute("aria-live") !== "off"
      )
      .map((el) => (el.textContent ?? "").replace(/\s+/g, " ").trim())
      .filter(Boolean)
  );

/** Everything heard since `mark` (a count from `heard`). */
async function since(page: Page, mark: number) {
  return (await heard(page)).slice(mark);
}

/** Lets a step's late announcements land: call it once the step's last visible effect is on screen, and two more
 * frames have drawn. */
async function settle(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((done) =>
        requestAnimationFrame(() => requestAnimationFrame(() => done()))
      )
  );
}

function seedPopup() {
  execFileSync(
    ".venv/bin/python",
    ["-c", "from test_catalog_browse import seed_popup\nseed_popup()"],
    { env: { ...process.env, PYTHONPATH: "api:api/tests" } }
  );
}

const noBareNumbers = (messages: string[]) =>
  expect(messages.filter((text) => BARE_NUMBER.test(text))).toEqual([]);

for (const viewport of [DESKTOP, PHONE]) {
  plain.describe(`Catalog at ${viewport.width}`, () => {
    plain.use({ viewport });

    plain(
      "the popup's Add is announced once, and the copies stepper never reads a bare number",
      async ({ page }) => {
        seedPopup();
        await signInAsOwner(page, "/catalog");
        await page
          .getByRole("region", { name: "Catalog results" })
          .getByRole("button", { name: /^Switch,/ })
          .click();
        const popup = page.getByRole("dialog");
        await expect(
          popup.getByRole("button", { name: "Add 1", exact: true })
        ).toBeEnabled();
        await watch(page);

        let mark = (await heard(page)).length;
        await popup
          .getByRole("button", { name: "Increase Copies to add" })
          .click();
        await expect(
          popup.getByRole("button", { name: "Add 2", exact: true })
        ).toBeVisible();
        await settle(page);
        const stepped = await since(page, mark);
        noBareNumbers(stepped);
        // Whatever a step says, it says it once, with the stepper's name.
        expect(stepped).toEqual(["Copies to add 2"]);

        mark = (await heard(page)).length;
        await popup.getByRole("button", { name: "Add 2", exact: true }).click();
        await expect(
          popup.getByRole("button", { name: "Undo", exact: true })
        ).toBeVisible();
        await expect(
          page
            .getByRole("region", { name: "Notifications" })
            .getByText("Added 2 cards to Unsorted.")
        ).toBeAttached();
        await settle(page);
        const added = await since(page, mark);
        noBareNumbers(added);
        expect(added.filter((text) => /^Added /.test(text))).toEqual([
          "Added 2 copies to Unsorted.",
        ]);
        // A script that reads every live-region attribute and role sees the add once, too.
        expect(
          (await snapshot(page)).filter((text) => /^Added /.test(text))
        ).toEqual(["Added 2 copies to Unsorted."]);
      }
    );

    plain(
      "Add mode: queueing cards is quiet, and Add N cards is announced once",
      async ({ page }) => {
        seedPopup();
        await signInAsOwner(page, "/catalog");
        await page
          .getByRole("radiogroup", { name: "Catalog mode" })
          .getByRole("radio", { name: "Add to a Location" })
          .click();
        const results = page.getByRole("region", { name: "Catalog results" });
        const more = results.getByRole("button", { name: /^One more / });
        await expect(more.first()).toBeVisible();
        await watch(page);

        let mark = (await heard(page)).length;
        await more.first().click();
        await more.first().click();
        await more.nth(1).click();
        await expect(
          page
            .getByRole("region", { name: "Add to a Location" })
            .getByRole("button", { name: "Add 3 cards" })
        ).toBeVisible();
        await settle(page);
        const queued = await since(page, mark);
        noBareNumbers(queued);
        // A draft count is never spoken on its own: it is silent, or it says what it counts.
        expect(queued.filter((text) => /\d/.test(text))).toEqual(
          queued.filter((text) => /\bcards? queued$/.test(text))
        );

        mark = (await heard(page)).length;
        await page
          .getByRole("region", { name: "Add to a Location" })
          .getByRole("button", { name: "Add 3 cards" })
          .click();
        await expect(
          page
            .getByRole("region", { name: "Notifications" })
            .getByText(/^Added 3 cards to /)
        ).toBeVisible();
        await settle(page);
        const added = await since(page, mark);
        noBareNumbers(added);
        expect(added.filter((text) => /^Added /.test(text))).toHaveLength(1);
        // The toast with the Undo replaces the first one and is switched off, so it isn't a second live message.
        expect(
          (await snapshot(page)).filter((text) => /^Added /.test(text)).length
        ).toBeLessThanOrEqual(1);
      }
    );
  });
}

test("phone: +1 and −1 in the copy sheet are each announced once", async ({
  collectors,
}) => {
  const ids = seedCatalog();
  const { page } = await collectors.signIn({
    contextOptions: { viewport: PHONE, hasTouch: true },
  });
  await page.route(/^https:\/\/assets\.tcgdex\.net\//, (route) =>
    route.abort()
  );
  const deck = await createDeck(page, "Announce once");
  await setLine(page, deck, ids["PAL 185"], 3);
  await page.goto(`${ORIGIN}/decks/${deck}`);
  const control = page.locator("[data-edition-id]").first();
  await expect(control).toBeVisible();
  await control.tap();
  const sheet = page.getByRole("dialog", { name: "Iono", exact: true });
  await expect(sheet).toBeVisible();
  await watch(page);

  for (const [button, saying, total] of [
    [/^\+1, Add one Iono/, "Added 1 Iono.", "4"],
    [/^−1, Remove one Iono/, "Removed 1 Iono.", "3"],
  ] as const) {
    const mark = (await heard(page)).length;
    await sheet.getByRole("button", { name: button }).tap();
    await expect(
      sheet.getByRole("group", { name: "Deck List copies" }).locator("strong")
    ).toHaveText(total);
    await expect(sheet.getByText(saying)).toBeVisible();
    await settle(page);
    const said = await since(page, mark);
    noBareNumbers(said);
    expect(said).toEqual([saying]);
    expect(
      (await snapshot(page)).filter((text) => text.includes(saying))
    ).toEqual([saying]);
  }
});

test("desktop: the − and + on a Deck card are each announced once", async ({
  collectors,
}) => {
  const ids = seedCatalog();
  const { page } = await collectors.signIn({
    contextOptions: { viewport: DESKTOP },
  });
  await page.route(/^https:\/\/assets\.tcgdex\.net\//, (route) =>
    route.abort()
  );
  const deck = await createDeck(page, "Announce hover");
  await setLine(page, deck, ids["PAL 185"], 3);
  await page.goto(`${ORIGIN}/decks/${deck}`);
  await expect(page.locator("[data-edition-id]").first()).toBeVisible();
  await watch(page);
  const toast = page.getByRole("region", { name: "Notifications" });

  for (const [button, saying] of [
    ["Add one Iono", "Added 1 Iono."],
    ["Remove one Iono", "Removed 1 Iono."],
  ] as const) {
    const mark = (await heard(page)).length;
    // The − and + show over the card while the pointer is on it.
    await page.locator("[data-edition-id]").first().hover();
    await page
      .getByRole("button", { name: button, exact: true })
      .first()
      .click();
    await expect(toast).toContainText(saying);
    await settle(page);
    const said = await since(page, mark);
    noBareNumbers(said);
    expect(said.filter((text) => text.startsWith(saying))).toHaveLength(1);
    expect(
      (await snapshot(page)).filter((text) => text.startsWith(saying))
    ).toHaveLength(1);
  }
});

plain.describe("Collection's Add cards", () => {
  plain.use({ viewport: DESKTOP });

  plain(
    "Add N cards and the popup's Add are each announced once",
    async ({ page }) => {
      seedPopup();
      const pool = new Pool({ connectionString: process.env.DATABASE_URL });
      try {
        await pool.query("DELETE FROM auth_send_event");
        await startAsNewOwner(pool);
      } finally {
        await pool.end();
      }
      await signInAsOwner(page, "/collection");
      await page
        .getByRole("button", { name: "Add cards", exact: true })
        .click();
      const add = page.getByRole("dialog", { name: /^Add cards/ });
      await expect(add).toBeVisible();
      const results = add.getByRole("region", { name: "Catalog results" });
      await expect(
        results.getByRole("button", { name: /^One more / }).first()
      ).toBeVisible();
      await watch(page);
      const toast = page.getByRole("region", { name: "Notifications" });

      // The popup's Add inside Add cards: said once, in the popup.
      await results.getByRole("button", { name: /^Switch,/ }).click();
      const popup = page.getByRole("dialog", { name: "Switch" });
      await expect(
        popup.getByRole("button", { name: "Add 1", exact: true })
      ).toBeEnabled();
      let mark = (await heard(page)).length;
      await popup.getByRole("button", { name: "Add 1", exact: true }).click();
      await expect(
        popup.getByRole("button", { name: "Undo", exact: true })
      ).toBeVisible();
      await expect(toast).toContainText(/^Added 1 card to /);
      await settle(page);
      let said = await since(page, mark);
      noBareNumbers(said);
      expect(said.filter((text) => /^Added /.test(text))).toHaveLength(1);
      expect(
        (await snapshot(page)).filter((text) => /^Added /.test(text))
      ).toHaveLength(1);
      // Closing the popup doesn't say the add again, in the gallery behind it or in the toast.
      mark = (await heard(page)).length;
      await page.keyboard.press("Escape");
      await expect(popup).toHaveCount(0);
      await expect(add).toBeVisible();
      await settle(page);
      expect(
        (await since(page, mark)).filter((text) => /^Added /.test(text))
      ).toEqual([]);

      // Add N cards: the dialog closes and Collection's toast says it once.
      mark = (await heard(page)).length;
      await results
        .getByRole("button", { name: /^One more / })
        .first()
        .click();
      await results
        .getByRole("button", { name: /^One more / })
        .first()
        .click();
      await add
        .getByRole("region", { name: "Add to a Location" })
        .getByRole("button", { name: "Add 2 cards" })
        .click();
      await expect(add).toHaveCount(0);
      await expect(toast).toContainText(/^Added 2 cards to /);
      await settle(page);
      said = await since(page, mark);
      noBareNumbers(said);
      expect(said.filter((text) => /^Added /.test(text))).toHaveLength(1);
      expect(
        (await snapshot(page)).filter((text) => /^Added /.test(text))
      ).toHaveLength(1);
    }
  );
});

plain(
  "Want List: loading prices does not read out the cost summary",
  async ({ page }) => {
    plain.setTimeout(120_000);
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    try {
      await pool.query("DELETE FROM auth_send_event");
      await startAsNewOwner(pool);
    } finally {
      await pool.end();
    }
    const ids = seedCatalog();
    await page.route(/^https:\/\/assets\.tcgdex\.net\//, (route) =>
      route.abort()
    );
    await signInAsOwner(page, "/decks");
    const deck = await createDeck(page, `Announce ${randomUUID().slice(0, 6)}`);
    await setLine(page, deck, ids["PAL 185"], 3);
    await setLine(page, deck, ids["PAL 172"], 2);
    await api(page, "GET", `/api/decks/${deck}`);
    await page.goto(`${ORIGIN}/decks`);
    await watch(page);
    await page.goto(`${ORIGIN}/decks/want-list`);
    await expect(page.getByText("Estimated cost").first()).toBeVisible();
    await expect(
      page.getByText(/cards priced|Price unavailable/).first()
    ).toBeVisible();
    await settle(page);
    const said = await heard(page);
    noBareNumbers(said);
    expect(
      said.filter((text) =>
        /Estimated cost|Checking prices|cards priced|Price unavailable|\$\d/.test(
          text
        )
      )
    ).toEqual([]);
    expect(
      (await snapshot(page)).filter((text) => /Estimated cost/.test(text))
    ).toEqual([]);
  }
);

// The same words twice in a row. A polite region speaks what is added to it, so "Added 1 Iono." drawn over an identical
// "Added 1 Iono." changes nothing and is silent. Each completed edit must add content to the same mounted
// [data-edit-feedback] region, and the toast behind the modal stays quiet, so this is the only announcement. These
// cases read the region itself (a text addition inside it for every action), not the aria-live filtering `watch` does.
for (const surface of ["copy sheet on a phone", "library popup on a desktop"]) {
  const phone = surface.includes("phone");
  test(`${surface}: repeated +1 and −1, and Undo, are each announced in the mounted status line`, async ({
    collectors,
  }) => {
    const ids = seedCatalog();
    const { page } = await collectors.signIn({
      contextOptions: phone
        ? { viewport: PHONE, hasTouch: true }
        : { viewport: DESKTOP },
    });
    await page.route(/^https:\/\/assets\.tcgdex\.net\//, (route) =>
      route.abort()
    );
    const deck = await createDeck(page, "Announce repeats");
    await setLine(page, deck, ids["PAL 185"], 3);
    await page.goto(`${ORIGIN}/decks/${deck}`);
    let dialog;
    if (phone) {
      const control = page.locator("[data-edition-id]").first();
      await expect(control).toBeVisible();
      await control.tap();
      dialog = page.getByRole("dialog", { name: "Iono", exact: true });
    } else {
      const library = page.getByRole("complementary", { name: "Library" });
      await library.getByRole("radio", { name: "All" }).click();
      await library.getByRole("button", { name: /^Iono, PAL 185, / }).click();
      dialog = page.getByRole("dialog", { name: "Iono", exact: true });
    }
    await expect(dialog).toBeVisible();
    const line = dialog.locator("[data-edit-feedback]");
    await expect(line).toHaveAttribute("role", "status");
    const count = dialog
      .getByRole("group", { name: "Deck List copies" })
      .locator("strong");
    await expect(count).toHaveText("3");

    // Count each batch of mutations that adds words to this one element, and keep a handle on it to prove it stays.
    await page.evaluate(() => {
      const el = document.querySelector("dialog[open] [data-edit-feedback]")!;
      const log: string[] = [];
      const w = window as unknown as { __line: Element; __log: string[] };
      w.__line = el;
      w.__log = log;
      new MutationObserver((records) => {
        const added = records.flatMap((record) =>
          record.type === "characterData"
            ? [record.target.textContent ?? ""]
            : [...record.addedNodes].map((node) => node.textContent ?? "")
        );
        const words = added.join(" ").trim();
        if (words) log.push(words);
      }).observe(el, { childList: true, characterData: true, subtree: true });
    });
    const additions = () =>
      page.evaluate(() => (window as unknown as { __log: string[] }).__log);
    const sameElement = () =>
      page.evaluate(
        () =>
          (window as unknown as { __line: Element }).__line ===
            document.querySelector("dialog[open] [data-edit-feedback]") &&
          (window as unknown as { __line: Element }).__line.isConnected
      );
    const press = (name: RegExp) =>
      phone
        ? dialog.getByRole("button", { name }).tap()
        : dialog.getByRole("button", { name }).click();

    let total = 3;
    for (const [name, saying, delta] of [
      [/^\+1, Add one Iono/, "Added 1 Iono.", 1],
      [/^\+1, Add one Iono/, "Added 1 Iono.", 1],
      [/^−1, Remove one Iono/, "Removed 1 Iono.", -1],
      [/^−1, Remove one Iono/, "Removed 1 Iono.", -1],
      [/^−1, Remove one Iono/, "Removed 1 Iono.", -1],
    ] as const) {
      const before = (await additions()).length;
      total += delta;
      await press(name);
      await expect(count).toHaveText(String(total));
      await expect
        .poll(async () => (await additions()).length)
        .toBe(before + 1);
      await settle(page);
      expect((await additions()).slice(before)).toEqual([saying]);
      await expect(line).toHaveText(saying);
      expect(await sameElement()).toBe(true);
      // The toast is behind the modal, so it must not announce the same edit.
      await expect(page.locator("#app-toasts")).toHaveAttribute(
        "aria-live",
        "off"
      );
    }

    // Undo says its own words in the same line.
    const before = (await additions()).length;
    await press(/^Undo$/);
    await expect(count).toHaveText(String(total + 1));
    await expect.poll(async () => (await additions()).length).toBe(before + 1);
    await settle(page);
    expect((await additions()).slice(before)).toEqual([
      "Undone: Removed 1 Iono.",
    ]);
    expect(await sameElement()).toBe(true);
  });
}

// One announcement per outcome, silence while it is pending. A retried Undo, and a failed change tried again, are the
// places a pending state used to say words (the Undo's original success came back while it ran). `watch` records every
// addition to a live region a screen reader would speak; the phone copy sheet says it in its own status line, a desktop
// Deck card in the toast, and a failed change in the sheet's notice line or the page's banner.
const CHANGES = /\/api\/decks\/[^/]+\/deck-list\/changes/;

/** What was said since `mark`, leaving out the Deck's legality summary ("Standard: Not legal, 3 issues"), which the
 * desktop page redraws after every change: a result of the edit, and not the words about the edit that these cases are
 * about. */
const spokenSince = async (page: Page, mark: number) =>
  (await since(page, mark)).filter(
    (text) => !/^(Standard|Expanded|GLC): /.test(text)
  );

for (const surface of ["phone copy sheet", "desktop Deck card"]) {
  const phone = surface.startsWith("phone");
  async function open(collectors: {
    signIn: (options?: OtherCollectorOptions) => Promise<OtherCollector>;
  }) {
    const ids = seedCatalog();
    const { page } = await collectors.signIn({
      contextOptions: phone
        ? { viewport: PHONE, hasTouch: true }
        : { viewport: DESKTOP },
    });
    await page.route(/^https:\/\/assets\.tcgdex\.net\//, (route) =>
      route.abort()
    );
    const deck = await createDeck(page, "Announce pending");
    await setLine(page, deck, ids["PAL 185"], 3);
    await page.goto(`${ORIGIN}/decks/${deck}`);
    const card = page.locator("[data-edition-id]").first();
    await expect(card).toBeVisible();
    let scope = page.locator("body");
    if (phone) {
      await card.tap();
      scope = page.getByRole("dialog", { name: "Iono", exact: true });
      await expect(scope).toBeVisible();
    }
    const toast = page.getByRole("region", { name: "Notifications" });
    const tap = (target: ReturnType<Page["locator"]>) =>
      phone ? target.tap() : target.click();
    return {
      page,
      add: async () => {
        if (phone)
          await tap(scope.getByRole("button", { name: /^\+1, Add one Iono/ }));
        else {
          await card.hover();
          await page
            .getByRole("button", { name: "Add one Iono", exact: true })
            .first()
            .click();
        }
      },
      undo: () =>
        tap(
          (phone ? scope : toast).getByRole("button", {
            name: "Undo",
            exact: true,
          })
        ),
      tryAgain: () =>
        tap((phone ? scope : page).getByRole("button", { name: "Try again" })),
    };
  }

  test(`${surface}: an Undo that is retried says nothing while it runs, then its one outcome`, async ({
    collectors,
  }) => {
    const ui = await open(collectors);
    const { page } = ui;
    let call = 0;
    let arrived!: () => void;
    const reached = new Promise<void>((resolve) => (arrived = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    await page.route(CHANGES, async (route) => {
      call += 1;
      // 1: the +1. 2: its Undo, which gets no answer. 3: Undo again, held until released.
      if (call === 2) return route.abort("failed");
      if (call === 3) {
        arrived();
        await gate;
      }
      return route.continue();
    });
    await watch(page);

    let mark = (await heard(page)).length;
    await ui.add();
    await expect
      .poll(async () => await spokenSince(page, mark))
      .toHaveLength(1);
    await settle(page);
    expect(await spokenSince(page, mark)).toEqual([
      expect.stringMatching(/^Added 1 Iono\./),
    ]);

    mark = (await heard(page)).length;
    await ui.undo();
    await expect
      .poll(async () => (await spokenSince(page, mark)).length)
      .toBe(1);
    await settle(page);
    expect(await spokenSince(page, mark)).toEqual([
      expect.stringMatching(/^Undo may not have finished/),
    ]);

    // Pressing Undo again: nothing is said while the request is on its way.
    mark = (await heard(page)).length;
    await ui.undo();
    await reached;
    await settle(page);
    expect(await spokenSince(page, mark)).toEqual([]);

    release();
    await expect
      .poll(async () => (await spokenSince(page, mark)).length)
      .toBe(1);
    await settle(page);
    const outcome = await spokenSince(page, mark);
    expect(outcome).toEqual([expect.stringMatching(/^Undone: Added 1 Iono\./)]);
    expect(outcome.filter((text) => /^Added 1 /.test(text))).toEqual([]);
  });

  test(`${surface}: a failed change tried again and failing the same way is announced each time`, async ({
    collectors,
  }) => {
    const ui = await open(collectors);
    const { page } = ui;
    await page.route(CHANGES, (route) => route.abort("failed"));
    await watch(page);
    const failed = (texts: string[]) =>
      texts.filter((text) =>
        /Your last Deck List change may not have been saved/.test(text)
      );

    const mark = (await heard(page)).length;
    await ui.add();
    await expect
      .poll(async () => failed(await since(page, mark)).length)
      .toBe(1);
    await ui.tryAgain();
    await expect
      .poll(async () => failed(await since(page, mark)).length)
      .toBe(2);
    await settle(page);
    expect(failed(await since(page, mark))).toHaveLength(2);
  });
}
