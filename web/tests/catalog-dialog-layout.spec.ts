import { expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { test as collectorTest } from "./support/collectors";
import {
  accountId,
  api,
  befriend,
  createDeck,
  hold,
  nameCollector,
  seedCatalog,
  unsorted,
} from "./support/loans";
import { forTradeLeaf, propose } from "./support/trades";
import { expectPageChecks } from "./support/page-check";
import { test, artUpstream } from "./support/art-upstream";
import { startAsNewOwner } from "./support/owner";
import { signInAsOwner } from "./support/sign-in";
import { expectTouchTarget } from "./support/touch-target";

async function prepare(page: Page) {
  (await artUpstream()).reset();
  execFileSync(
    ".venv/bin/python",
    ["-c", "from test_catalog_browse import seed_popup\nseed_popup()"],
    {
      env: { ...process.env, PYTHONPATH: "api:api/tests" },
    }
  );
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await startAsNewOwner(pool);
    await pool.query("DELETE FROM auth_send_event");
  } finally {
    await pool.end();
  }
  await signInAsOwner(page, "/catalog");
}

async function observe(page: Page) {
  await page.evaluate(() => {
    const messages: string[] = [];
    const last = new WeakMap<Element, string>();
    const selector =
      '[role="status"], [role="alert"], [aria-live], #app-toasts';
    document
      .querySelectorAll(selector)
      .forEach((el) => last.set(el, el.textContent ?? ""));
    new MutationObserver(() => {
      document.querySelectorAll(selector).forEach((el) => {
        const text = (
          (el.id === "app-toasts"
            ? el.querySelector("p")?.textContent
            : el.textContent) ?? ""
        ).trim();
        if (last.get(el) === text) return;
        last.set(el, text);
        if (el.closest('[aria-live="off"]')) return;
        if (
          /^(Added |Undo removed|Undo may not|This Edition is no longer available)/.test(
            text
          )
        )
          messages.push(text);
      });
      document.documentElement.dataset.dialogAnnouncements =
        JSON.stringify(messages);
    }).observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  });
}

