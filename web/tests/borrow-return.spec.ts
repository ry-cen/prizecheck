import type { Locator, Page } from "@playwright/test";
import {
  expect,
  test,
  type OtherCollector,
  type OtherCollectorOptions,
} from "./support/collectors";
import {
  seedCatalog,
  nameCollector,
  hold,
  unsorted,
  befriend,
} from "./support/loans";
import { signInAsOwner } from "./support/sign-in";

// Opus m11 F7: sending a Borrow Request that was reviewed from the Catalog card dialog used to drop the collector on the
// grid, with `?card=` gone. It now returns to the same card, with its address back and focus on the lender's control.
// A composer opened anywhere else, or closed without sending, behaves as before.
const REVIEW = "Review Borrow Request to Misty W";
const ASK = "Ask to borrow Boss's Orders from Misty W (PAL 172)";
const SENT = "Borrow Request sent to Misty W.";

const composer = (page: Page) =>
  page.getByRole("dialog", { name: "Borrow Request to Misty W" });
const popup = (page: Page) =>
  page.getByRole("dialog", { name: /^Boss's Orders/ });
const notifications = (page: Page) =>
  page.getByRole("region", { name: "Notifications" });
const tray = (page: Page) =>
  page.getByRole("region", { name: "Borrow Request drafts" });
const confirmation = (page: Page) =>
  popup(page).getByRole("status").filter({ hasText: SENT });
const search = (page: Page) => new URL(page.url()).search;

/** The element sits wholly inside the dialog, and nothing in the dialog or the page scrolls sideways. */
async function expectInside(dialog: Locator, element: Locator) {
  const box = (await element.boundingBox())!;
  const own = (await dialog.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(own.x);
  expect(box.x + box.width).toBeLessThanOrEqual(own.x + own.width);
  const overflow = await dialog.evaluate((node) => ({
    dialog: node.scrollWidth - node.clientWidth,
    page:
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  }));
  expect(overflow).toEqual({ dialog: 0, page: 0 });
}

/** Records what a screen reader would be told: text added to a live region that is not switched off and is inside the
 * open modal dialog (the rest of the page is inert while one is open). Read it with `heard`. */
async function watch(page: Page) {
  await page.evaluate(() => {
    const selector = '[aria-live], [role="status"], [role="alert"]';
    const clean = (text: string | null) =>
      (text ?? "").replace(/\s+/g, " ").trim();
    const updates: string[] = [];
    const spoken = (region: Element) => {
      if (region.closest("[aria-live]")?.getAttribute("aria-live") === "off")
        return false;
      const modal = [...document.querySelectorAll("dialog[open]")].at(-1);
      return !modal || modal.contains(region);
    };
    new MutationObserver((records) => {
      for (const record of records) {
        const targets: [Element | null, string][] = [];
        if (record.type === "characterData")
          targets.push([
            record.target.parentElement?.closest(selector) ?? null,
            clean(record.target.textContent),
          ]);
        else
          record.addedNodes.forEach((node) => {
            const el = node instanceof Element ? node : node.parentElement;
            const inside = (record.target as Element).closest?.(selector);
            if (inside) targets.push([inside, clean(node.textContent)]);
            else if (node instanceof Element) {
              if (node.matches(selector))
                targets.push([node, clean(node.textContent)]);
              node
                .querySelectorAll(selector)
                .forEach((region) =>
                  targets.push([region, clean(region.textContent)])
                );
            } else if (el)
              targets.push([el.closest(selector), clean(node.textContent)]);
          });
        for (const [region, text] of targets)
          if (region && text && spoken(region)) updates.push(text);
      }
      document.documentElement.dataset.liveUpdates = JSON.stringify(updates);
    }).observe(document.documentElement, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    document.documentElement.dataset.liveUpdates = "[]";
  });
}

const heard = (page: Page) =>
  page.evaluate(
    () =>
      JSON.parse(
        document.documentElement.dataset.liveUpdates ?? "[]"
      ) as string[]
  );

/** Lets late announcements land: two frames after the last visible effect. */
const settle = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((done) =>
        requestAnimationFrame(() => requestAnimationFrame(() => done()))
      )
  );

async function setUp(
  page: Page,
  collectors: {
    signIn: (options?: OtherCollectorOptions) => Promise<OtherCollector>;
  }
) {
  const ids = seedCatalog();
  const friend = await collectors.signIn({ next: "/loans" });
  await nameCollector(friend.page, "Misty W");
  await hold(friend.page, await unsorted(friend.page), ids["PAL 172"], 3);
  await signInAsOwner(page, "/catalog");
  await befriend(page, friend.page);
}

/** Opens Boss's Orders from the results, asks Misty W for it, and returns the card's address. */
async function askFromCard(page: Page) {
  await page
    .getByRole("region", { name: "Catalog results" })
    .getByRole("button", { name: /^Boss's Orders, PAL 172, .*Normal,/ })
    .click();
  await expect(popup(page)).toBeVisible();
  await expect(popup(page).getByRole("button", { name: ASK })).toBeVisible();
  expect(search(page)).toContain("card=");
  const address = search(page);
  await popup(page).getByRole("button", { name: ASK }).click();
  return address;
}

for (const viewport of [
  { width: 1280, height: 800 },
  { width: 375, height: 812 },
]) {
  test.describe(`at ${viewport.width}`, () => {
    test.use({ viewport });

    test("Sending from a composer opened from the card returns to that card, with its address and focus, and says so once", async ({
      page,
      collectors,
    }) => {
      await setUp(page, collectors);
      const address = await askFromCard(page);

      await popup(page).getByRole("button", { name: REVIEW }).click();
      await expect(composer(page)).toBeVisible();
      await expect(popup(page)).toHaveCount(0);
      expect(search(page)).not.toContain("card=");

      await watch(page);
      await composer(page)
        .getByRole("button", { name: "Send Borrow Request" })
        .click();
      await expect(composer(page)).toHaveCount(0);

      // Back on the card: its address is restored, and focus is on the lender's control, not the page or the grid.
      await expect(popup(page)).toBeVisible();
      await expect.poll(() => search(page)).toBe(address);
      const ask = popup(page).getByRole("button", { name: ASK });
      await expect(ask).toBeVisible();
      await expect(ask).toBeFocused();
      await expect(page.getByRole("dialog")).toHaveCount(1);

      // The card says the request was sent, in view and inside the dialog, and that line is all a screen reader hears.
      await expect(confirmation(page)).toBeVisible();
      await expect(confirmation(page)).toHaveText(SENT);
      await expectInside(popup(page), confirmation(page));
      await expect(notifications(page)).toContainText(SENT);
      await settle(page);
      expect(
        (await heard(page)).filter((text) =>
          text.includes("Borrow Request sent")
        )
      ).toEqual([SENT]);

      // Closing the card works as it always did: no card in the address, and the toast is still there to use.
      await popup(page)
        .getByRole("button", { name: /^Close/ })
        .click();
      await expect(popup(page)).toHaveCount(0);
      expect(search(page)).not.toContain("card=");
      await expect(
        notifications(page).getByRole("button", { name: "View" })
      ).toBeVisible();

      // Opening the card again starts without the line.
      await page
        .getByRole("region", { name: "Catalog results" })
        .getByRole("button", { name: /^Boss's Orders, PAL 172, .*Normal,/ })
        .click();
      await expect(
        popup(page).getByRole("button", { name: ASK })
      ).toBeVisible();
      await expect(confirmation(page)).toHaveCount(0);
      await settle(page);
      expect(
        (await heard(page)).filter((text) =>
          text.includes("Borrow Request sent")
        )
      ).toEqual([SENT]);
    });

    test("The confirmation in the card goes with the collector's next action in it", async ({
      page,
      collectors,
    }) => {
      await setUp(page, collectors);
      await askFromCard(page);
      await popup(page).getByRole("button", { name: REVIEW }).click();
      await composer(page)
        .getByRole("button", { name: "Send Borrow Request" })
        .click();
      await expect(confirmation(page)).toBeVisible();

      await popup(page).getByRole("button", { name: ASK }).click();
      await expect(confirmation(page)).toHaveCount(0);
      await expect(
        popup(page).getByRole("group", {
          name: "Copies of Boss's Orders to ask Misty W for (PAL 172)",
        })
      ).toBeVisible();
    });

    test("Closing the composer without sending does not bring the card back, and a later tray Review doesn't either", async ({
      page,
      collectors,
    }) => {
      await setUp(page, collectors);
      await askFromCard(page);

      for (const leave of ["Keep draft", "Discard"]) {
        await popup(page).getByRole("button", { name: REVIEW }).click();
        await expect(composer(page)).toBeVisible();
        await composer(page).getByRole("button", { name: leave }).click();
        await expect(composer(page)).toHaveCount(0);
        await expect(page.getByRole("dialog")).toHaveCount(0);
        expect(search(page)).not.toContain("card=");
        if (leave === "Keep draft") {
          // The unsent Review left nothing behind: the tray's Review, sent, does not reopen the card.
          await tray(page).getByRole("button", { name: REVIEW }).click();
          await composer(page)
            .getByRole("button", { name: "Send Borrow Request" })
            .click();
          await expect(composer(page)).toHaveCount(0);
          await expect(notifications(page)).toContainText(SENT);
          await settle(page);
          await expect(page.getByRole("dialog")).toHaveCount(0);
          expect(search(page)).not.toContain("card=");
          // Start over for the Discard half.
          await page
            .getByRole("region", { name: "Catalog results" })
            .getByRole("button", { name: /^Boss's Orders, PAL 172, .*Normal,/ })
            .click();
          await popup(page).getByRole("button", { name: ASK }).click();
        }
      }
    });

    test("A composer opened from the tray is unchanged: Send leaves the grid with the toast holding focus", async ({
      page,
      collectors,
    }) => {
      await setUp(page, collectors);
      await askFromCard(page);
      await popup(page)
        .getByRole("button", { name: /^Close/ })
        .click();
      await expect(popup(page)).toHaveCount(0);

      await tray(page).getByRole("button", { name: REVIEW }).click();
      await expect(composer(page)).toBeVisible();
      await watch(page);
      await composer(page)
        .getByRole("button", { name: "Send Borrow Request" })
        .click();
      await expect(composer(page)).toHaveCount(0);
      await expect(notifications(page)).toContainText(SENT);
      await expect(
        notifications(page).getByRole("button", { name: "View" })
      ).toBeFocused();
      await settle(page);
      await expect(page.getByRole("dialog")).toHaveCount(0);
      expect(search(page)).not.toContain("card=");
      expect(
        (await heard(page)).filter((text) =>
          text.includes("Borrow Request sent")
        )
      ).toHaveLength(1);
    });
  });
}
