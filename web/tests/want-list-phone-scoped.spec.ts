import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { test, expect, type OtherCollectorOptions } from "./support/collectors";
import {
  api,
  accountId,
  befriend,
  createDeck,
  hold,
  nameCollector,
  ORIGIN,
  setLine,
  unsorted,
} from "./support/loans";
const HELP =
  "Choose which versions you would accept in a Swap or Trade. This does not change how many cards your Deck needs.";

import { expectTouchTarget } from "./support/touch-target";

async function fixture(
  collectors: {
    signIn: (
      options?: OtherCollectorOptions
    ) => Promise<{ page: import("@playwright/test").Page }>;
  },
  phone = true,
  long = false,
  partial = true,
  countingStress = false
) {
  const output = execFileSync(
    ".venv/bin/python",
    [
      "-c",
      `import json
from datetime import datetime, timezone
from test_prices import ui_world, ui_apply
ids = ui_world(0)
now = datetime.now(timezone.utc).isoformat()
ui_apply([dict(op='quote', edition=ids[key], amount='0.25', updated=now, checked=now) for key in ['normal', 'reverse-holofoil']])
print('WORLD' + json.dumps(ids))`,
    ],
    { env: { ...process.env, PYTHONPATH: "api:api/tests" } }
  ).toString();
  const ids = JSON.parse(output.slice(output.lastIndexOf("WORLD") + 5));
  const friend = (await collectors.signIn()).page;
  await nameCollector(friend, "Misty W");
  await hold(friend, await unsorted(friend), ids.normal, 4);
  const extraFriends = [];
  if (long) {
    for (const name of [
      "Alexandra Practice Partner",
      "Chris Weekend Practice Partner",
    ]) {
      const extra = (await collectors.signIn()).page;
      await nameCollector(extra, name);
      await hold(extra, await unsorted(extra), ids.normal, 4);
      extraFriends.push(extra);
    }
  }
  const page = (
    await collectors.signIn({
      contextOptions: {
        viewport: phone
          ? { width: 375, height: 812 }
          : { width: 1280, height: 800 },
        isMobile: phone,
        hasTouch: phone,
      },
    })
  ).page;
  await page.route(/^https:\/\/assets\.tcgdex\.net\//, (route) =>
    route.abort()
  );
  await befriend(page, friend);
  for (const extra of extraFriends) await befriend(page, extra);
  const names = [
    long
      ? "A very long Deck name with sixty characters for reachability!!"
      : "Evening practice Deck",
    countingStress
      ? "Another practice Deck with a long name for counted copies"
      : "Another practice Deck",
    countingStress
      ? "Weekend practice Deck with a long name for counted copies"
      : "Weekend practice Deck",
    countingStress
      ? "Tournament trial Deck with a long name for counted copies"
      : "Tournament trial Deck",
  ];
  const decks = [];
  for (const name of names) decks.push(await createDeck(page, name));
  await setLine(page, decks[0], ids.normal, countingStress ? 10 : 3);
  await setLine(
    page,
    decks[0],
    partial ? ids.unspecified : ids["reverse-holofoil"],
    1
  );
  if (countingStress) {
    for (const deck of decks.slice(1)) await hold(page, deck, ids.normal, 1);
    const settings = await api(page, "GET", "/api/settings");
    await api(page, "PUT", "/api/settings/want-list-counting", {
      revision: settings.revision,
      idempotency_key: randomUUID(),
      want_list_counting: "one_at_a_time",
    });
  }
  await api(page, "POST", "/api/loans", {
    lender_id: await accountId(friend),
    lines: [{ edition_id: ids.normal, quantity: "1" }],
    deck_id: decks[0],
    idempotency_key: randomUUID(),
  });
  for (const extra of extraFriends) {
    await api(page, "POST", "/api/loans", {
      lender_id: await accountId(extra),
      lines: [{ edition_id: ids.normal, quantity: "1" }],
      deck_id: decks[0],
      idempotency_key: randomUUID(),
    });
  }
  await page.goto(`${ORIGIN}/decks/want-list?deck=${decks[0]}`);
  const summary = page.getByRole("region", {
    name: `Want List · ${names[0]}`,
    exact: true,
  });
  await expect(summary).toContainText("cards priced");
  await summary.getByRole("radio", { name: "Buy", exact: true }).check();
  const list = page.getByRole("list", {
    name: `What ${names[0]} needs`,
    exact: true,
  });
  await expect(list).toContainText("Misty W");
  await expect(list).toContainText(/Asked Misty W for 1/);
  return { page, summary, list, names, decks };
}

