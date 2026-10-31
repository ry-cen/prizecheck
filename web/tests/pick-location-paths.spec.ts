// Full Location paths on the Loan and Trade screens' pick lines, at 320 and 375 px with text enlarged to 200%. Location
// names are unique only among siblings, so Misty keeps cards in Shelf / Binder A / Page 1 and Shelf / Binder B /
// Page 1: her Loan and Trade picks must name both pages apart, and an out-of-date pick and its suggestion name full
// paths too, Unsorted included. Text is enlarged as public-header.spec.ts does (every element's computed size, since
// the type tokens are px), and the pick lines are measured at twice their size. Ash, the other side, signs in first.
// The catalog is the Swap catalog (api/tests/want_list_swap_fixtures.py).
import { randomUUID } from "node:crypto";
import type { Locator, Page } from "@playwright/test";
import {
  expect,
  test,
  type OtherCollector,
  type OtherCollectorOptions,
} from "./support/collectors";
import {
  accountId,
  api,
  befriend,
  hold,
  loanStep,
  nameCollector,
  ORIGIN,
  seedCatalog,
  unsorted,
} from "./support/loans";
import { expectPageChecks } from "./support/page-check";
import { signInAsOwner } from "./support/sign-in";
import { expectTouchTarget } from "./support/touch-target";
import { propose, tradeStep } from "./support/trades";

/** Enlarges text alone by `factor`: every element's computed font size, as public-header.spec.ts does. */
async function enlargeText(page: Page, factor: number) {
  await page.evaluate((factor) => {
    const all = Array.from(document.querySelectorAll<HTMLElement>("body *"));
    const sizes = all.map((el) => parseFloat(getComputedStyle(el).fontSize));
    all.forEach((el, i) =>
      el.style.setProperty("font-size", `${sizes[i] * factor}px`, "important")
    );
  }, factor);
}

const fontSize = (locator: Locator) =>
  locator.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));

/** A Location made through the API inside `parent` (or at the top); returns its id. */
async function location(page: Page, name: string, parent: string | null) {
  const tree = await api(page, "GET", "/api/location-tree");
  const version = parent
    ? (tree.locations as { id: string; version: number }[]).find(
        (item) => item.id === parent
      )!.version
    : null;
  const created = await api(page, "POST", "/api/location-tree", {
    name,
    parent_id: parent,
    parent_version: version,
    idempotency_key: randomUUID(),
  });
  return created.location as { id: string; version: number };
}

/** A Collection Move of `copies` of one Edition from `source` to `destination`, through the API. */
async function move(
  page: Page,
  source: string,
  edition: string,
  copies: number,
  destination: string
) {
  const version = (
    (await api(page, "GET", `/api/holdings/${source}`)).holdings as {
      edition_id: string;
      version: number;
    }[]
  ).find((item) => item.edition_id === edition)!.version;
  const manifest = (
    await api(page, "POST", "/api/moves/manifests", { source_id: source })
  ).id as string;
  await api(page, "PUT", `/api/moves/manifests/${manifest}/items`, {
    items: [
      {
        edition_id: edition,
        quantity: String(copies),
        expected_version: version,
      },
    ],
  });
  await api(page, "POST", `/api/moves/manifests/${manifest}/commit`, {
    destination_id: destination,
    idempotency_key: randomUUID(),
  });
}

/** Opens `url`, enlarges text to 200% and checks each line doubled, wraps inside the page and nothing scrolls sideways. */
async function readAt200(
  page: Page,
  url: string,
  width: number,
  lines: string[],
  label: string
) {
  await page.goto(url);
  const main = page.getByRole("main");
  const found = lines.map((text) => main.getByText(text, { exact: true }));
  for (const line of found) await expect(line).toBeVisible();
  const before = await Promise.all(found.map(fontSize));
  await enlargeText(page, 2);
  expect(await Promise.all(found.map(fontSize))).toEqual(
    before.map((size) => size * 2)
  );
  for (const line of found) {
    const box = await line.boundingBox();
    expect(box && box.x >= 0 && box.x + box.width <= width, label).toBe(true);
  }
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth
    ),
    label
  ).toBe(true);
  await expectPageChecks(page, label);
}

/** The `collectors` fixture: signs in other collectors. */
type Collectors = {
  signIn: (options?: OtherCollectorOptions) => Promise<OtherCollector>;
};

/**
 * Misty (the owner page) with Shelf / Binder A / Page 1 (2 of each Iono) and Shelf / Binder B / Page 1 (1 of each),
 * the Shelf For trade, and an Arven in Unsorted. Ash borrows 3 Iono (PAL 254) and the Arven, and Misty accepts; Misty
 * gives Ash 3 Iono (PAL 185), and Ash accepts. Each test makes the same Collection, Loan and Trade.
 */
