import type { Route } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { test, expect } from "./support/collectors";
import { createDeck, ORIGIN, setLine } from "./support/loans";

for (const viewport of [
  { width: 1280, height: 800 },
  { width: 375, height: 812 },
]) {
  for (const outcome of [
    "delayed",
    "failed",
    "reconnect",
    "target",
    "conflict",
    "conflict-failed",
  ] as const) {
    const conflicts = outcome === "conflict" || outcome === "conflict-failed";
    test(`Buy missing waits for the current count (${outcome}, ${viewport.width}px)`, async ({
      collectors,
    }) => {
      const output = execFileSync(
        ".venv/bin/python",
        [
          "-c",
          `
from test_prices import ui_world, ui_apply
edition = ui_world(0)["normal"]
ui_apply([{"op": "quote", "edition": edition, "amount": "0.25"}])
print("EDITION" + edition)
`,
        ],
        { env: { ...process.env, PYTHONPATH: "api:api/tests" } }
      ).toString();
      const edition = output.slice(output.lastIndexOf("EDITION") + 7).trim();
      const owner = await collectors.signIn({ contextOptions: { viewport } });
      const page = owner.page;
      const deck = await createDeck(page, `Count ${randomUUID()}`);
      await setLine(page, deck, edition, 60);
      const url = `${ORIGIN}/api/decks/${deck}`;
      await page.goto(`${ORIGIN}/decks/${deck}`);
      const summary = page.getByRole("group", {
        name: "Where this Deck's cards are",
      });
      await expect(summary).toContainText("Not owned60");
      await expect(page.getByText(/ to complete/)).toContainText(
        "60/60 priced"
      );
      const buy = page.getByRole("button", {
        name: "Buy missing",
        exact: true,
      });
      await buy.click();
      const dialog = page.getByRole("dialog", { name: "Export", exact: true });
      await expect(
        dialog.getByRole("radio", {
          name: "Cards you don't own (60)",
          exact: true,
        })
      ).toBeChecked();
      await dialog.getByRole("button", { name: "Close export" }).click();
      await page.getByRole("radio", { name: "List", exact: true }).click();
      let release!: () => void;
      let arrived!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const requested = new Promise<void>((resolve) => {
        arrived = resolve;
      });
      let held = false;
      let deckReads = 0;
      // Every GET of the Deck once the page is open, whether or not a route handles it.
      let idleReads = 0;
      page.on("request", (request) => {
        if (request.method() === "GET" && request.url() === url) idleReads++;
      });
      const holdRead = async (route: Route) => {
        if (route.request().method() !== "GET") return route.fallback();
        deckReads++;
        if (held) return route.continue();
        held = true;
        arrived();
        await gate;
        if (
          outcome === "failed" ||
          outcome === "reconnect" ||
          outcome === "conflict-failed"
        )
          await route.fulfill({
            status: 503,
            contentType: "application/json",
            body: "{}",
          });
        else await route.continue();
      };
      await page.route(url, holdRead);
      try {
        if (conflicts) {
          // From the known count, with no edit: the server refuses the Target Format change as stale.
          await page.route(`${url}/deck-list/target-format`, (route) =>
            route.request().method() === "PUT"
              ? route.fulfill({
                  status: 409,
                  contentType: "application/json",
                  body: JSON.stringify({ detail: { code: "STALE_DECK_LIST" } }),
                })
              : route.fallback()
          );
          await page
            .getByRole("button", {
              name: "Target Format: Standard",
              exact: true,
            })
            .click();
          await page
            .getByRole("menuitemradio", { name: "Expanded", exact: true })
            .click();
          await requested;
        } else {
          await page.getByRole("button", { name: /^Remove one / }).click();
          await requested;
          await expect(summary).toContainText("Not owned59");
        }
        if (outcome === "target") {
          await page
            .getByRole("button", {
              name: "Target Format: Standard",
              exact: true,
            })
            .click();
          await page
            .getByRole("menuitemradio", { name: "Expanded", exact: true })
            .click();
          await expect(
            page.getByRole("button", {
              name: "Target Format: Expanded",
              exact: true,
            })
          ).toBeVisible();
          // The command's answer, not its optimistic label, must have landed before releasing the stale GET.
          await expect(
            page.getByRole("group", { name: "Target Format and result" })
          ).not.toHaveAttribute("aria-busy", "true");
        } else {
          // If buying is offered, it must never advertise the previous count as current.
          if (!conflicts && (await buy.isEnabled())) {
            await buy.click();
            await expect
              .soft(dialog)
              .not.toContainText("Cards you don't own (60)");
            await dialog.getByRole("button", { name: "Close export" }).click();
          }
          await expect(buy).toBeDisabled();
          await expect(buy).toHaveAccessibleDescription(
            "Wait for this Deck's missing count."
          );
          const reason = page.getByText("Wait for this Deck's missing count.", {
            exact: true,
          });
          await expect(reason).toBeVisible();
          await expect(reason).not.toHaveClass(/\bsr-only\b/);
          // The re-read hasn't loaded the Deck, so nothing says it is up to date.
          if (conflicts)
            await expect(page.getByText(/up to date/)).toHaveCount(0);
          // Export remains usable, but cannot offer a stale not-owned count or prepare that export.
          await page
            .getByRole("button", { name: "Export", exact: true })
            .click();
          await dialog
            .getByRole("radio", { name: "TCGplayer Mass Entry", exact: true })
            .click();
          await expect(
            dialog.getByRole("radio", {
              name: "Cards you don't own",
              exact: true,
            })
          ).toBeDisabled();
          await expect(dialog).not.toContainText("Cards you don't own (60)");
        }
      } finally {
        release();
      }
      if (outcome === "target") {
        await expect(buy).toBeEnabled();
        await expect(
          page.getByText("Wait for this Deck's missing count.", { exact: true })
        ).toBeHidden();
        await expect(page.getByText(/ to complete/)).toContainText(
          "59/59 priced"
        );
        await buy.click();
        await expect(
          dialog.getByRole("radio", {
            name: "Cards you don't own (59)",
            exact: true,
          })
        ).toBeChecked();
        expect(deckReads).toBeLessThanOrEqual(2);
      } else if (outcome === "conflict") {
        await dialog.getByRole("button", { name: "Close export" }).click();
        await expect(
          page.getByText(
            "This Deck changed somewhere else, so its Target Format wasn't changed. It's up to date now: try again.",
            { exact: true }
          )
        ).toBeVisible();
        await expect(
          page.getByRole("button", {
            name: "Target Format: Standard",
            exact: true,
          })
        ).toBeVisible();
        await expect(buy).toBeEnabled();
        await expect(
          page.getByText("Wait for this Deck's missing count.", { exact: true })
        ).toBeHidden();
        await buy.click();
        await expect(
          dialog.getByRole("radio", {
            name: "Cards you don't own (60)",
            exact: true,
          })
        ).toBeChecked();
        expect(idleReads).toBeLessThanOrEqual(2);
      } else if (outcome !== "delayed") {
        await expect(
          page
            .getByRole("status")
            .filter({ hasText: "This Deck couldn't be loaded" })
        ).toBeVisible();
        if (outcome === "conflict-failed") {
          await expect(page.getByText(/up to date/)).toHaveCount(0);
          await expect(
            page.getByText(
              "This Deck changed somewhere else, so its Target Format wasn't changed.",
              { exact: true }
            )
          ).toBeVisible();
        }
        await expect(buy).toBeDisabled();
        await expect(dialog).not.toContainText("Cards you don't own (60)");
        await dialog.getByRole("button", { name: "Close export" }).click();
        await page.unroute(url, holdRead);
        if (outcome === "failed" || outcome === "conflict-failed")
          await page
            .getByRole("button", { name: "Retry", exact: true })
            .click();
        else
          await page.evaluate(() => window.dispatchEvent(new Event("online")));
        await expect(buy).toBeEnabled();
        await expect(
          page.getByText("Wait for this Deck's missing count.", { exact: true })
        ).toBeHidden();
        await expect(buy).not.toHaveAttribute("aria-describedby");
        await buy.click();
        await expect(
          dialog.getByRole("radio", {
            name: conflicts
              ? "Cards you don't own (60)"
              : "Cards you don't own (59)",
            exact: true,
          })
        ).toBeChecked();
        if (conflicts) expect(idleReads).toBeLessThanOrEqual(3);
      } else {
        await expect(
          dialog.getByRole("radio", {
            name: "Cards you don't own (59)",
            exact: true,
          })
        ).toBeChecked();
        await dialog.getByRole("button", { name: "Close export" }).click();
        await expect(buy).toBeEnabled();
        await expect(
          page.getByText("Wait for this Deck's missing count.", { exact: true })
        ).toBeHidden();
        await expect(buy).not.toHaveAttribute("aria-describedby");
        await expect(page.getByText(/ to complete/)).toContainText(
          "59/59 priced"
        );
        await buy.click();
        await expect(
          dialog.getByRole("radio", {
            name: "Cards you don't own (59)",
            exact: true,
          })
        ).toBeChecked();
      }
    });
  }
}