for (const partial of [false, true]) {
  test(`phone: a scoped Want List shows the first card's Will accept choices above the tab bar (${partial ? "partially priced" : "priced"})`, async ({
    collectors,
  }) => {
    const { page, list } = await fixture(collectors, true, false, partial);
    await page.evaluate(() => scrollTo(0, 0));
    await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
    const rg = list
      .getByRole("radiogroup", { name: /^Will accept for / })
      .first();
    await expect(rg).toBeVisible();
    const bounds = await page.evaluate(() => {
      const rg = document
        .querySelector('ul[aria-label^="What "] [role="radiogroup"]')!
        .getBoundingClientRect()
        .toJSON();
      const nav = [...document.querySelectorAll('nav[aria-label="Main views"]')]
        .find((node) => node.getBoundingClientRect().height > 0)!
        .getBoundingClientRect()
        .toJSON();
      const list = document.querySelector('ul[aria-label^="What "]')!;
      const section = list.closest("section")!;
      const page = section.parentElement!.parentElement!.parentElement!;
      const summary = page.querySelector("section")!;
      const box = (node: Element | null) =>
        node?.getBoundingClientRect().toJSON();
      const blocks = {
        summary: box(summary),
        summaryRows: [...summary.children].map(box),
        viewSwitch: box(summary.querySelector('[role="radiogroup"]')),
        chips: box(
          document.querySelector('[role="group"][aria-label="Show Decks"]')
        ),
        section: box(section),
        help: box(section.querySelector(":scope > p:last-child")),
        caption: box(
          list.firstElementChild?.querySelector('[role="radiogroup"]')
            ?.previousElementSibling ?? null
        ),
        firstTile: box(list.firstElementChild),
      };
      return {
        rg,
        nav,
        blocks,
        margin: nav.top - rg.bottom,
        width: document.documentElement.clientWidth,
      };
    });
    await test.info().attach("first-want-controls", {
      body: JSON.stringify(bounds),
      contentType: "application/json",
    });
    expect(bounds.margin).toBeGreaterThanOrEqual(16);
    expect(bounds.blocks.summaryRows[1]!.height).toBeLessThanOrEqual(56);
    expect(bounds.blocks.summaryRows[3]!.height).toBeLessThanOrEqual(56);
    await expect(
      list
        .getByRole("listitem")
        .first()
        .getByText("Will accept in a Swap or Trade", { exact: true })
    ).toBeInViewport();
    expect(bounds.rg.top).toBeGreaterThanOrEqual(0);
    expect(bounds.rg.bottom).toBeLessThanOrEqual(bounds.nav.top);
    expect(bounds.rg.left).toBeGreaterThanOrEqual(0);
    expect(bounds.rg.right).toBeLessThanOrEqual(bounds.width);
    await expect(
      list.getByRole("listitem").first().locator("p").first()
    ).toBeInViewport();
    for (const label of await rg.locator("label").all())
      await expectTouchTarget(label);
  });
}

test("phone: the scoped page keeps the chips, counting, Settings link, explainer and Open Deck reachable", async ({
  collectors,
}) => {
  const { page, list, names, decks } = await fixture(collectors, true, true);
  const help = page.getByText(HELP, { exact: true });
  await help.scrollIntoViewIfNeeded();
  await expect(help).toBeVisible();
  await expect
    .poll(() =>
      list.evaluate(
        (node) =>
          !!(
            node.compareDocumentPosition(
              node.closest("section")!.querySelector(":scope > p:last-child")!
            ) & Node.DOCUMENT_POSITION_FOLLOWING
          )
      )
    )
    .toBe(true);
  for (const locator of [
    page.getByRole("link", { name: `Open Deck ${names[0]}` }),
    page.getByRole("link", { name: "Change it in Settings" }),
    page.locator("summary").filter({ hasText: "How it counts" }),
  ]) {
    await locator.scrollIntoViewIfNeeded();
    await expectTouchTarget(locator);
  }
  await page.getByRole("link", { name: "Change it in Settings" }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await page.goBack();
  const explainer = page
    .locator("details")
    .filter({ hasText: "How it counts" });
  await explainer.locator("summary").click();
  await expect(explainer.locator("p")).toBeVisible();
  const chips = page.getByRole("group", { name: "Show Decks" });
  for (const chip of await chips.getByRole("button").all()) {
    await chip.scrollIntoViewIfNeeded();
    await expectTouchTarget(chip);
  }
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth
      )
    )
    .toBe(true);
  await chips.getByRole("button", { name: names[1], exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`deck=${decks[1]}`));
});