for (const phone of [false, true]) {
  test.describe(phone ? "phone dialog layout" : "desktop dialog layout", () => {
    test.use({
      viewport: phone
        ? { width: 375, height: 812 }
        : { width: 1280, height: 800 },
      isMobile: phone,
      hasTouch: phone,
      deviceScaleFactor: phone ? 2 : 1,
    });
    test("bar Add and Undo each announce once", async ({ page }) => {
      await prepare(page);
      await page
        .getByRole("radio", { name: "Add to a Location", exact: true })
        .click();
      await page
        .getByRole("button", {
          name: "One more Bulbasaur MEG 001 Normal",
          exact: true,
        })
        .click();
      await observe(page);
      await page
        .getByRole("region", { name: "Add to a Location" })
        .getByRole("button", { name: "Add 1 card", exact: true })
        .click();
      const toast = page.locator("#app-toasts");
      await expect(toast).toContainText("Added 1 card");
      await expect
        .poll(
          async () =>
            JSON.parse(
              (await page
                .locator("html")
                .getAttribute("data-dialog-announcements")) ?? "[]"
            ).length
        )
        .toBe(1);
      await toast.getByRole("button", { name: "Undo", exact: true }).click();
      await expect(toast).toContainText("Undo removed");
      await expect
        .poll(
          async () =>
            JSON.parse(
              (await page
                .locator("html")
                .getAttribute("data-dialog-announcements")) ?? "[]"
            ).length
        )
        .toBe(2);
    });
    test("closing after inline Add while Undo lookup waits does not repeat the announcement", async ({
      page,
    }) => {
      await prepare(page);
      await page
        .getByRole("region", { name: "Catalog results" })
        .getByRole("button", { name: /^Bulbasaur,/ })
        .first()
        .click();
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.route("**/api/moves/undo", async (route) => {
        await held;
        await route.continue();
      });
      await observe(page);
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("button", { name: "Add 1", exact: true }).click();
      await expect(
        dialog.getByRole("status").filter({ hasText: "Added 1 copy" })
      ).toBeVisible();
      await page.keyboard.press("Escape");
      release();
      await expect(
        page
          .locator("#app-toasts")
          .getByRole("button", { name: "Undo", exact: true })
      ).toBeVisible();
      await expect
        .poll(
          async () =>
            JSON.parse(
              (await page
                .locator("html")
                .getAttribute("data-dialog-announcements")) ?? "[]"
            ).length
        )
        .toBe(1);
    });
    for (const artwork of ["loaded", "missing", "failed", "long"] as const) {
      test(`${artwork}: Add is visible at the start and feedback stays inside the dialog`, async ({
        page,
      }, testInfo) => {
        await prepare(page);
        if (artwork === "long") {
          // Many ownership rows make the details genuinely taller than the phone viewport.
          // Read the long-name card from the same browse API rather than assuming a fixture identifier.
          const browse = await page.request.get(
            new URL("/api/catalog/editions?q=Professor", page.url()).href
          );
          const editionId = (await browse.json()).editions[0].edition_id;
          const origin = new URL(page.url()).origin;
          for (const index of Array.from({ length: 12 }, (_, index) => index)) {
            const created = await page.request.post(
              new URL("/api/location-tree", page.url()).href,
              {
                headers: { origin },
                data: {
                  name: `Binder ${index + 1}`,
                  parent_id: null,
                  parent_version: null,
                  idempotency_key: randomUUID(),
                },
              }
            );
            expect(created.status()).toBe(201);
            const locationId = (await created.json()).location.id;
            const added = await page.request.post(
              new URL("/api/holdings", page.url()).href,
              {
                headers: { origin },
                data: {
                  location_id: locationId,
                  edition_id: editionId,
                  quantity: "1",
                  idempotency_key: randomUUID(),
                },
              }
            );
            expect(added.status()).toBe(200);
          }
          await page.reload();
        }
        if (artwork === "failed")
          await page.route("**/api/art/**", (route) => route.abort());
        const main = page.getByRole("main");
        if (phone) {
          await expect
            .poll(async () => {
              const input = await page
                .getByRole("searchbox", { name: "Search the catalog" })
                .boundingBox();
              const content = await main.boundingBox();
              return input!.y - content!.y;
            })
            .toBeLessThanOrEqual(150);
        }
        await expect(
          page.getByRole("radiogroup", { name: "Catalog mode" })
        ).toBeVisible();
        await expect(
          page.getByRole("button", { name: "My metadata reports" })
        ).toBeVisible();
        const name =
          artwork === "missing"
            ? "Switch,"
            : artwork === "long"
              ? "Professor's Research (Professor Juniper),"
              : "Bulbasaur,";
        await page
          .getByRole("searchbox", { name: "Search the catalog" })
          .fill(
            artwork === "missing"
              ? "Switch"
              : artwork === "long"
                ? "Professor"
                : "Bulbasaur"
          );
        await expect(
          page
            .getByRole("region", { name: "Catalog results" })
            .getByRole("listitem")
        ).toHaveCount(artwork === "missing" || artwork === "long" ? 1 : 2);
        await page.evaluate(() => window.scrollTo(0, 0));
        await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
        await page
          .getByRole("region", { name: "Catalog results" })
          .getByRole("button", {
            name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
          })
          .first()
          .click();
        const dialog = page.getByRole("dialog");
        const group = dialog.getByRole("group", { name: "Add to Collection" });
        if (artwork === "long")
          await expect(
            dialog
              .getByRole("list", { name: "Copies by location" })
              .getByRole("listitem")
          ).toHaveCount(12);
        const first = group.locator("select, input, button").first();
        await expect(first).toBeVisible();
        await expect
          .poll(async () =>
            first.evaluate((el) => {
              const rect = el.getBoundingClientRect();
              const frame = el.closest("dialog")!.getBoundingClientRect();
              return rect.bottom <= Math.min(innerHeight, frame.bottom);
            })
          )
          .toBe(true);
        await expect
          .poll(() => dialog.evaluate((el) => el.scrollWidth <= el.clientWidth))
          .toBe(true);
        await expect
          .poll(() =>
            page.evaluate(
              () =>
                document.documentElement.scrollWidth <=
                document.documentElement.clientWidth
            )
          )
          .toBe(true);
        if (phone)
          for (const control of await group
            .locator("button, input, select")
            .all())
            await expectTouchTarget(control);
        const measurements = {
          first: await first.boundingBox(),
          add: await group
            .getByRole("button", { name: "Add 1", exact: true })
            .boundingBox(),
          searchFromMain: await page
            .getByRole("searchbox", { name: "Search the catalog" })
            .evaluate(
              (el) =>
                el.getBoundingClientRect().top -
                el.closest("main")!.getBoundingClientRect().top
            ),
          dialogScroll: await dialog
            .locator('[data-scroll-viewport="y"]')
            .first()
            .evaluate((el) => el.scrollTop),
        };
        await testInfo.attach("initial-control", {
          body: JSON.stringify(measurements),
          contentType: "application/json",
        });
        await expect(
          dialog.locator('[data-scroll-viewport="y"]').first()
        ).toHaveJSProperty("scrollTop", 0);
        await testInfo.attach("dialog-initial", {
          body: await page.screenshot(),
          contentType: "image/png",
        });
        await observe(page);
        const add = group.getByRole("button", { name: "Add 1", exact: true });
        await add.click();
        const undo = dialog.getByRole("button", { name: "Undo", exact: true });
        await expect(undo).toBeVisible();
        await expect
          .poll(() =>
            undo.evaluate((el) => {
              const viewport =
                el.closest("[data-scroll-viewport]") ??
                [...el.closest("dialog")!.querySelectorAll("div")].find(
                  (node) => getComputedStyle(node).overflowY === "auto"
                )!;
              const bounds = viewport.getBoundingClientRect();
              const action = el.getBoundingClientRect();
              const text = el
                .parentElement!.querySelector('[role="status"]')!
                .getBoundingClientRect();
              return (
                action.top >= bounds.top &&
                action.bottom <= bounds.bottom &&
                text.top >= bounds.top &&
                text.bottom <= bounds.bottom
              );
            })
          )
          .toBe(true);
        await expect(add).toBeFocused();
        await expect
          .poll(() =>
            page.locator("html").getAttribute("data-dialog-announcements")
          )
          .toMatch(/^\["Added [^"]+"\]$/);
        await undo.click();
        await expect(
          dialog.getByRole("status").filter({ hasText: "Undo removed" })
        ).toContainText("Undo removed");
        await expect
          .poll(
            async () =>
              JSON.parse(
                (await page
                  .locator("html")
                  .getAttribute("data-dialog-announcements")) ?? "[]"
              ).length
          )
          .toBe(2);
        await expect(add).toBeFocused();
      });
    }
  });
}

for (const viewport of [
  { width: 1280, height: 800 },
  { width: 375, height: 812 },
]) {
  collectorTest.describe(`shared card dialogs ${viewport.width}`, () => {
    collectorTest.use({ viewport, hasTouch: true });
    for (const consumer of ["Trade Terms", "Loan"] as const) {
      collectorTest(
        `${consumer}: details fit and Close remains visible`,
        async ({ page, collectors }, testInfo) => {
          const ids = seedCatalog();
          const friend = (await collectors.signIn({ next: "/loans" })).page;
          await nameCollector(friend, "Sam");
          await signInAsOwner(page, "/loans");
          await nameCollector(page, "Alex");
          await page.route("**/api/art/**", (route) => route.abort());
          await befriend(page, friend);
          if (consumer === "Loan") {
            await hold(page, await unsorted(page), ids["PAL 185"], 4);
            const deck = await createDeck(friend, "Borrower Deck");
            const sent = await api(friend, "POST", "/api/loans", {
              lender_id: await accountId(page),
              lines: [{ edition_id: ids["PAL 185"], quantity: "2" }],
              deck_id: deck,
              idempotency_key: randomUUID(),
            });
            await page.goto(new URL(`/loans/${sent.id}`, page.url()).href);
            await page
              .getByRole("list", { name: "Cards", exact: true })
              .getByRole("button", { name: /^Card details for Iono, PAL 185/ })
              .click();
          } else {
            await hold(
              page,
              await forTradeLeaf(page, "Offer binder"),
              ids["PAL 185"],
              2
            );
            await hold(
              friend,
              await forTradeLeaf(friend, "Friend binder"),
              ids["SVI 166"],
              2
            );
            const id = await propose(
              page,
              await accountId(friend),
              [[ids["PAL 185"], 1]],
              [[ids["SVI 166"], 1]]
            );
            await page.goto(new URL(`/trades/${id}`, page.url()).href);
            await page
              .getByRole("list", { name: "You give", exact: true })
              .getByRole("button", { name: /^Iono PAL 185/ })
              .click();
          }
          const dialog = page.getByRole("dialog", {
            name: "Iono",
            exact: true,
          });
          const close = dialog.getByRole("button", {
            name: "Close card details",
            exact: true,
          });
          await expect(close).toBeVisible();
          await expect
            .poll(() =>
              close.evaluate((el) => {
                const r = el.getBoundingClientRect();
                return r.top >= 0 && r.bottom <= innerHeight;
              })
            )
            .toBe(true);
          await expect
            .poll(() =>
              dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)
            )
            .toBe(true);
          await expectPageChecks(page, `${consumer} card dialog`);
          await testInfo.attach("shared-dialog", {
            body: await page.screenshot(),
            contentType: "image/png",
          });
          await testInfo.attach("shared-dialog-measurements", {
            body: JSON.stringify({
              dialog: await dialog.boundingBox(),
              close: await close.boundingBox(),
              viewport,
            }),
            contentType: "application/json",
          });
        }
      );
    }
  });
}
