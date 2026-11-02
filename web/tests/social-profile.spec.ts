// Ticket #246: Handles, Display Names and the Invite Link (spec "Handles, Invite Links and lookup", "Web screens").
// Settings › Privacy edits the names and the Invite Link; the signed-out Invite Link page shows only the Display Name;
// the phone header's avatar opens the account sheet. Every test starts as a new owner, because a Handle can change
// only once in 30 days.
import { test, expect, type Page, type Route } from "@playwright/test";
import { randomInt } from "node:crypto";
import { Pool } from "pg";
import { startAsNewOwner } from "./support/owner";
import { fakeSignIn, signInAsOwner } from "./support/sign-in";
import { expectTouchTarget } from "./support/touch-target";

const ORIGIN = process.env.TEST_ORIGIN || "http://localhost:5173";
const OWNER_EMAIL = process.env.OWNER_EMAIL || "owner@example.test";
const PHONE = { width: 390, height: 844 };

async function signIn(page: Page, next = "/settings") {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await startAsNewOwner(pool);
  } finally {
    await pool.end();
  }
  await signInAsOwner(page, next);
}

const privacy = (page: Page) => page.getByRole("region", { name: "Privacy" });
// Consonants only: a hex run can spell an entry of the name filter's word list, which made a random Handle refused
// now and then. A run of consonants never trips it (api/tests/test_friends.py explains why).
const uniqueHandle = () =>
  `ash_${Array.from({ length: 12 }, () => "bcdfghjklmnpqrstvwxz"[randomInt(20)]).join("")}`;