test("desktop: the scoped page shows Open Deck in the summary, the help after the lines and the counting row last", async ({
  collectors,
}) => {
  const { page, summary, list, names } = await fixture(collectors, false);
  await expect(
    summary.getByRole("link", { name: `Open Deck ${names[0]}` })
  ).toBeVisible();
  await expect
    .poll(() =>
      summary
        .getByRole("button", { name: "Buy on TCGplayer" })
        .evaluate(
          (node) =>
            !!(
              node.compareDocumentPosition(
                node
                  .closest("section")!
                  .querySelector('a[aria-label^="Open Deck "]')!
              ) & Node.DOCUMENT_POSITION_FOLLOWING
            )
        )
    )
    .toBe(true);
  await expect
    .poll(() =>
      list.evaluate(
        (node) =>
          !!(
            node.compareDocumentPosition(
              node.closest("section")!.querySelector(":scope > p:last-child")!
            ) & Node.DOCUMENT_POSITION_FOLLOWING
          )
      )
    )
    .toBe(true);
  await expect(summary.locator("dt")).toHaveText("Needs");
  await expect(
    page.getByRole("heading", { level: 3, name: names[0] })
  ).toHaveClass(/sr-only/);
  await expect
    .poll(() =>
      list.evaluate(
        (node) =>
          !!(
            node.compareDocumentPosition(
              document.querySelector('a[href="/settings"]')!
            ) & Node.DOCUMENT_POSITION_FOLLOWING
          )
      )
    )
    .toBe(true);
});

test("phone: All Decks keeps the help before each list and shows no Will accept caption", async ({
  collectors,
}) => {
  const { page } = await fixture(collectors);
  await page.goto(`${ORIGIN}/decks/want-list`);
  const lists = page.getByRole("list", { name: /^What .* needs$/ });
  await expect(lists).toHaveCount(1);
  await expect(page.getByText(HELP, { exact: true })).toHaveCount(1);
  for (const list of await lists.all()) {
    await expect
      .poll(() =>
        list.evaluate(
          (node) =>
            !!(
              node
                .closest("section")!
                .querySelector(":scope > p")!
                .compareDocumentPosition(node) &
              Node.DOCUMENT_POSITION_FOLLOWING
            )
        )
      )
      .toBe(true);
  }
  await expect(
    page.getByText("Will accept in a Swap or Trade", { exact: true })
  ).toHaveCount(0);
});

for (const phone of [true, false]) {
  test(`${phone ? "phone" : "desktop"}: long counting and pending notes remain reachable without horizontal overflow`, async ({
    collectors,
  }) => {
    const { page, list, names } = await fixture(
      collectors,
      phone,
      true,
      true,
      true
    );
    const line = list
      .getByRole("listitem")
      .filter({ hasText: "Asked Misty W for 1" });
    const counted = line.getByText(/^Have /);
    for (const name of names.slice(1))
      await expect(counted).toContainText(`1 in ${name}`);
    await counted.scrollIntoViewIfNeeded();
    await expect(counted).toBeVisible();
    await expect(line).toContainText("Asked Alexandra Practice Partner for 1");
    await expect(line).toContainText(
      "Asked Chris Weekend Practice Partner for 1"
    );
    for (const target of [
      ...(await line.getByRole("radiogroup").locator("label").all()),
      page.getByText(HELP, { exact: true }),
      page.getByRole("link", { name: "Change it in Settings" }),
    ]) {
      await target.scrollIntoViewIfNeeded();
      await expect(target).toBeVisible();
      if (
        phone &&
        (await target.evaluate(
          (node) => node.tagName === "LABEL" || node.tagName === "A"
        ))
      )
        await expectTouchTarget(target);
    }
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            document.documentElement.scrollWidth <=
            document.documentElement.clientWidth
        )
      )
      .toBe(true);
  });
}
