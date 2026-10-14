// Ticket #163: the signed-out screens on the kit (spec "Sign-in, Sign-ins, loading and first paint" and "The
// shell", signed-out pages). The sign-in card with its provider buttons (OAuth sign-in), the loading screen, the
// unavailable and not-found cards, the slim public header, and Discover and Published Deck inside the shell once
// signed in. Each state runs the shared page check at 1280×800 and 375×812.
import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { expectPageChecks } from "./support/page-check";
import { signInAsOwner, signInWithButton } from "./support/sign-in";

const ORIGIN = process.env.TEST_ORIGIN || "http://localhost:5173";
/** --color-bg in tokens.css (#121110). */
const DARK = "rgb(18, 17, 16)";
const TAGLINE = "Know every card you own, and where it is.";
const CONTINUING = "Sign in to continue where you left off.";

// A 1×1 PNG stands in for card artwork, so no test reaches the network.
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64"
);

/** Replaces the catalog with one Printing per name, each with artwork. This also clears every Holding. */
function promoteCatalog(names: Record<string, string>) {
  execFileSync(
    ".venv/bin/python",
    [
      "-c",
      `import json, sys
import test_catalog_search as search
class Imaged(search.SearchSource):
    def fetch(self, source_id):
        record = super().fetch(source_id)
        record["image"] = "https://assets.tcgdex.net/en/fixture/" + source_id
        return record
search.SearchSource = Imaged
search.promote(json.loads(sys.argv[1]))`,
      JSON.stringify(names),
    ],
    { env: { ...process.env, PYTHONPATH: "api:api/tests" } }
  );
}

/** Creates a top-level Location through the API and returns its id. */
async function createLocation(page: Page, name: string): Promise<string> {
  const response = await page.request.post(
    new URL("/api/location-tree", page.url()).href,
    {
      headers: { origin: new URL(page.url()).origin },
      data: {
        name,
        parent_id: null,
        parent_version: null,
        idempotency_key: randomUUID(),
      },
    }
  );
  expect(response.status()).toBe(201);
  return ((await response.json()) as { location: { id: string } }).location.id;
}

/** Adds copies of an Edition to a Storage Leaf through the API. */
async function addCopies(
  page: Page,
  locationId: string,
  editionId: string,
  quantity: number
) {
  const response = await page.request.post(
    new URL("/api/holdings", page.url()).href,
    {
      headers: { origin: new URL(page.url()).origin },
      data: {
        location_id: locationId,
        edition_id: editionId,
        quantity: String(quantity),
        idempotency_key: randomUUID(),
      },
    }
  );
  expect(response.status(), await response.text()).toBe(200);
}

/** The normal-finish Edition of a fixture Printing. */
async function editionOf(sourceId: string): Promise<string> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const { rows } = await pool.query(
      `SELECT e.id FROM catalog_edition e JOIN catalog_printing p ON p.id=e.printing_id
       WHERE p.source_id=$1 AND e.descriptor->>'finish'='normal'`,
      [sourceId]
    );
    return rows[0].id;
  } finally {
    await pool.end();
  }
}

/** Signs in as the owner through the OAuth test fake and lands on Collection. */
async function signIn(page: Page) {
  await signInAsOwner(page, "/collection");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("All owned");
}

const heading = (page: Page) => page.getByRole("heading", { level: 1 });
const card = (page: Page) =>
  page.getByRole("region", { name: "Sign in to PrizeCheck" });
const mainViews = (page: Page) =>
  page.getByRole("navigation", { name: "Main views" });
const htmlBackground = (page: Page) =>
  page.evaluate(
    () => getComputedStyle(document.documentElement).backgroundColor
  );

/** Opens `path` while /auth/session is held back, on a paused clock, and checks the loading screen: the dark
 * page and the muted wordmark at once, "Loading…" only once 600 ms have passed, and no placeholder or shell.
 * Then lets the session through. */
