import { expect, test } from "./support/collectors";
import {
  accountId,
  befriend,
  hold,
  nameCollector,
  ORIGIN,
  seedCatalog,
} from "./support/loans";
import {
  DESKTOP_SIZE,
  PHONE_SIZE,
  forTradeLeaf,
  propose,
} from "./support/trades";

for (const [size, contextOptions, visible] of [
  ["desktop", DESKTOP_SIZE, true],
  ["phone", PHONE_SIZE, false],
] as const) {
  test(`Trade chat send hint on ${size}`, async ({ collectors }) => {
    const ids = seedCatalog();
    const { page: other } = await collectors.signIn();
    const { page } = await collectors.signIn({ contextOptions });
    await nameCollector(other, "Misty W");
    await nameCollector(page, "Ash K");
    await befriend(other, page);
    await hold(
      other,
      await forTradeLeaf(other, "Chat shelf"),
      ids["PAL 185"],
      1
    );
    const trade = await propose(
      other,
      await accountId(page),
      [[ids["PAL 185"], 1]],
      []
    );
    await page.goto(`${ORIGIN}/trades/${trade}`);
    await expect(
      page.getByRole("textbox", { name: "Message Misty W" })
    ).toBeVisible();
    const media = await page.evaluate(() =>
      Object.fromEntries(
        [
          "(pointer: fine)",
          "(pointer: coarse)",
          "(hover: hover)",
          "(any-pointer: fine)",
          "(any-pointer: coarse)",
          "(pointer: fine) and (hover: hover)",
        ].map((query) => [query, matchMedia(query).matches])
      )
    );
    const hint = page.getByText(/^(Ctrl|⌘)\+Enter to send$/);
    await test.info().attach(`send-hint-${size}`, {
      body: JSON.stringify(
        { media, hintVisible: await hint.isVisible() },
        null,
        2
      ),
      contentType: "application/json",
    });
    if (visible) await expect(hint).toBeVisible();
    else await expect(hint).toBeHidden();
  });
}
