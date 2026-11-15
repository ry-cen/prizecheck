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
  tradeStep,
} from "./support/trades";

for (const [label, contextOptions] of [
  ["desktop", DESKTOP_SIZE],
  ["phone", { ...PHONE_SIZE, deviceScaleFactor: 2 }],
  ["viewport-only", { viewport: { width: 375, height: 812 } }],
] as const) {
  test(`Trade names and chat capability on ${label}`, async ({
    collectors,
  }) => {
    const ids = seedCatalog();
    const { page: other } = await collectors.signIn();
    const { page } = await collectors.signIn({ contextOptions });
    await nameCollector(other, "Misty W");
    await nameCollector(page, "Ash K");
    await befriend(other, page);
    await hold(
      other,
      await forTradeLeaf(other, "Other shelf"),
      ids["PAL 185"],
      1
    );
    await hold(page, await forTradeLeaf(page, "My shelf"), ids["SVI 166"], 1);
    const trade = await propose(
      other,
      await accountId(page),
      [[ids["PAL 185"], 1]],
      [[ids["SVI 166"], 1]]
    );
    await tradeStep(page, trade, "accept");
    // Keep real Trade state and commands; supply longer display names in the response.
    await page.route("**/api/trades/*", async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      if (body.live_offer) {
        for (const card of body.live_offer.you_give) card.name = "Centiskorch";
        for (const card of body.live_offer.you_get)
          card.name = "Centiskorch VMAX";
      }
      await route.fulfill({ response, json: body });
    });
    await page.addInitScript(() => {
      const samples: string[] = [];
      Object.assign(window, { hintSamples: samples });
      new MutationObserver(() => {
        if (document.body?.textContent?.match(/(?:Ctrl|⌘)\+Enter to send/))
          samples.push("hint");
      }).observe(document, {
        subtree: true,
        childList: true,
        characterData: true,
      });
    });
    await page.goto(`${ORIGIN}/trades/${trade}`);
    const give = page.getByRole("list", { name: "You give", exact: true });
    const get = page.getByRole("list", { name: "You get", exact: true });
    const name = give
      .getByRole("button", { name: /^Centiskorch / })
      .getByText("Centiskorch", { exact: true });
    await expect(name).toBeVisible();
    await expect
      .poll(() =>
        name.evaluate((el) => {
          const range = document.createRange();
          range.selectNodeContents(el);
          return range.getClientRects().length;
        })
      )
      .toBe(1);
    await expect
      .poll(async () => {
        const a = await give.boundingBox();
        const b = await get.boundingBox();
        return !!a && !!b && a.y === b.y;
      })
      .toBe(true);
    await expect(
      page
        .getByRole("main")
        .getByRole("button", { name: "Confirm swap", exact: true })
    ).toBeInViewport({ ratio: 1 });
    if (label !== "desktop") {
      await expect(name).toHaveCSS("overflow-wrap", "normal");
      await expect(name).toHaveCSS("word-break", "normal");
      await expect(name).toHaveCSS("hyphens", "auto");
      await expect(name).toHaveAttribute("lang", "en");
      await expect
        .poll(() =>
          name.evaluate(
            (el) => el.clientWidth === el.closest("button")!.clientWidth
          )
        )
        .toBe(true);
    }
    const hint = page.getByText(/^(Ctrl|⌘)\+Enter to send$/);
    await expect(
      page.getByRole("textbox", { name: "Message Misty W" })
    ).toBeVisible();
    if (label === "phone") {
      await expect(hint).toBeHidden();
      await expect
        .poll(() =>
          page.evaluate(
            () => (window as unknown as { hintSamples: string[] }).hintSamples
          )
        )
        .toEqual([]);
    } else await expect(hint).toBeVisible();
    await test.info().attach("capabilities", {
      body: JSON.stringify(
        await page.evaluate(() => ({
          coarse: matchMedia("(pointer: coarse)").matches,
          hover: matchMedia("(hover: hover)").matches,
          touch: navigator.maxTouchPoints,
        }))
      ),
      contentType: "application/json",
    });
  });
}