async function checkLoading(page: Page, state: string) {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/auth/session", async (route) => {
    await held;
    await route.continue();
  });
  const start = new Date("2026-10-13T12:00:00Z");
  await page.clock.install({ time: start });
  await page.clock.pauseAt(new Date(start.getTime() + 1000));
  await page.goto(`${ORIGIN}/collection`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("main")).toHaveText(/✦\s*PrizeCheck/);
  await expect(page.getByRole("status")).toHaveText("");
  await expect.poll(() => htmlBackground(page)).toBe(DARK);
  await page.clock.runFor(599);
  await expect(page.getByRole("status")).toHaveText("");
  await page.clock.runFor(1);
  await expect(page.getByRole("status")).toHaveText("Loading…");
  // No skeleton of the shell and no placeholder tiles.
  await expect(page.getByRole("banner")).toHaveCount(0);
  await expect(page.getByRole("navigation")).toHaveCount(0);
  await expect(page.getByLabel("Loading cards")).toHaveCount(0);
  // axe and the target check run their own timers.
  await page.clock.resume();
  await expectPageChecks(page, state);
  // The hold stays routed but is released, so later session reads pass straight through.
  release();
  await expect(heading(page)).toHaveText("Sign in to PrizeCheck");
}

test.describe("desktop", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("sign-in is a centred 400 px card under the public header, and provider sign-in works in it", async ({
    page,
  }) => {
    await page.goto(`${ORIGIN}/sign-in`);
    await expect(heading(page)).toHaveText("Sign in to PrizeCheck");
    // The public header: the wordmark and Discover decks; Sign in is the page itself.
    const banner = page.getByRole("banner");
    await expect(banner).toContainText("PrizeCheck");
    await expect(banner.getByRole("link")).toHaveText(["Discover decks"]);
    await expect(card(page).getByText(TAGLINE, { exact: true })).toBeVisible();
    // The terms and privacy line is plain text: the card's only links are the provider buttons, one per configured
    // provider, and the stacks leave email sign-in off, so there is no email form.
    await expect(
      card(page).getByText(
        "By continuing you agree to PrizeCheck's terms and privacy notice.",
        { exact: true }
      )
    ).toBeVisible();
    await expect(card(page).getByRole("link")).toHaveCount(2);
    await expect(
      card(page).getByRole("link", { name: "Continue with Google" })
    ).toHaveAttribute("href", "/auth/sign-in/google");
    await expect(
      card(page).getByRole("link", { name: "Continue with Discord" })
    ).toHaveAttribute("href", "/auth/sign-in/discord");
    await expect(card(page).getByLabel("Email")).toHaveCount(0);
    await expect
      .poll(async () => (await card(page).boundingBox())?.width)
      .toBe(400);
    const box = (await card(page).boundingBox())!;
    expect(Math.abs(box.x + box.width / 2 - 640)).toBeLessThanOrEqual(1);
    await expect.poll(() => htmlBackground(page)).toBe(DARK);
    await expectPageChecks(page, "the sign-in card");

    await signInWithButton(page);
    await expect(page).toHaveURL(/\/collection$/);
    await expect(heading(page)).toHaveText("All owned");
    await expect(mainViews(page)).toBeVisible();
  });

  test("the subtitle says when signing in returns to the page asked for", async ({
    page,
  }) => {
    for (const [path, subtitle] of [
      ["/collection", TAGLINE],
      ["/", TAGLINE],
      ["/sign-in", TAGLINE],
      ["/sign-in?next=https%3A%2F%2Fexample.com%2Fsteal", TAGLINE],
      ["/decks", CONTINUING],
      ["/collection?next=%2Fdecks", CONTINUING],
      ["/sign-in?next=%2Fdecks", CONTINUING],
    ] as const) {
      await page.goto(`${ORIGIN}${path}`);
      await expect(heading(page)).toHaveText("Sign in to PrizeCheck");
      await expect(
        card(page).getByText(subtitle, { exact: true }),
        path
      ).toBeVisible();
    }
    // From /sign-in, a safe next is where signing in lands.
    await signInWithButton(page);
    await expect(page).toHaveURL(`${ORIGIN}/decks`);
    await expect(heading(page)).toHaveText("Decks");
  });

  test("a failure message sits above the provider buttons, and both message styles pass the page check", async ({
    page,
  }) => {
    await page.goto(`${ORIGIN}/sign-in?provider=google&error=access_denied`);
    const alert = card(page).getByRole("alert");
    await expect(alert).toContainText("Sign-in was cancelled.");
    await expect(alert).toContainText(
      "Nothing was changed. Choose a way to sign in below."
    );
    await expect(alert).toBeFocused();
    await expect(page).toHaveURL(`${ORIGIN}/sign-in`);
    await expectPageChecks(page, "the sign-in card with a failure message");
    // Not open yet is calm news with its own next step.
    await page.goto(`${ORIGIN}/sign-in?error=signup_disabled`);
    await expect(card(page).getByRole("alert")).toContainText(
      "PrizeCheck isn't open to new collectors yet."
    );
    await expect(
      card(page).getByRole("alert").getByRole("link", {
        name: "Browse public decks",
      })
    ).toBeVisible();
    await expectPageChecks(page, "the sign-in card with the not-open message");
  });

  test("loading shows the dark page with a muted wordmark, and Loading… only after 600 ms", async ({
    page,
  }) => {
    await checkLoading(page, "loading");
  });

  test("an unknown address shows Page not found, with Discover decks and Sign in", async ({
    page,
  }) => {
    await page.goto(`${ORIGIN}/nowhere`);
    await expect(heading(page)).toHaveText("Page not found");
    await expect(
      page.getByText("The link may be mistyped, or the page has moved.", {
        exact: true,
      })
    ).toBeVisible();
    await expect(page.getByRole("main").getByRole("link")).toHaveText([
      "Discover decks",
      "Sign in",
    ]);
    await expect(page.getByRole("banner").getByRole("link")).toHaveText([
      "Discover decks",
      "Sign in",
    ]);
    await expect.poll(() => htmlBackground(page)).toBe(DARK);
    await expectPageChecks(page, "not found");

    await page.getByRole("main").getByRole("link", { name: "Sign in" }).click();
    await expect(page).toHaveURL(`${ORIGIN}/sign-in`);
    await expect(heading(page)).toHaveText("Sign in to PrizeCheck");
    await page.goBack();
    await expect(heading(page)).toHaveText("Page not found");
    await page
      .getByRole("main")
      .getByRole("link", { name: "Discover decks" })
      .click();
    await expect(page).toHaveURL(`${ORIGIN}/discover`);
    await expect(heading(page)).toHaveText("Discover Listed Decks");
    // Discover under the same public header, its link marked as the current page.
    await expect(
      page.getByRole("banner").getByRole("link", { name: "Discover decks" })
    ).toHaveAttribute("aria-current", "page");
    await page
      .getByRole("banner")
      .getByRole("link", { name: "Sign in" })
      .click();
    await expect(page).toHaveURL(`${ORIGIN}/sign-in`);
    await expect(card(page).getByText(TAGLINE, { exact: true })).toBeVisible();
  });

  test("an unknown Published Deck token shows This deck isn't published anymore", async ({
    page,
  }) => {
    await page.goto(`${ORIGIN}/published/${randomUUID()}`);
    await expect(heading(page)).toHaveText("This deck isn't published anymore");
    await expect(
      page.getByText(
        "Its owner stopped sharing it, or the link changed. Published decks are snapshots, so an old link can stop working.",
        { exact: true }
      )
    ).toBeVisible();
    await expect(page.getByRole("main").getByRole("link")).toHaveText([
      "Discover decks",
      "Sign in",
    ]);
    await expect(page.getByRole("banner").getByRole("link")).toHaveText([
      "Discover decks",
      "Sign in",
    ]);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
      "content",
      "noindex, nofollow"
    );
    await expectPageChecks(page, "unavailable");
  });

  test("Back onto a public page closes a Collection dialog left open, and the page stays usable", async ({
    page,
  }) => {
    promoteCatalog({ "card-1": "Back Abra" });
    await page.route(/^https:\/\/assets\.tcgdex\.net\//, (route) =>
      route.fulfill({ status: 200, contentType: "image/png", body: PIXEL })
    );
    await signIn(page);
    const leaf = await createLocation(page, `Back ${randomUUID().slice(0, 8)}`);
    await addCopies(page, leaf, await editionOf("card-1"), 2);
    await page.goto(`${ORIGIN}/published/${randomUUID()}`);
    await expect(heading(page)).toHaveText("This deck isn't published anymore");
    await mainViews(page).getByRole("button", { name: "Collection" }).click();
    await expect(heading(page)).toHaveText("All owned");
    await page
      .getByRole("region", { name: "Cards" })
      .getByRole("button")
      .first()
      .click();
    const strip = page.getByRole("region", { name: "Selection" });
    await strip.getByRole("button", { name: "Actions" }).click();
    await strip.getByRole("button", { name: "Inventory Removal…" }).click();
    await expect(page.locator("dialog:modal")).toHaveCount(1);

    await page.goBack();
    await expect(heading(page)).toHaveText("This deck isn't published anymore");
    await expect(page.locator("dialog:modal")).toHaveCount(0);
    await page
      .getByRole("main")
      .getByRole("link", { name: "Discover decks" })
      .click();
    await expect(page).toHaveURL(`${ORIGIN}/discover`);
  });

  test("signed in, Discover and a Published Deck open inside the shell", async ({
    page,
  }) => {
    await signIn(page);
    await page.goto(`${ORIGIN}/discover`);
    await expect(page).toHaveURL(`${ORIGIN}/discover`);
    await expect(heading(page)).toHaveText("Discover Listed Decks");
    await expect(mainViews(page)).toBeVisible();
    // Discover is not a tab: none is marked.
    await expect(mainViews(page).locator("[aria-current]")).toHaveCount(0);
    await expect(
      page.getByRole("navigation", { name: "Public pages" })
    ).toHaveCount(0);

    await page.goto(`${ORIGIN}/published/${randomUUID()}`);
    await expect(heading(page)).toHaveText("This deck isn't published anymore");
    await expect(mainViews(page)).toBeVisible();
    // Signed in, the card offers no Sign in.
    await expect(page.getByRole("main").getByRole("link")).toHaveText([
      "Discover decks",
    ]);
    await expectPageChecks(page, "unavailable inside the shell");
    await page
      .getByRole("main")
      .getByRole("link", { name: "Discover decks" })
      .click();
    await expect(page).toHaveURL(`${ORIGIN}/discover`);
    await expect(heading(page)).toHaveText("Discover Listed Decks");
    await mainViews(page).getByRole("button", { name: "Collection" }).click();
    await expect(page).toHaveURL(`${ORIGIN}/collection`);
    await expect(heading(page)).toHaveText("All owned");
    // Signed in, the sign-in address opens Collection.
    await page.goto(`${ORIGIN}/sign-in`);
    await expect(page).toHaveURL(`${ORIGIN}/collection`);
    await expect(heading(page)).toHaveText("All owned");
  });
});

