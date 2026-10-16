// Ticket #246: Handles, Display Names and the Invite Link (spec "Handles, Invite Links and lookup", "Web screens").
// Settings › Privacy edits the names and the Invite Link; the signed-out Invite Link page shows only the Display Name;
// the phone header's avatar opens the account sheet. Every test starts as a new owner, because a Handle can change
// only once in 30 days.
import { test, expect, type Page } from "@playwright/test";
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

test("on a phone the header avatar opens Settings, Sign-ins, Missing cards, Owner controls for the owner, and Sign out", async ({
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
    "Missing cards",
    "Sign out",
  ]);
  await sheet.getByRole("button", { name: "Sign-ins" }).click();
  await expect(page).toHaveURL(`${ORIGIN}/settings`);
  await expect(
    page.getByRole("heading", { name: "Sign-ins", level: 2 })
  ).toBeInViewport();

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
    "Missing cards",
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
