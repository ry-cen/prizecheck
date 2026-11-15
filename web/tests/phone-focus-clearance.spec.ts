import { test, expect } from "./support/collectors";
import {
  accountId,
  befriend,
  createDeck,
  hold,
  nameCollector,
  ORIGIN,
  seedCatalog,
  setLine,
} from "./support/loans";
import { forTradeLeaf, propose } from "./support/trades";

for (const [label, options] of [
  [
    "phone",
    { viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true },
  ],
  ["desktop", { viewport: { width: 1280, height: 800 } }],
  ["narrow mouse", { viewport: { width: 700, height: 800 } }],
] as const) {
  test(`${label}: Tab keeps page controls clear of shell chrome`, async ({
    collectors,
  }) => {
    const ids = seedCatalog();
    const { page } = await collectors.signIn({ contextOptions: options });
    await page.route(/^https:\/\/assets\.tcgdex\.net\//, (route) =>
      route.abort()
    );
    const decks = [];
    for (let i = 0; i < 8; i++) {
      const deck = await createDeck(page, `Practice Deck ${i + 1}`);
      await setLine(page, deck, ids["PAL 185"], 4);
      await setLine(page, deck, ids["PAL 172"], 4);
      decks.push(deck);
    }
    const { page: friend } = await collectors.signIn();
    await nameCollector(friend, "Practice partner");
    await nameCollector(page, "Collector");
    await befriend(page, friend);
    const leaf = await forTradeLeaf(page, "Trade binder");
    await hold(page, leaf, ids["PAL 185"], 4);
    const trade = await propose(
      page,
      await accountId(friend),
      [[ids["PAL 185"], 1]],
      []
    );
    for (const path of [
      "/decks/want-list",
      `/decks/${decks[0]}`,
      `/trades/${trade}`,
      "/collection",
    ]) {
      await page.goto(`${ORIGIN}${path}`);
      const main = page.getByRole("main");
      await expect(main).toBeVisible();
      if (path === "/decks/want-list")
        await expect(
          page.getByRole("link", { name: /^Open Deck / }).first()
        ).toBeVisible();
      if (path === `/decks/${decks[0]}`)
        await expect(
          page.getByRole("heading", { name: "Practice Deck 1", exact: true })
        ).toBeVisible();
      if (path.startsWith("/trades/"))
        await expect(main.getByRole("heading", { level: 1 })).toBeVisible();
      if (path === "/collection")
        await expect(
          page.getByRole("region", { name: "Cards", exact: true })
        ).toBeVisible();
      await expect(
        main.getByRole("status").filter({ hasText: /Loading/ })
      ).toHaveCount(0);
      // Begin at the main landmark, then let native Tab navigation scroll the document.
      await main.evaluate((node) => {
        node.tabIndex = -1;
        node.focus();
      });
      let visited = 0;
      let openDeck = 0;
      for (let step = 0; step < 250; step++) {
        await page.keyboard.press("Tab");
        if (
          !(await main.evaluate((node) =>
            node.contains(document.activeElement)
          ))
        )
          break;
        visited++;
        const focused = page.locator(":focus");
        if ((await focused.getAttribute("aria-label"))?.startsWith("Open Deck"))
          openDeck++;
        await expect
          .poll(
            () =>
              focused.evaluate((node) => {
                const box = node.getBoundingClientRect();
                const nav = [
                  ...document.querySelectorAll('nav[aria-label="Main views"]'),
                ]
                  .map((el) => el.getBoundingClientRect())
                  .find(
                    (rect) => rect.height > 0 && rect.top > innerHeight / 2
                  );
                const headerBottom = Math.max(
                  0,
                  ...[...document.querySelectorAll("header")]
                    .filter((el) => getComputedStyle(el).position === "sticky")
                    .map((el) => el.getBoundingClientRect().bottom)
                );
                return (
                  box.top >= headerBottom &&
                  box.bottom <= (nav?.top ?? innerHeight)
                );
              }),
            `${path}: ${(await focused.getAttribute("aria-label")) ?? (await focused.textContent())}`
          )
          .toBe(true);
      }
      expect(visited, path).toBeGreaterThan(0);
      if (path === "/decks/want-list") expect(openDeck).toBe(8);
    }
  });
}
