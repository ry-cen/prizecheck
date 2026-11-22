import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { expect, test } from "./support/collectors";
import {
  accountId,
  api,
  befriend,
  hold,
  lendHandedOver,
  loanView,
  nameCollector,
  ORIGIN,
  seedCatalog,
  unsorted,
} from "./support/loans";
import {
  DESKTOP_SIZE,
  PHONE_SIZE,
  propose,
  tradeView,
  forTradeLeaf,
} from "./support/trades";
import { signInAsOwner } from "./support/sign-in";
import { Pool } from "pg";
import { listCards } from "./support/deck-list";

async function expectClosedQuiet(page: Page) {
  await expect
    .poll(() =>
      page.locator("dialog:not([open])").evaluateAll((dialogs) =>
        dialogs
          .flatMap((d) => [
            ...d.querySelectorAll('[role="status"],[role="alert"],[aria-live]'),
          ])
          .map((e) => e.textContent?.trim())
          .filter((t) =>
            /Loading lent cards|Loading borrowed cards|Finding where your cards are|Loading sets/.test(
              t ?? ""
            )
          )
      )
    )
    .toEqual([]);
}

for (const [label, size] of [
  ["desktop", DESKTOP_SIZE],
  ["phone", PHONE_SIZE],
] as const) {
  test.describe(label, () => {
    test.use(size);
    test("closed dialogs carry no loading status", async ({ page }) => {
      const ids = seedCatalog();
      await signInAsOwner(page, "/catalog");
      let release!: () => void;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.route(`${ORIGIN}/api/catalog/sets`, async (route) => {
        await pending;
        await route.continue();
      });
      await page.getByRole("button", { name: "Any set", exact: true }).click();
      await expect(
        page.getByRole("status").filter({ hasText: "Loading sets…" })
      ).toBeVisible();
      await page.keyboard.press("Escape");
      await expectClosedQuiet(page);
      const setsRead = page.waitForResponse(`${ORIGIN}/api/catalog/sets`);
      release();
      await setsRead;
      await page.unroute(`${ORIGIN}/api/catalog/sets`);
      await page
        .getByRole("navigation", { name: "Main views" })
        .filter({ visible: true })
        .getByRole("button", { name: "Collection", exact: true })
        .click();
      await expect(page).toHaveURL(`${ORIGIN}/collection`);
      await expect(
        page
          .locator("[hidden]")
          .filter({
            has: page.getByRole("heading", {
              name: "Catalog",
              includeHidden: true,
            }),
          })
          .first()
      ).toBeAttached();
      await expectClosedQuiet(page);
      const deck = (
        await api(page, "POST", "/api/decks", {
          name: "Feedback Deck",
          idempotency_key: randomUUID(),
        })
      ).location.id as string;
      await hold(page, await unsorted(page), ids["PAL 185"], 1);
      const pool = new Pool({ connectionString: process.env.DATABASE_URL });
      try {
        const owner = (
          await pool.query("SELECT owner_id FROM location WHERE id=$1", [deck])
        ).rows[0].owner_id;
        await listCards(pool, owner, deck, { [ids["PAL 185"]]: 1 });
      } finally {
        await pool.end();
      }
      await page.goto(`${ORIGIN}/decks/${deck}`);
      await expectClosedQuiet(page);
      let finish!: () => void;
      const gate = new Promise<void>((resolve) => {
        finish = resolve;
      });
      await page.route(`**/api/decks/${deck}/pick-list`, async (route) => {
        await gate;
        await route.continue();
      });
      await page.getByRole("button", { name: "Gather 1", exact: true }).click();
      await expect(
        page
          .getByRole("status")
          .filter({ hasText: "Finding where your cards are…" })
      ).toBeVisible();
      await page.keyboard.press("Escape");
      await expectClosedQuiet(page);
      const pickRead = page.waitForResponse(`**/api/decks/${deck}/pick-list`);
      finish();
      await pickRead;
      await page.unroute(`**/api/decks/${deck}/pick-list`);
      await page.getByRole("button", { name: "Gather 1", exact: true }).click();
      await expect(
        page.getByRole("dialog", { name: "Gather cards you own" })
      ).toContainText(
        "Copies outside your Decks come first, from as few Locations as possible; another Deck only when nothing else has the card."
      );
    });

    test("Move names destinations that can hold cards", async ({ page }) => {
      const ids = seedCatalog();
      await signInAsOwner(page, "/collection");
      await hold(page, await unsorted(page), ids["PAL 185"], 1);
      await page.reload();
      if (label === "phone")
        await page.getByRole("button", { name: "Select", exact: true }).click();
      await page
        .getByRole("region", { name: "Cards", exact: true })
        .getByRole("button", { name: /Iono/ })
        .first()
        .click();
      const selection = page.getByRole("region", { name: "Selection" });
      await selection
        .getByRole("button", { name: "Actions", exact: true })
        .click();
      await selection
        .getByRole("button", { name: "Move…", exact: true })
        .click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toContainText(
        "Choose a Location that can hold cards, or a Deck."
      );
      await dialog
        .getByRole("searchbox", { name: "Search locations" })
        .fill("No matching place");
      await expect(dialog).toContainText(
        "No Location or Deck that can hold cards matches “No matching place”."
      );
    });

    test("a returned Loan shows no error-coloured success", async ({
      page,
      collectors,
    }) => {
      const ids = seedCatalog();
      const lender = (
        await collectors.signIn({ next: "/loans", contextOptions: size })
      ).page;
      await nameCollector(lender, "Misty W");
      await hold(lender, await unsorted(lender), ids["PAL 185"], 3);
      await signInAsOwner(page, "/loans");
      await nameCollector(page, "Ash K");
      await befriend(page, lender);
      const round = await lendHandedOver(lender, page, [[ids["PAL 185"], 3]]);
      const id = (await loanView(page, round)).thread_id;
      await page.goto(`${ORIGIN}/loans/${id}`);
      await page.getByRole("button", { name: "Some back" }).click();
      await page.getByRole("button", { name: "Give these back" }).click();
      await expect
        .poll(
          async () => (await loanView(page, id)).pending_return?.lines.length
        )
        .toBe(1);
      await expect(page.getByRole("heading", { level: 1 })).toContainText(
        "Waiting for Misty W to confirm"
      );
      await expect(page.getByRole("main")).not.toContainText("It was sent.");
      await expect(
        page.getByRole("main").getByRole("alert", { includeHidden: true })
      ).toHaveText("");
    });

    if (label === "desktop")
      test("a declined Trade's header keeps a space before the handle", async ({
        page,
        collectors,
      }) => {
        const ids = seedCatalog();
        const friend = (await collectors.signIn()).page;
        await nameCollector(friend, "Misty W");
        await signInAsOwner(page, "/trades");
        await nameCollector(page, "Ash K");
        await befriend(page, friend);
        await hold(
          friend,
          await forTradeLeaf(friend, "Trade box"),
          ids["PAL 185"],
          1
        );
        const id = await propose(
          friend,
          await accountId(page),
          [[ids["PAL 185"], 1]],
          []
        );
        const trade = await tradeView(page, id);
        await api(page, "POST", `/api/trades/${id}/decline`, {
          offer_id: trade.offer_id,
          revision: trade.revision,
          idempotency_key: randomUUID(),
        });
        await page.goto(`${ORIGIN}/trades/${id}`);
        const header = page
          .getByRole("main")
          .locator("p")
          .filter({ hasText: /^Trade with Misty W/ });
        await expect
          .poll(() => header.innerText())
          .toMatch(/^Trade with Misty W @\S+$/);
        await expect(header.getByRole("link")).toHaveText(/^@\S+$/);
      });
  });
}
