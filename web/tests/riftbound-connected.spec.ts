// The real Riftbound Catalog page against a disposable migrated Riftbound database (#661): page -> generated client ->
// /api/riftbound -> the real gateway -> the Riftbound backend -> database. The file starts its own Riftbound backend, a
// TEST-ONLY signing relay, a gateway and vite (web/tests/support/riftbound-stack.ts), so it is not tagged @slow.
//
// What this proves: Catalog reads for ONE synthetic principal that the relay signs, and every page state. What it does
// NOT prove: identity propagation from the gateway to the backend, or per-user authorization (#531). Today the gateway
// forwards no identity, so a signed-in collector is denied; the "without forwarded identity" test pins that. The seed
// writes the accepted generation directly: it proves reading an accepted snapshot, not the ingestion acceptance workflow.
import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { fakeSignIn } from "./support/sign-in";
import {
  startRiftboundStack,
  type RiftboundStack,
} from "./support/riftbound-stack";

test.describe.configure({ mode: "serial", timeout: 90_000 });
// A trace, screenshot or video would keep cookie headers and the OAuth callback URL (code and state) of the sign-in walk.
test.use({ trace: "off", screenshot: "off", video: "off" });
let stack: RiftboundStack;
let noSnapshot: string | undefined;
test.beforeAll(async () => {
  test.setTimeout(180_000);
  // Playwright's automatic page snapshot (error-context.md) is taken whatever the trace and screenshot settings say, and
  // the fake consent page's Continue link holds the callback URL, code and state. Off for this file's tests.
  noSnapshot = process.env.PLAYWRIGHT_NO_COPY_PROMPT;
  process.env.PLAYWRIGHT_NO_COPY_PROMPT = "1";
  stack = await startRiftboundStack();
});
test.afterAll(async () => {
  if (noSnapshot === undefined) delete process.env.PLAYWRIGHT_NO_COPY_PROMPT;
  else process.env.PLAYWRIGHT_NO_COPY_PROMPT = noSnapshot;
  await stack?.stop();
});
test.beforeEach(() => {
  stack.relay.mode = "sign";
});
// No afterEach navigation: the snapshot suppression above stays on through cleanup (afterEach runs before the context
// closes and before the recorder's final snapshot), and an about:blank goto could race the OAuth redirect.
type Seen = { path: string; status: number };
/** Responses by path and status; `requests` holds the paths asked for, answered or not. */
type Observed = Seen[] & { requests: string[] };
const API = "/api/riftbound/catalog/";

/** Signs in through the stack's own gateway, then leaves the page on a blank document with Pokémon sentinels stored. */
async function signIn(page: Page) {
  await fakeSignIn(page, {
    origin: stack.origin,
    sanitized: true,
    databaseUrl: stack.authDatabaseUrl,
  });
  await page.goto(`${stack.origin}/auth/session`);
  await page.evaluate(() => {
    localStorage.setItem(
      "prizecheck:workspace:preferences:v1:1",
      '{"sentinel":"local"}'
    );
    sessionStorage.setItem("prizecheck:session:sentinel", "session");
  });
  return storage(page);
}
const storage = (page: Page) =>
  page.evaluate(() => ({
    local: Object.fromEntries(Object.entries(localStorage)),
    session: Object.fromEntries(Object.entries(sessionStorage)),
  }));
/** Records /api/ requests and responses from now on. */
function observe(page: Page): Observed {
  const seen = Object.assign([] as Seen[], { requests: [] as string[] });
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/")) seen.requests.push(url.pathname);
  });
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.pathname.startsWith("/api/"))
      seen.push({ path: url.pathname, status: response.status() });
  });
  return seen;
}
const open = async (page: Page, hash = "") => {
  await page.goto("about:blank");
  await page.goto(stack.entry + hash);
};
const results = (page: Page) =>
  page.getByRole("region", { name: "Catalog results" });
const items = (page: Page) => results(page).getByRole("listitem");
const editionRequests = (seen: Seen[]) =>
  seen.filter((s) => s.path === API + "editions");
const asked = (seen: Observed) => seen.requests.includes(API + "editions");

