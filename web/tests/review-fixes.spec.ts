import { test, expect } from "@playwright/test";

const origin =
  process.env.REVIEW_BROWSER_ORIGIN ??
  `${process.env.TEST_ORIGIN || "http://localhost:5173"}`;
async function sessionFixture(
  page: import("@playwright/test").Page,
  signedIn = true
) {
  let current = signedIn;
  await page.route("**/auth/**", async (route) => {
    if (route.request().url().includes("/verify-code")) current = true;
    await route.fulfill({
      json: route.request().url().includes("/session")
        ? { signedIn: current, userId: current ? "owner" : null }
        : route.request().url().includes("/methods")
          ? { providers: [], emailSignIn: true }
          : {},
    });
  });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/catalog/editions") {
      // The deck builder's library (#177) reads the browse route: an empty catalog.
      await route.fulfill({
        json: {
          available: false,
          catalog_revision: 0,
          owner_revision: 1,
          last_success: null,
          search: { mode: "all", text: "", set_id: null, set_name: null },
          editions: [],
          next_cursor: null,
          printings: 0,
          matches: 0,
        },
      });
      return;
    }
    if (path === "/api/social/friends") {
      // The shell reads the Friends badge on every page (social network #247): no Friends.
      await route.fulfill({ json: { received: [], friends: [], sent: [] } });
      return;
    }
    const json =
      path === "/api/catalog/status"
        ? { available: false, revision: 0, last_success: null }
        : path === "/api/decks"
          ? { decks: [], owner_revision: 1, next_cursor: null }
          : path === "/api/catalog/edition-replacements"
            ? []
            : path.startsWith("/api/holdings/")
              ? {
                  holdings: [],
                  owner_revision: 1,
                  catalog_revision: 0,
                  next_cursor: null,
                }
              : path === "/api/collection"
                ? {
                    entries: [],
                    owner_revision: 1,
                    catalog_revision: 0,
                    next_cursor: null,
                  }
                : { locations: [], nodes: [], owner_revision: 1 };
    await route.fulfill({
      status: path.startsWith("/api/admin") ? 403 : 200,
      json,
    });
  });
}

test("protected destination restores the rendered view after sign-in, reload, and history navigation", async ({
  page,
}) => {
  await sessionFixture(page, false);
  await page.goto(`${origin}/locations?next=%2Fdecks`);
  await expect(page).toHaveURL(/\/collection(\?|$)/);
  await page.getByLabel("Email", { exact: true }).fill("owner@example.test");
  await page
    .getByRole("button", { name: "Email me a code", exact: true })
    .click();
  await page.getByLabel("Six-digit code").fill("123456");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(`${origin}/decks`);
  await expect(
    page.getByRole("heading", { name: "Decks", exact: true }).first()
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Decks", exact: true }).first()
  ).toBeVisible();
  await page
    .getByRole("navigation", { name: "Main views" })
    .getByRole("button", { name: "Collection", exact: true })
    .click();
  await expect(page).toHaveURL(`${origin}/collection`);
  await page.goBack();
  await expect(
    page.getByRole("heading", { name: "Decks", exact: true }).first()
  ).toBeVisible();
});

test("Revoke sends revocation after an uncertain republish rather than replaying the pending action", async ({
  page,
}) => {
  await sessionFixture(page);
  const deck = {
    id: "11111111-1111-1111-1111-111111111111",
    name: "Shared Deck",
    kind: "deck",
    parent_id: null,
    version: 1,
    depth: 1,
    deck_list_total: "60",
    in_deck: "0",
    target_format: "standard",
  };
  let token: string | null = "a".repeat(32);
  const commands: string[] = [];
  await page.route("**/api/decks**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (path.endsWith("/publication") && method !== "GET") {
      commands.push(method);
      if (method === "PUT") {
        await route.abort("failed");
        return;
      }
      if (method === "DELETE") token = null;
      await route.fulfill({
        json: { token: "a".repeat(32), version: 2, revoked: token === null },
      });
      return;
    }
    await route.fulfill({
      json:
        path === "/api/decks"
          ? { decks: [deck], owner_revision: 1, next_cursor: null }
          : path.endsWith("/publication")
            ? {
                token,
                version: token ? 1 : null,
                title: token ? "Shared title" : null,
                visibility: token ? "unlisted" : null,
                projection_pending: false,
              }
            : {
                deck,
                owner_revision: 1,
                catalog_revision: 1,
                checks: {
                  total: "0",
                  shortage: "60",
                  excess: "0",
                  size_status: "shortage",
                  identities: [],
                  disclaimer: "",
                },
                deck_list_checks: {
                  total: "0",
                  shortage: "60",
                  excess: "0",
                  size_status: "shortage",
                  identities: [],
                  disclaimer: "",
                },
                deck_list: { revision: 1, lines: [] },
                ownership: [],
                surplus: [],
                competition: [],
                // The Deck's need under the Want List counting setting (#208).
                to_get: "0",
                want_list_counting: "all_at_once",
                settings_revision: 1,
                target_format: "standard",
                format_checks: {
                  deck_id: deck.id,
                  deck_list_revision: 1,
                  attribute_revision: 1,
                  catalog_revision: 1,
                  results: [
                    {
                      format: "standard",
                      // Republish needs a legal result (#181); this test is about the retry key, not the gate.
                      status: "legal",
                      issues: [],
                      rules_version: "1 (2026-10-11)",
                      evaluated_on: "2026-10-11",
                      notes: [],
                      computed_at: "2026-10-11T00:00:00Z",
                    },
                  ],
                  disclaimer: "Advisory format checks.",
                },
              },
    });
  });
  await page.goto(`${origin}/decks`);
  await page
    .getByRole("navigation", { name: "Deck index" })
    .getByRole("link", { name: "Shared Deck" })
    .click();
  await page.getByRole("button", { name: "Published · v1" }).click();
  const panel = page.getByRole("dialog", { name: "Published Deck" });
  await panel
    .getByRole("button", { name: "Republish snapshot", exact: true })
    .click();
  await expect(panel).toContainText("The publication hasn't been confirmed");
  await panel.getByRole("button", { name: "Revoke: Shared title" }).click();
  await panel
    .getByRole("button", { name: "Revoke for good", exact: true })
    .click();
  const revoked = page.getByRole("dialog", { name: "Publish" });
  await expect(revoked).toContainText("Public link revoked permanently.");
  expect(commands).toEqual(["PUT", "DELETE"]);
  await expect(
    revoked.getByRole("link", { name: "View public snapshot" })
  ).toHaveCount(0);
});

test("direct Collection deep link is preserved when signing in without an explicit next parameter", async ({
  page,
}) => {
  await sessionFixture(page, false);
  await page.goto(`${origin}/collection`);
  await page.getByLabel("Email", { exact: true }).fill("owner@example.test");
  await page
    .getByRole("button", { name: "Email me a code", exact: true })
    .click();
  await page.getByLabel("Six-digit code").fill("123456");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(`${origin}/collection`);
  await expect(
    page
      .getByRole("navigation", { name: "Main views" })
      .getByRole("button", { name: "Collection", exact: true })
  ).toHaveAttribute("aria-current", "page");
  await page.reload();
  await expect(
    page
      .getByRole("navigation", { name: "Main views" })
      .getByRole("button", { name: "Collection", exact: true })
  ).toHaveAttribute("aria-current", "page");
});