test("Settings › Privacy edits the Display Name and the Handle", async ({
  page,
}) => {
  await signIn(page);
  const section = privacy(page);
  const name = section.getByRole("textbox", { name: "Display Name" });
  const handle = section.getByRole("textbox", { name: "Handle" });
  await expect(name).toHaveValue("Collector");
  await expect(handle).toHaveValue(/^collector_[a-z0-9]{8}$/);

  await name.fill("Misty W");
  await section.getByRole("button", { name: "Save name" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Display Name saved." })
  ).toBeVisible();
  await name.fill("Admin");
  await section.getByRole("button", { name: "Save name" }).click();
  await expect(section.getByRole("alert")).toHaveText(
    "That name isn't allowed. Try another."
  );

  const chosen = uniqueHandle();
  await handle.fill(chosen);
  await section.getByRole("button", { name: "Save Handle" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Handle saved." })
  ).toBeVisible();
  await expect(section).toContainText("You can change your Handle again on");
  // A second change within 30 days is refused; a change of case only is not.
  await handle.fill(uniqueHandle());
  await section.getByRole("button", { name: "Save Handle" }).click();
  await expect(section.getByRole("alert")).toContainText(
    "You can change your Handle again on"
  );
  await handle.fill(chosen.toUpperCase());
  const put = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/profile/handle") && r.request().method() === "PUT"
  );
  await section.getByRole("button", { name: "Save Handle" }).click();
  expect((await put).ok()).toBe(true);
  await expect(
    page.getByRole("status").filter({ hasText: "Handle saved." })
  ).toBeVisible();
  await expect(section.getByRole("alert")).toHaveCount(0);
  await page.reload();
  await expect(
    privacy(page).getByRole("textbox", { name: "Display Name" })
  ).toHaveValue("Misty W");
  await expect(
    privacy(page).getByRole("textbox", { name: "Handle" })
  ).toHaveValue(chosen.toUpperCase());
});

test("the Invite Link page shows only the Display Name signed out, and a new link stops the old one", async ({
  page,
  browser,
}) => {
  await signIn(page);
  const section = privacy(page);
  await section
    .getByRole("textbox", { name: "Display Name" })
    .fill("Brock Stone");
  await section.getByRole("button", { name: "Save name" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Display Name saved." })
  ).toBeVisible();
  const link = await section
    .getByRole("textbox", { name: "Your Invite Link" })
    .inputValue();
  expect(link).toMatch(new RegExp(`^${ORIGIN}/invite/[A-Za-z0-9_-]{32}$`));
  const token = link.split("/invite/")[1];

  const visitor = await browser.newContext();
  try {
    const guest = await visitor.newPage();
    await guest.goto(link);
    await expect(guest.getByRole("heading", { level: 1 })).toHaveText(
      "Brock Stone invited you to PrizeCheck"
    );
    await expect(guest.locator('meta[name="robots"]')).toHaveAttribute(
      "content",
      "noindex, nofollow"
    );
    // Nothing else about the collector: no Handle, no email.
    const handle = await section
      .getByRole("textbox", { name: "Handle" })
      .inputValue();
    await expect(guest.locator("main")).not.toContainText(handle);
    await expect(guest.locator("body")).not.toContainText(OWNER_EMAIL);
    await guest
      .getByRole("main")
      .getByRole("link", { name: "Sign in" })
      .click();
    await expect(guest).toHaveURL(
      `${ORIGIN}/sign-in?next=${encodeURIComponent(`/invite/${token}`)}`
    );

    // Make a new link: the old one stops working, the new one shows the name.
    await section.getByRole("button", { name: "Make a new link" }).click();
    const confirm = page.getByRole("dialog", {
      name: "Make a new Invite Link?",
    });
    await confirm.getByRole("button", { name: "Make a new link" }).click();
    await expect(
      page.getByRole("status").filter({
        hasText: "New Invite Link made. The old one no longer works.",
      })
    ).toBeVisible();
    const fresh = await section
      .getByRole("textbox", { name: "Your Invite Link" })
      .inputValue();
    expect(fresh).not.toBe(link);
    await guest.goto(link);
    await expect(guest.getByRole("heading", { level: 1 })).toHaveText(
      "This link no longer works"
    );
    await guest.goto(fresh);
    await expect(guest.getByRole("heading", { level: 1 })).toHaveText(
      "Brock Stone invited you to PrizeCheck"
    );

    // Signing in from the page comes back to it.
    const freshToken = fresh.split("/invite/")[1];
    await fakeSignIn(guest, { next: `/invite/${freshToken}` });
    await expect(guest).toHaveURL(`${ORIGIN}/invite/${freshToken}`);
    await expect(guest.getByRole("heading", { level: 1 })).toHaveText(
      "Brock Stone invited you to PrizeCheck"
    );
    await expect(
      guest.getByRole("main").getByRole("link", { name: "Sign in" })
    ).toHaveCount(0);
  } finally {
    await visitor.close();
  }
});

// #326: the sections above Sign-ins grow when their data arrives. The collector's request for Sign-ins waits for them,
// so a cold entry with slow Settings and profile requests still ends on the Sign-ins heading, focused, and stays there.
const delayed = (delayMs: number) => async (route: Route) => {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
  await route.continue();
};

async function openSignInsFromAccountSheet(page: Page) {
  await page.getByRole("button", { name: "Account", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Account" })
    .getByRole("button", { name: "Sign-ins" })
    .click();
  await expect(page).toHaveURL(`${ORIGIN}/settings`);
}

const signInsHeading = (page: Page) =>
  page.getByRole("heading", { name: "Sign-ins", level: 2 });

test("on a phone Sign-ins still lands on its heading when Settings and the profile load slowly", async ({
  page,
}) => {
  await page.setViewportSize(PHONE);
  await signIn(page, "/collection");
  await page.route("**/api/settings", delayed(500));
  await page.route("**/api/profile", delayed(1500));
  await page.route("**/api/social/blocks", delayed(1000));
  await page.route("**/api/social/discovery", delayed(2500));
  await page.route("**/api/location-tree", delayed(2000));
  await openSignInsFromAccountSheet(page);

  const heading = signInsHeading(page);
  await expect(heading).toBeFocused();
  await expect(heading).toBeInViewport();
  const top = async () => (await heading.boundingBox())?.y;
  const landedAt = await top();
  // Every section above has loaded by now, and the heading did not move, leave the view or lose focus.
  await expect(page.getByText("Loading…")).toHaveCount(0);
  await expect(privacy(page).getByLabel("Display Name")).toBeVisible();
  await expect.poll(top).toBe(landedAt);
  await expect(heading).toBeInViewport({ ratio: 1 });
  await expect(heading).toBeFocused();
});

// @slow (wall-clock): waits out the real 5 s SETTINGS_SECTION_DEADLINE_MS, a production constant with no test seam.
test(
  "on a phone Sign-ins is still shown and focused when one Settings request never answers",
  { tag: "@slow" },
  async ({ page }) => {
    await page.setViewportSize(PHONE);
    await signIn(page, "/collection");
    const release = Promise.withResolvers<void>();
    await page.route("**/api/location-tree", async (route) => {
      await release.promise;
      await route.continue();
    });
    try {
      await openSignInsFromAccountSheet(page);
      // The deadline (5 s) passes, then the section is shown although the Locations never loaded.
      await expect(signInsHeading(page)).toBeFocused({ timeout: 15_000 });
      await expect(signInsHeading(page)).toBeInViewport();
    } finally {
      release.resolve();
    }
  }
);

test("on a phone the collector's own tap on Settings cancels the jump to Sign-ins", async ({
  page,
}) => {
  await page.setViewportSize(PHONE);
  await signIn(page, "/collection");
  const release = Promise.withResolvers<void>();
  await page.route("**/api/profile", async (route) => {
    await release.promise;
    await route.continue();
  });
  try {
    await openSignInsFromAccountSheet(page);
    await page.getByRole("heading", { name: "Settings", level: 1 }).click();
    release.resolve();
    await expect(page.getByText("Loading…")).toHaveCount(0);
    await expect(privacy(page).getByLabel("Display Name")).toBeVisible();
    await expect(signInsHeading(page)).not.toBeFocused();
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  } finally {
    release.resolve();
  }
});

test("on a phone the header avatar opens Settings, Sign-ins, Card reports, Owner controls for the owner, and Sign out", async ({
  page,
}) => {
  await page.setViewportSize(PHONE);
  await signIn(page, "/collection");
  // Collection draws its own phone header; the avatar is there too.
  const avatar = page.getByRole("button", { name: "Account", exact: true });
  await expect(avatar).toBeVisible();
  await expectTouchTarget(avatar);
  await avatar.click();
  const sheet = page.getByRole("dialog", { name: "Account" });
  await expect(sheet.getByRole("list").getByRole("button")).toHaveText([
    "Settings",
    "Sign-ins",
    "Card reports",
    "Sign out",
  ]);
  await sheet.getByRole("button", { name: "Sign-ins" }).click();
  await expect(page).toHaveURL(`${ORIGIN}/settings`);
  const heading = signInsHeading(page);
  await expect(heading).toBeInViewport();
  await expect(heading).toBeFocused();

  // The owner also gets Owner controls.
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await pool.query(
      'INSERT INTO owner_binding(singleton,user_id) SELECT true,id FROM "user" WHERE email=$1 ON CONFLICT(singleton) DO UPDATE SET user_id=EXCLUDED.user_id',
      [OWNER_EMAIL]
    );
  } finally {
    await pool.end();
  }
  await page.goto(`${ORIGIN}/decks`);
  await avatar.click();
  await expect(sheet.getByRole("list").getByRole("button")).toHaveText([
    "Settings",
    "Sign-ins",
    "Card reports",
    "Owner controls",
    "Sign out",
  ]);
  await sheet.getByRole("button", { name: "Settings" }).click();
  await expect(page).toHaveURL(`${ORIGIN}/settings`);
  await expect(
    page.getByRole("heading", { name: "Settings", level: 1 })
  ).toBeVisible();
  await avatar.click();
  await sheet.getByRole("button", { name: "Sign out" }).click();
  await expect(
    page.getByRole("link", { name: "Continue with Google" })
  ).toBeVisible();
});