for (const width of [1280, 390]) {
  test.describe(`at ${width}`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
    });

    test(`populated Catalog for one signed synthetic principal: browse, paging, search, set and detail at ${width}`, async ({
      page,
    }) => {
      const made = stack.seed("populated");
      const before = await signIn(page);
      const seen = observe(page);
      await open(page);
      await expect(page.getByText("29 Editions · Page 1 of 2")).toBeVisible();
      await expect(items(page)).toHaveCount(24);
      await expect(page.getByText("Any domain")).toHaveCount(0);
      await expect(page.getByText("Unit", { exact: true })).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "Any set", exact: true })
      ).toBeVisible();
      const foil = page.getByRole("button", {
        name: "Synthetic Dragon, 001/100, Foil",
        exact: true,
      });
      await expect(foil).toBeVisible();
      await expect(
        page.getByRole("button", {
          name: "Synthetic Knight, 002/100, Unspecified Variant",
          exact: true,
        })
      ).toBeVisible();
      await expect(
        page.getByRole("button", {
          name: "Alpha Sprite, OGN P-7, Normal",
          exact: true,
        })
      ).toBeVisible();
      // Tile art sits in an aria-hidden span, so look it up by its attributes.
      await expect(
        page.locator('[role="img"][aria-label^="Artwork unavailable"]').first()
      ).toBeVisible();

      await page
        .getByRole("button", { name: "Next page", exact: true })
        .click();
      // In-app navigation: the entry this click pushed is already game-scoped, read before anything else settles.
      expect(await page.evaluate(() => history.state?.game)).toBe("riftbound");
      await expect(items(page)).toHaveCount(5);
      await expect(page.getByText("Page 2 of 2")).toBeVisible();
      await page.goBack();
      await expect(items(page)).toHaveCount(24);

      const search = page.getByRole("searchbox", { name: "Search cards" });
      await search.fill("knight");
      await expect(items(page)).toHaveCount(1);
      await search.fill("");
      await expect(items(page)).toHaveCount(24);
      await page.getByRole("button", { name: "Any set", exact: true }).click();
      const dialog = page.getByRole("dialog");
      await dialog
        .getByRole("button", { name: "Origins Synthetic", exact: true })
        .click();
      await expect(items(page)).toHaveCount(1);
      await page
        .getByRole("button", { name: "Origins Synthetic", exact: true })
        .click();
      await dialog
        .getByRole("button", { name: "Any set", exact: true })
        .click();
      await expect(items(page)).toHaveCount(24);

      await foil.click();
      await expect(
        dialog.getByText("Synthetic Set 900 · 001/100")
      ).toBeVisible();
      await expect(dialog.getByText("Foil", { exact: true })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(dialog).not.toBeVisible();
      await expect(foil).toBeFocused();
      const foilId = made["Synthetic Dragon|001/100"][1];
      expect(seen.map((s) => s.path)).toContain(API + "editions/" + foilId);

      await open(page, "#riftbound:page=9&view=catalog");
      await expect(page.getByText("Page 2 of 2")).toBeVisible();
      await expect(items(page)).toHaveCount(5);
      await open(page, "#riftbound:domain=Fury&type=Unit&view=catalog");
      await expect(page.getByText("29 Editions")).toBeVisible();
      await expect(items(page)).toHaveCount(24);
      await open(page, `#riftbound:edition=${randomUUID()}&view=catalog`);
      await expect(
        dialog.getByText("This Edition isn't available.")
      ).toBeVisible();

      // Game-scoped state.
      expect(seen.length).toBeGreaterThan(0);
      for (const s of seen) expect(s.path.startsWith(API), s.path).toBe(true);
      expect(seen.requests.length).toBeGreaterThan(0);
      for (const path of seen.requests)
        expect(path.startsWith(API), path).toBe(true);
      const paths = seen.map((s) => s.path);
      expect(paths).toContain(API + "sets");
      expect(paths).toContain(API + "editions");
      expect(page.url().includes("#riftbound:")).toBe(true);
      expect(stack.relay.identityHeadersSeen).toBe(0);
      await page.goto(`${stack.origin}/auth/session`);
      expect(await storage(page)).toEqual(before);
    });

    test(`empty and unaccepted Catalog show the empty state, not an error, at ${width}`, async ({
      page,
    }) => {
      stack.seed("empty");
      await signIn(page);
      await open(page);
      const status = page
        .getByRole("status")
        .filter({ hasText: "No cards in this catalog yet." });
      await expect(status).toBeVisible();
      await expect(page.getByRole("alert")).toHaveCount(0);
      stack.seed("unaccepted");
      await page.reload();
      await expect(status).toBeVisible();
      await expect(page.getByRole("alert")).toHaveCount(0);
      await page.getByRole("button", { name: "Any set", exact: true }).click();
      const dialog = page.getByRole("dialog");
      await expect(
        dialog.getByRole("button", { name: "Any set", exact: true })
      ).toBeVisible();
      await expect(
        dialog.getByRole("button", { name: /Synthetic|Origins/ })
      ).toHaveCount(0);
    });

    test(`a search with no match is not the empty-catalog state at ${width}`, async ({
      page,
    }) => {
      stack.seed("populated");
      await signIn(page);
      await open(page);
      await expect(items(page)).toHaveCount(24);
      await page
        .getByRole("searchbox", { name: "Search cards" })
        .fill("zzzz absent");
      await expect(page.getByText("No cards match your search.")).toBeVisible();
      await expect(page.getByText("No cards in this catalog yet.")).toHaveCount(
        0
      );
    });

    test(`an over-long search is invalid and Clear search recovers at ${width}`, async ({
      page,
    }) => {
      stack.seed("populated");
      await signIn(page);
      await open(page, `#riftbound:search=${"x".repeat(130)}&view=catalog`);
      await expect(
        page
          .getByRole("alert")
          .getByText("That search is too long. Try a shorter one.")
      ).toBeVisible();
      await page
        .getByRole("button", { name: "Clear search", exact: true })
        .click();
      await expect(items(page)).toHaveCount(24);
    });

    test(`signed out is denied by the gateway before the backend at ${width}`, async ({
      page,
    }) => {
      stack.seed("populated");
      const calls = stack.relay.calls;
      const seen = observe(page);
      await page.goto(stack.entry);
      await expect(
        page.getByRole("alert").getByText("Sign in to see the Catalog.")
      ).toBeVisible();
      await expect(page.getByText("No cards in this catalog yet.")).toHaveCount(
        0
      );
      await expect(page.getByText("Cards couldn't be loaded.")).toHaveCount(0);
      expect(asked(seen)).toBe(true);
      expect(editionRequests(seen).map((s) => s.status)).toContain(401);
      expect(stack.relay.calls).toBe(calls);
    });

    test(`signed in without forwarded identity is denied by the backend at ${width}`, async ({
      page,
    }) => {
      stack.seed("populated");
      stack.relay.mode = "unsigned";
      await signIn(page);
      const calls = stack.relay.calls;
      const logged = stack.relay.upstream.length; // only entries after this belong to the Catalog opened below
      const seen = observe(page);
      await open(page);
      await expect(
        page.getByRole("alert").getByText("Sign in to see the Catalog.")
      ).toBeVisible();
      expect(asked(seen)).toBe(true);
      expect(editionRequests(seen).map((s) => s.status)).toContain(401);
      expect(stack.relay.calls).toBeGreaterThan(calls);
      expect(stack.relay.upstream.slice(logged)).toContainEqual({
        method: "GET",
        path: "/api/catalog/editions",
        status: 401,
      });
    });

    test(`a real backend 500 shows the failure and Retry recovers at ${width}`, async ({
      page,
    }) => {
      stack.seed("populated");
      await signIn(page);
      const seen = observe(page);
      await open(page);
      await expect(items(page)).toHaveCount(24);
      let renamed = false;
      try {
        await stack.sql(
          "ALTER TABLE catalog_state RENAME TO catalog_state_unavailable"
        );
        renamed = true;
        await page.reload();
        await expect(
          page.getByRole("alert").getByText("Cards couldn't be loaded.")
        ).toBeVisible();
        expect(editionRequests(seen).map((s) => s.status)).toContain(500);
        await stack.sql(
          "ALTER TABLE catalog_state_unavailable RENAME TO catalog_state"
        );
        renamed = false;
        await page.getByRole("button", { name: "Retry", exact: true }).click();
        await expect(items(page)).toHaveCount(24);
      } finally {
        if (renamed)
          await stack.sql(
            "ALTER TABLE catalog_state_unavailable RENAME TO catalog_state"
          );
      }
    });

    test(`a network failure shows the failure and Retry recovers at ${width}`, async ({
      page,
    }) => {
      stack.seed("populated");
      await signIn(page);
      const seen = observe(page);
      await open(page);
      await expect(items(page)).toHaveCount(24);
      seen.length = 0; // from here only the reload under the abort counts
      seen.requests.length = 0;
      const pattern = "**/api/riftbound/catalog/editions**";
      await page.route(pattern, (route) => route.abort("failed"));
      await page.reload();
      await expect(
        page.getByRole("alert").getByText("Cards couldn't be loaded.")
      ).toBeVisible();
      expect(asked(seen)).toBe(true); // the page asked, and the abort stopped any answer
      expect(editionRequests(seen)).toEqual([]);
      await page.unroute(pattern);
      await page.getByRole("button", { name: "Retry", exact: true }).click();
      await expect(items(page)).toHaveCount(24);
    });
  });
}
