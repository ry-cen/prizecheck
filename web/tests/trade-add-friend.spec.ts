// Ticket #304 (Trading Stage 2, "Add as Friend"): after both sides confirm a Trade, collectors who are not Friends can
// offer to become Friends from that Trade. Ash (the test's page, B) adds Misty (A) on the Trade screen and sees the sent
// state there and in the conversation, with no Handle of Misty's on his screens; Misty accepts in the Friends drawer,
// and Ash then sees her Handle. The control shows on neither the stranger's Trade List nor before both confirm.
// The catalog is the Swap catalog (api/tests/want_list_swap_fixtures.py).
import type { Page } from "@playwright/test";
import { expect, test } from "./support/collectors";
import {
  discoverable,
  seedZips,
  timeline,
  traderIdOf,
} from "./support/conversations";
import {
  accountId,
  hold,
  nameCollector,
  ORIGIN,
  seedCatalog,
} from "./support/loans";
import { expectPageChecks } from "./support/page-check";
import { signInAsOwner } from "./support/sign-in";
import {
  DESKTOP_SIZE,
  forTradeLeaf,
  proposeToTrader,
  tradeStep,
} from "./support/trades";

const noArtwork = (page: Page) =>
  page.route(/^https:\/\/assets\.tcgdex\.net\//, (route) => route.abort());
const drawer = (page: Page) => page.getByRole("dialog", { name: "Friends" });

async function openFriends(page: Page, name = "Friends") {
  await page.getByRole("button", { name, exact: true }).click();
  await expect(drawer(page)).toBeVisible();
}

test("after both confirm a Trade, Ash adds Misty as a Friend and Misty accepts in the Friends drawer", async ({
  page,
  collectors,
}) => {
  const ids = seedCatalog();
  const misty = (await collectors.signIn({ contextOptions: DESKTOP_SIZE }))
    .page;
  await nameCollector(misty, "Misty W");
  await hold(
    misty,
    await forTradeLeaf(misty, "Misty Binder"),
    ids["PAL 185"],
    1
  );
  await signInAsOwner(page, "/collection");
  await nameCollector(page, "Ash K");
  await hold(page, await forTradeLeaf(page, "Ash Shelf"), ids["SVI 166"], 1);
  await seedZips();
  await discoverable(misty, "00010");
  await discoverable(page, "00011");
  for (const on of [page, misty]) await noArtwork(on);
  const mistyHandle = (
    await collectors.pool.query<{ handle: string }>(
      "SELECT handle FROM collector_profile WHERE user_id = $1",
      [await accountId(misty)]
    )
  ).rows[0].handle;
  const mistyTrader = await traderIdOf(misty);
  const addFriend = page.getByRole("button", { name: "Add as Friend" });

  // Both-confirmed through the API; before that, the Trade screen offers nothing.
  const id = await proposeToTrader(
    page,
    mistyTrader,
    [[ids["SVI 166"], 1]],
    [[ids["PAL 185"], 1]]
  );
  await tradeStep(misty, id, "accept");
  await page.goto(`${ORIGIN}/trades/${id}`);
  await expect(page.getByText("Trade with Misty W")).toBeVisible();
  await expect(addFriend).toHaveCount(0);
  await tradeStep(page, id, "confirm-swap");
  await tradeStep(misty, id, "confirm-swap");

  // Not on the stranger's Trade List.
  await page.goto(`${ORIGIN}/trades/trader/${mistyTrader}`);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    "Misty W"
  );
  await expect(addFriend).toHaveCount(0);

  // Ash adds Misty on the Trade screen.
  await page.goto(`${ORIGIN}/trades/${id}`);
  await expect(addFriend).toBeVisible();
  await expectPageChecks(page, "trade screen offering Add as Friend");
  await addFriend.click();
  await expect(page.getByText("Friend Request sent to Misty W.")).toBeVisible();
  await expect(
    page.getByText("You've sent Misty W a Friend Request.")
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Withdraw request to Misty W" })
  ).toBeFocused();
  await expect(page.locator("body")).not.toContainText(mistyHandle);

  // The conversation shows the same state.
  await page.goto(`${ORIGIN}/trades/with/${mistyTrader}`);
  await expect(
    timeline(page).getByText("You've sent Misty W a Friend Request.")
  ).toBeVisible();
  await expect(page.locator("body")).not.toContainText(mistyHandle);

  // Misty accepts in the Friends drawer.
  await misty.reload();
  await openFriends(misty, "Friends, 1 request");
  const received = drawer(misty).getByRole("region", {
    name: "Friend Requests",
  });
  await expect(received).toContainText("Ash K @");
  await expect(received).toContainText("wants to be Friends");
  await received.getByRole("button", { name: "Accept Ash K" }).click();
  await expect(drawer(misty).getByRole("status")).toHaveText(
    "You and Ash K are now Friends."
  );

  // Ash is now Friends with her: her Handle shows and the control is gone.
  await page.goto(`${ORIGIN}/trades/${id}`);
  await expect(page.getByText(`@${mistyHandle}`)).toBeVisible();
  await expect(addFriend).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Withdraw request to Misty W" })
  ).toHaveCount(0);
});
