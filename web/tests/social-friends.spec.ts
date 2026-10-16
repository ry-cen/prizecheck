// Ticket #247: Friends (spec "Friends and finding collectors", "Web screens"). Two collectors on one stack (the
// collectors harness): one finds the other by Handle in the Friends drawer, the other accepts, and either removes the
// friendship; the Invite Link page signed in offers Send Friend Request and never sends one by itself. The other
// collectors sign in first, so the test's own page signs in afterwards as a new account.
import { randomInt, randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { expect, test } from "./support/collectors";
import { signInAsOwner } from "./support/sign-in";
import { expectTouchTarget } from "./support/touch-target";

const ORIGIN = process.env.TEST_ORIGIN || "http://localhost:5173";
const PHONE = { width: 390, height: 844 };

/** Gives the signed-in collector this Display Name and a new Handle, through the API, and returns the Handle. */
async function nameCollector(page: Page, name: string): Promise<string> {
  // Ten random consonants: never a word the name filter refuses.
  const tail = Array.from(
    { length: 10 },
    () => "bcdfghjklmnpqrstvwxz"[randomInt(20)]
  ).join("");
  const handle = `${name.split(" ")[0].toLowerCase()}_${tail}`;
  for (const [path, body] of [
    ["/api/profile/display-name", { display_name: name }],
    ["/api/profile/handle", { handle }],
  ] as const) {
    const response = await page.request.put(`${ORIGIN}${path}`, {
      headers: { origin: ORIGIN },
      data: { ...body, idempotency_key: randomUUID() },
    });
    expect(response.status(), path).toBe(200);
  }
  return handle;
}

async function inviteToken(page: Page): Promise<string> {
  const response = await page.request.get(`${ORIGIN}/api/profile`);
  expect(response.status()).toBe(200);
  return ((await response.json()) as { invite_token: string }).invite_token;
}

const drawer = (page: Page) => page.getByRole("dialog", { name: "Friends" });
const friendsList = (page: Page) =>
  drawer(page).getByRole("region", { name: "Your Friends" });

async function openFriends(page: Page, name = "Friends") {
  await page.getByRole("button", { name, exact: true }).click();
  await expect(drawer(page)).toBeVisible();
}

test("finding a collector by Handle, requesting, accepting and removing a Friend", async ({
  page,
  collectors,
}) => {
  const misty = await collectors.signIn({ next: "/decks" });
  const mistyHandle = await nameCollector(misty.page, "Misty W");
  await signInAsOwner(page, "/decks");
  const ashHandle = await nameCollector(page, "Ash K");

  await openFriends(page);
  await expect(friendsList(page)).toContainText("No Friends yet.");
  await drawer(page).getByRole("button", { name: "Add" }).click();
  const handleField = drawer(page).getByRole("textbox", {
    name: "Their Handle",
  });
  await handleField.fill(`zz_${randomUUID().slice(0, 8)}`);
  await drawer(page).getByRole("button", { name: "Find" }).click();
  await expect(drawer(page).getByRole("alert")).toHaveText(
    "No collector has that Handle."
  );
  // Case is ignored; the Handle shows as Misty chose it.
  await handleField.fill(mistyHandle.toUpperCase());
  await drawer(page).getByRole("button", { name: "Find" }).click();
  const result = drawer(page).getByRole("group", { name: "Search result" });
  await expect(result).toContainText(`Misty W @${mistyHandle}`);
  await result.getByRole("button", { name: "Send Friend Request" }).click();
  await expect(drawer(page).getByRole("status")).toHaveText(
    "Friend Request sent to Misty W."
  );
  await expect(result).toContainText("You've sent Misty W a Friend Request.");
  await expect(
    drawer(page).getByRole("region", { name: "Requests sent" })
  ).toContainText("Misty W");

  // Misty sees the request on the badge, and accepts it.
  await misty.page.reload();
  await openFriends(misty.page, "Friends, 1 request");
  const received = drawer(misty.page).getByRole("region", {
    name: "Friend Requests",
  });
  // The request names its sender by Display Name and Handle.
  await expect(received).toContainText(
    `Ash K @${ashHandle} · wants to be Friends`
  );
  await received.getByRole("button", { name: "Accept Ash K" }).click();
  await expect(drawer(misty.page).getByRole("status")).toHaveText(
    "You and Ash K are now Friends."
  );
  // The request's row is gone; focus stays in the drawer, on the Friends heading.
  await expect(
    drawer(misty.page).getByRole("heading", { name: "Your Friends" })
  ).toBeFocused();
  await expect(friendsList(misty.page)).toContainText("Ash K");
  await expect(received).toHaveCount(0);
  await drawer(misty.page)
    .getByRole("button", { name: "Close Friends" })
    .click();
  await expect(
    misty.page.getByRole("button", { name: "Friends", exact: true })
  ).toBeVisible();

  // Ash's drawer reads the list again when it opens.
  await drawer(page).getByRole("button", { name: "Close Friends" }).click();
  await openFriends(page);
  await expect(friendsList(page)).toContainText(`Misty W @${mistyHandle}`);
  await expect(
    drawer(page).getByRole("region", { name: "Requests sent" })
  ).toHaveCount(0);

  // Remove Friend sits behind the Friend's ⋯ and asks first; it ends the friendship for both.
  await friendsList(page)
    .getByRole("button", { name: "More for Misty W" })
    .click();
  await page.getByRole("menuitem", { name: "Remove Friend" }).click();
  await expect(friendsList(page)).toContainText("Remove Misty W as a Friend?");
  const remove = friendsList(page).getByRole("button", {
    name: "Remove",
    exact: true,
  });
  // The confirming button takes focus; Cancel gives it back to the Friend's ⋯.
  await expect(remove).toBeFocused();
  await friendsList(page).getByRole("button", { name: "Cancel" }).click();
  await expect(
    friendsList(page).getByRole("button", { name: "More for Misty W" })
  ).toBeFocused();
  await friendsList(page)
    .getByRole("button", { name: "More for Misty W" })
    .click();
  await page.getByRole("menuitem", { name: "Remove Friend" }).click();
  await expect(remove).toBeFocused();
  await remove.click();
  await expect(drawer(page).getByRole("status")).toHaveText(
    "Misty W is no longer a Friend."
  );
  await expect(friendsList(page)).toContainText("No Friends yet.");
  await expect(
    drawer(page).getByRole("heading", { name: "Your Friends" })
  ).toBeFocused();
  await misty.page.reload();
  await openFriends(misty.page);
  await expect(friendsList(misty.page)).toContainText("No Friends yet.");
});

test("the Invite Link page signed in offers Send Friend Request, and on a phone the Friends button opens the drawer", async ({
  page,
  collectors,
}) => {
  const misty = await collectors.signIn({
    next: "/decks",
    contextOptions: { viewport: PHONE },
  });
  await nameCollector(misty.page, "Misty W");
  const token = await inviteToken(misty.page);
  await signInAsOwner(page, `/invite/${token}`);
  await nameCollector(page, "Ash K");
  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Misty W invited you to PrizeCheck"
  );
  // Opening the link sends nothing.
  const send = page.getByRole("button", { name: "Send Friend Request" });
  await expect(send).toBeVisible();
  const before = await misty.page.request.get(`${ORIGIN}/api/social/friends`);
  expect(((await before.json()) as { received: unknown[] }).received).toEqual(
    []
  );
  await send.click();
  await expect(page.getByRole("main").getByRole("status")).toHaveText(
    "You've sent Misty W a Friend Request."
  );
  await expect(send).toHaveCount(0);

  // On a phone, the header's Friends button carries the badge and opens the drawer.
  await misty.page.reload();
  const button = misty.page.getByRole("button", {
    name: "Friends, 1 request",
    exact: true,
  });
  await expect(button).toBeVisible();
  await expectTouchTarget(button);
  await button.click();
  await drawer(misty.page)
    .getByRole("button", { name: "Decline Ash K" })
    .click();
  await expect(drawer(misty.page).getByRole("status")).toHaveText(
    "Friend Request declined."
  );
  await expect(
    drawer(misty.page).getByRole("region", { name: "Friend Requests" })
  ).toHaveCount(0);

  // Declined, the page still offers the request, but Misty's decline holds it back for a week, with no reason given.
  await page.reload();
  await expect(send).toBeVisible();
  await send.click();
  await expect(page.getByRole("alert")).toHaveText(
    "You can send another request later."
  );
  // Ash's own link says it is theirs.
  await page.goto(`${ORIGIN}/invite/${await inviteToken(page)}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Ash K invited you to PrizeCheck"
  );
  await expect(page.getByRole("main").getByRole("status")).toHaveText(
    "This is your own Invite Link."
  );
  await expect(send).toHaveCount(0);
});
