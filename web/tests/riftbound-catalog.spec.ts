import { expect, type Page, type TestInfo } from "@playwright/test";
import { test, artUpstream } from "./support/art-upstream";
const origin = process.env.TEST_ORIGIN || "http://127.0.0.1:5173";
const entry = `${origin}/src/games/riftbound/local/index.html`;
for (const width of [1280, 390]) {
  test(`Riftbound catalog search, paging, history, keyboard and layout at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    const calls: string[] = [];
    page.on("request", (request) => {
      if (/\/(api|auth)\//.test(new URL(request.url()).pathname))
        calls.push(request.url());
    });
    await page.addInitScript(() =>
      localStorage.setItem(
        "prizecheck:workspace:preferences:v1:1",
        '{"filters":{"category":"pokemon"},"sentinel":"unchanged"}'
      )
    );
    await page.goto(entry);
    await expect(
      page.getByRole("heading", { name: "Catalog", exact: true })
    ).toBeVisible();
    const results = page.getByRole("region", { name: "Catalog results" });
    await expect(results.getByRole("listitem")).toHaveCount(8);
    await page.getByRole("button", { name: "Next page", exact: true }).click();
    await expect(results.getByRole("listitem")).toHaveCount(6);
    await page.goBack();
    await expect(results.getByRole("listitem")).toHaveCount(8);
    const search = page.getByRole("searchbox", { name: "Search cards" });
    await search.fill("001");
    await expect(results.getByRole("listitem")).toHaveCount(2);
    const populatedHash = new URL(page.url()).hash;
    await page.getByRole("link", { name: "Skip to content" }).focus();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("heading", { name: "Catalog", exact: true })
    ).toBeFocused();
    await expect(page).toHaveURL((url) => url.hash === populatedHash);
    const foil = page.getByRole("button", {
      name: "Ember Scout, FL 001, Foil",
      exact: true,
    });
    await foil.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Foil", { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await expect(foil).toBeFocused();
    await foil.click();
    await expect(dialog.getByText("Foil", { exact: true })).toBeVisible();
    await page.goBack();
    await expect(dialog).not.toBeVisible();
    await expect(search).toHaveValue("001");
    await expect(foil).toBeFocused();
    await page.goForward();
    await expect(dialog.getByText("Foil", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Close card details" }).click();
    await page.getByRole("button", { name: "PrizeCheck", exact: true }).click();
    await page.getByRole("link", { name: "Skip to content" }).focus();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("heading", { name: "Riftbound", exact: true })
    ).toBeFocused();
    await page.getByRole("button", { name: "Browse Catalog" }).click();
    await expect(search).toHaveValue("001");
    await expect(results.getByRole("listitem")).toHaveCount(2);
    await search.fill("");
    await page
      .getByRole("button", { name: "Battlefield", exact: true })
      .click();
    await expect(results.getByRole("listitem")).toHaveCount(1);
    await page
      .getByRole("button", { name: "Moonlit Crossing, FL 003, Standard" })
      .click();
    await expect(dialog.getByRole("img")).toBeVisible();
    const art = dialog.getByRole("img");
    await expect(art).toHaveCSS("object-fit", "contain");
    const box = await art.boundingBox();
    expect(box!.width).toBeGreaterThan(box!.height);
    await page.keyboard.press("Escape");
    await page
      .getByRole("button", { name: "Battlefield", exact: true })
      .click();
    await page.getByRole("button", { name: "Any set", exact: true }).click();
    await page
      .getByRole("button", { name: "Distant Shores", exact: true })
      .click();
    await expect(results.getByRole("listitem")).toHaveCount(8);
    await expect(page.locator("body")).toHaveJSProperty("scrollWidth", width);
    await expect
      .poll(() =>
        page.evaluate(() =>
          localStorage.getItem("prizecheck:workspace:preferences:v1:1")
        )
      )
      .toBe('{"filters":{"category":"pokemon"},"sentinel":"unchanged"}');
    expect(calls).toEqual([]);
  });
}
test("distinct loading, empty, no match and recoverable list/detail failures", async ({
  page,
}) => {
  await page.goto(entry + "?scenario=slow");
  await expect(page.getByRole("status")).toHaveText("Loading cards…");
  await page.getByRole("searchbox").fill("Ember");
  await page.getByRole("searchbox").fill("Quiet");
  await expect(
    page.getByRole("region", { name: "Catalog results" }).getByRole("listitem")
  ).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: "Quiet Resolve, FL 002, Standard" })
  ).toBeVisible();
  await page.getByRole("searchbox").fill("no such card");
  await expect(page.getByRole("status")).toContainText("No cards match");
  await page.goto(entry + "?scenario=empty");
  await expect(page.getByRole("status")).toHaveText(
    "No cards in this catalog yet."
  );
  await page.goto(entry + "?scenario=failure");
  await expect(page.getByRole("alert")).toContainText(
    "Cards couldn't be loaded."
  );
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(
    page.getByRole("region", { name: "Catalog results" }).getByRole("listitem")
  ).toHaveCount(8);
  await page.goto(entry + "?scenario=detail-failure");
  await page
    .getByRole("button", { name: "Ember Scout, FL 001, Standard", exact: true })
    .click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "Card details couldn't be loaded."
  );
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(
    page.getByRole("dialog").getByText("Standard", { exact: true })
  ).toBeVisible();
  await expect(page.getByRole("dialog").getByRole("img")).toHaveAccessibleName(
    "Artwork unavailable for Ember Scout"
  );
});

// Compare the real Pokémon Catalog with the local slice at matching breakpoints; no production code is changed.
for (const width of [1600, 390]) {
  test(`shared Catalog visual baseline at ${width}`, async ({ page }, info) => {
    const { execFileSync } = await import("node:child_process");
    const { Pool } = await import("pg");
    const { startAsNewOwner } = await import("./support/owner");
    const { signInAsOwner } = await import("./support/sign-in");
    (await artUpstream()).reset();
    execFileSync(
      ".venv/bin/python",
      ["-c", "from test_catalog_browse import seed_gallery\nseed_gallery()"],
      { env: { ...process.env, PYTHONPATH: "api:api/tests" } }
    );
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    try {
      await startAsNewOwner(pool);
    } finally {
      await pool.end();
    }
    await page.setViewportSize({ width, height: 844 });
    await signInAsOwner(page, "/catalog");
    const pokemonSearch = page.getByRole("searchbox", {
      name: "Search the catalog",
    });
    await expect(pokemonSearch).toBeVisible();
    const headingSize = await page
      .getByRole("heading", { name: "Catalog", exact: true })
      .evaluate((e) => getComputedStyle(e).fontSize);
    const pokemonControl = await pokemonSearch.evaluate((e) => ({
      height: getComputedStyle(e).height,
      borderRadius: getComputedStyle(e).borderRadius,
      font: getComputedStyle(e).font,
    }));
    await expect(
      page
        .getByRole("region", { name: "Catalog results" })
        .getByRole("listitem")
        .first()
    ).toBeVisible();
    await page.screenshot({ path: info.outputPath(`pokemon-${width}.png`) });
    await pairedInteraction(
      page,
      info,
      "pokemon",
      width,
      "Search the catalog",
      "Bulbasaur"
    );
    await page.goto(entry);
    const riftboundSearch = page.getByRole("searchbox", {
      name: "Search cards",
    });
    await expect(riftboundSearch).toBeVisible();
    await expect
      .poll(() =>
        riftboundSearch.evaluate((e) => ({
          height: getComputedStyle(e).height,
          borderRadius: getComputedStyle(e).borderRadius,
          font: getComputedStyle(e).font,
        }))
      )
      .toEqual(pokemonControl);
    await expect(
      page
        .getByRole("region", { name: "Catalog results" })
        .getByRole("listitem")
        .first()
    ).toBeVisible();
    await page.screenshot({ path: info.outputPath(`riftbound-${width}.png`) });
    await expect(
      page.getByRole("heading", { name: "Catalog", exact: true })
    ).toHaveCSS("font-size", headingSize);
    await pairedInteraction(
      page,
      info,
      "riftbound",
      width,
      "Search cards",
      "Ember"
    );
    await expect(page.getByRole("main")).toHaveCSS("max-width", "1280px");
  });
}

async function pairedInteraction(
  page: Page,
  info: TestInfo,
  game: string,
  width: number,
  label: string,
  query: string
) {
  const search = page.getByRole("searchbox", { name: label });
  await search.fill(query);
  const first = page
    .getByRole("region", { name: "Catalog results" })
    .getByRole("listitem")
    .first()
    .getByRole("button")
    .first();
  await expect(first).toContainText(query);
  await first.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(
    game === "pokemon" ? "Mega Evolution" : "First Light"
  );
  await expect(
    dialog.getByRole("button", { name: "Close card details", exact: true })
  ).toBeVisible();
  await page.screenshot({
    path: info.outputPath(`${game}-detail-${width}.png`),
  });
  await page.keyboard.press("Escape");
  await expect(first).toBeFocused();
  await expect(search).toHaveValue(query);
  await page
    .getByRole("link", {
      name: game === "pokemon" ? "Skip to main content" : "Skip to content",
    })
    .focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { name: "Catalog", exact: true })
  ).toBeFocused();
  await expect(search).toHaveValue(query);
  await search.fill("zzzznomatchingcard");
  await expect(page.getByRole("main")).toContainText(/No cards match/);
  await page.screenshot({
    path: info.outputPath(`${game}-no-matches-${width}.png`),
  });
}
for (const width of [1280, 390]) {
  test(`paired Catalog loading, empty and failure affordances at ${width}`, async ({
    page,
  }, info) => {
    const { Pool } = await import("pg");
    const { startAsNewOwner } = await import("./support/owner");
    const { signInAsOwner } = await import("./support/sign-in");
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    try {
      await startAsNewOwner(pool);
    } finally {
      await pool.end();
    }
    await page.setViewportSize({ width, height: 844 });
    await signInAsOwner(page, "/catalog");
    for (const state of ["loading", "empty", "failure"] as const) {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.route("**/api/catalog/editions**", async (route) => {
        if (state === "loading") {
          await gate;
          await route.continue();
        } else if (state === "failure")
          await route.fulfill({ status: 503, json: {} });
        else
          await route.fulfill({
            json: {
              available: false,
              catalog_revision: 1,
              owner_revision: 1,
              last_success: null,
              search: {
                mode: "all",
                text: "",
                set_id: null,
                set_name: null,
                set_code: null,
                number: null,
              },
              editions: [],
              next_cursor: null,
              printings: 0,
              matches: 0,
            },
          });
      });
      try {
        await page.goto(origin + "/catalog");
        if (state === "loading")
          await expect(page.getByRole("status")).toContainText(
            "Loading the catalog"
          );
        else if (state === "empty")
          await expect(page.getByRole("status")).toContainText(
            "Catalog unavailable"
          );
        else
          await expect(
            page.getByRole("button", { name: "Retry", exact: true })
          ).toBeVisible();
        await page.screenshot({
          path: info.outputPath(`pokemon-${state}-${width}.png`),
        });
      } finally {
        release();
        await page.unrouteAll({ behavior: "wait" });
      }
      await page.goto(
        entry +
          "?scenario=" +
          { loading: "slow", empty: "empty", failure: "failure" }[state]
      );
      if (state === "loading")
        await expect(page.getByRole("status")).toHaveText("Loading cards…");
      else if (state === "empty")
        await expect(page.getByRole("status")).toHaveText(
          "No cards in this catalog yet."
        );
      else
        await expect(
          page.getByRole("button", { name: "Retry", exact: true })
        ).toBeVisible();
      await page.screenshot({
        path: info.outputPath(`riftbound-${state}-${width}.png`),
      });
    }
  });
}