test.describe("phone", () => {
  test.use({
    viewport: { width: 375, height: 812 },
    isMobile: true,
    hasTouch: true,
  });

  test("the sign-in card fills the width between the page margins, and provider sign-in works in it", async ({
    page,
  }) => {
    await page.goto(`${ORIGIN}/sign-in`);
    await expect(heading(page)).toHaveText("Sign in to PrizeCheck");
    await expect.poll(async () => (await card(page).boundingBox())?.x).toBe(16);
    await expect
      .poll(async () => (await card(page).boundingBox())?.width)
      .toBe(343);
    await expectPageChecks(page, "the sign-in card on a phone");
    await signInWithButton(page, { tap: true });
    await expect(page).toHaveURL(/\/collection$/);
    await expect(heading(page)).toHaveText("All owned");
  });

  test("loading, not found and unavailable pass the page check on a phone", async ({
    page,
  }) => {
    await checkLoading(page, "loading on a phone");
    await page.goto(`${ORIGIN}/nowhere`);
    await expect(heading(page)).toHaveText("Page not found");
    await expectPageChecks(page, "not found on a phone");
    await page.goto(`${ORIGIN}/published/${randomUUID()}`);
    await expect(heading(page)).toHaveText("This deck isn't published anymore");
    await expectPageChecks(page, "unavailable on a phone");
  });

  test("signed in, an unknown token's card sits inside the shell on a phone", async ({
    page,
  }) => {
    await signIn(page);
    await page.goto(`${ORIGIN}/published/${randomUUID()}`);
    await expect(heading(page)).toHaveText("This deck isn't published anymore");
    await expect(mainViews(page)).toBeVisible();
    await expectPageChecks(page, "unavailable inside the shell on a phone");
  });
});