async function lendingAndTrading(
  page: Page,
  collectors: Collectors,
  width: number
) {
  const ids = seedCatalog();
  const traded = ids["PAL 185"];
  const lent = ids["PAL 254"];
  const arven = ids["SVI 166"];
  const suffix = randomUUID().slice(0, 6);
  const ash = await collectors.signIn({
    contextOptions: { viewport: { width, height: 640 } },
  });
  await nameCollector(ash.page, "Ash K");

  await signInAsOwner(page, "/collection");
  await nameCollector(page, "Misty W");
  await befriend(page, ash.page);
  const shelf = await location(page, `Shelf ${suffix}`, null);
  const binderA = await location(page, "Binder A", shelf.id);
  const binderB = await location(page, "Binder B", shelf.id);
  const pageA = (await location(page, "Page 1", binderA.id)).id;
  const pageB = (await location(page, "Page 1", binderB.id)).id;
  const loose = await unsorted(page);
  const tree = await api(page, "GET", "/api/location-tree");
  await api(page, "PUT", `/api/location-tree/${shelf.id}/for-trade`, {
    for_trade: true,
    version: (tree.locations as { id: string; version: number }[]).find(
      (item) => item.id === shelf.id
    )!.version,
    idempotency_key: randomUUID(),
  });
  for (const edition of [traded, lent]) {
    await hold(page, pageA, edition, 2);
    await hold(page, pageB, edition, 1);
  }
  await hold(page, loose, arven, 1);

  const loan = (
    await api(ash.page, "POST", "/api/loans", {
      lender_id: await accountId(page),
      lines: [
        { edition_id: lent, quantity: "3" },
        { edition_id: arven, quantity: "1" },
      ],
      idempotency_key: randomUUID(),
    })
  ).id as string;
  await loanStep(page, loan, `/api/loans/${loan}/accept`, {
    lines: [
      { edition_id: lent, promised: "3" },
      { edition_id: arven, promised: "1" },
    ],
  });
  const trade = await propose(page, ash.userId, [[traded, 3]], []);
  await tradeStep(ash.page, trade, "accept");
  return {
    loan,
    trade,
    traded,
    lent,
    pageA,
    pageB,
    loose,
    pathA: `Shelf ${suffix} / Binder A / Page 1`,
    pathB: `Shelf ${suffix} / Binder B / Page 1`,
  };
}

for (const width of [320, 375])
  test.describe(`on a ${width} px phone with text at 200%`, () => {
    test.use({ viewport: { width, height: 640 }, hasTouch: true });

    test("Loan picks name full Location paths, an out-of-date pick and Unsorted included", async ({
      page,
      collectors,
    }) => {
      const { loan, lent, pageA, pageB, pathA, pathB } =
        await lendingAndTrading(page, collectors, width);
      await readAt200(
        page,
        `${ORIGIN}/loans/${loan}`,
        width,
        [`From ${pathA} (2) · ${pathB} (1)`, "From Unsorted"],
        `${width} px Loan picks at 200% text`
      );
      // The handover button's label wraps inside the screen at 200% text, and the button stays touch-sized.
      const handover = page
        .getByRole("main")
        .getByRole("button", { name: "Mark as handed over" });
      const button = await expectTouchTarget(handover);
      expect(button.x >= 0 && button.x + button.width <= width).toBe(true);

      // Page A empties: its pick is out of date and names its full path, and the suggestion names its own.
      await move(page, pageA, lent, 2, pageB);
      await readAt200(
        page,
        `${ORIGIN}/loans/${loan}`,
        width,
        [`${pathA} has no Iono now`, `Suggested: From ${pathB}`],
        `${width} px an out-of-date Loan pick at 200% text`
      );
    });

    test("Trade picks name full Location paths, an out-of-date pick and Unsorted included", async ({
      page,
      collectors,
    }) => {
      const { trade, traded, pageA, loose, pathA, pathB } =
        await lendingAndTrading(page, collectors, width);
      await readAt200(
        page,
        `${ORIGIN}/trades/${trade}`,
        width,
        [`From ${pathA} (2) · ${pathB} (1)`],
        `${width} px Trade picks at 200% text`
      );

      // Page A empties: its pick is out of date and names its full path, and the suggestion names Unsorted.
      await move(page, pageA, traded, 2, loose);
      await readAt200(
        page,
        `${ORIGIN}/trades/${trade}`,
        width,
        [`${pathA} has none now · take them from Unsorted`],
        `${width} px an out-of-date Trade pick at 200% text`
      );
    });
  });
