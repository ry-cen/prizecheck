import { traderIdOf } from "./support/conversations";
// Native and app leave guards protect only edits made since the builder opened.
import { execFileSync } from "node:child_process";
import { randomInt, randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { expect, test } from "./support/collectors";
import { signInAsOwner } from "./support/sign-in";

const ORIGIN = process.env.TEST_ORIGIN || "http://localhost:5173";

type Editions = Record<
  | "PAL 185"
  | "PAL 254"
  | "PAF 80"
  | "SVI 166"
  | "SVI 166 Reverse Holo"
  | "PAL 172",
  string
>;

/** The Swap catalog through the real catalog import (it replaces the catalog); returns the Edition ids by key. */
function seedCatalog(): Editions {
  const out = execFileSync(
    ".venv/bin/python",
    [
      "-c",
      "from want_list_swap_fixtures import print_swap_catalog\nprint_swap_catalog()",
    ],
    {
      env: { ...process.env, PYTHONPATH: "api:api/tests" },
      maxBuffer: 64 * 1024 * 1024,
    }
  ).toString();
  return JSON.parse(out.slice(out.lastIndexOf("SWAP") + 4)) as Editions;
}

async function api(
  page: Page,
  method: "GET" | "POST" | "PUT",
  path: string,
  data?: object
) {
  const response = await page.request.fetch(`${ORIGIN}${path}`, {
    method,
    headers: { origin: ORIGIN },
    data,
  });
  expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBe(
    true
  );
  return response.json();
}

/** Gives the signed-in collector this Display Name and a new Handle, and returns the Handle. */
async function nameCollector(page: Page, name: string): Promise<string> {
  // Ten random consonants: never a word the name filter refuses.
  const tail = Array.from(
    { length: 10 },
    () => "bcdfghjklmnpqrstvwxz"[randomInt(20)]
  ).join("");
  const handle = `${name.split(" ")[0].toLowerCase()}_${tail}`;
  await api(page, "PUT", "/api/profile/display-name", {
    display_name: name,
    idempotency_key: randomUUID(),
  });
  await api(page, "PUT", "/api/profile/handle", {
    handle,
    idempotency_key: randomUUID(),
  });
  return handle;
}

async function accountId(page: Page): Promise<string> {
  return (await api(page, "GET", "/auth/session")).userId as string;
}

/** A Friend Request from `from`, accepted by `to`, through the API. */
async function befriend(from: Page, to: Page) {
  await api(from, "POST", "/api/social/friend-requests", {
    collector_id: await accountId(to),
    idempotency_key: randomUUID(),
  });
  await api(
    to,
    "POST",
    `/api/social/friend-requests/${await accountId(from)}/accept`,
    { idempotency_key: randomUUID() }
  );
}

const hold = (
  page: Page,
  location: string,
  edition: string,
  quantity: number
) =>
  api(page, "POST", "/api/holdings", {
    location_id: location,
    edition_id: edition,
    quantity: String(quantity),
    idempotency_key: randomUUID(),
  });

/** A top-level binder, marked For trade; returns its id. */
async function forTradeBinder(page: Page, name: string): Promise<string> {
  const created = await api(page, "POST", "/api/location-tree", {
    name,
    parent_id: null,
    parent_version: null,
    idempotency_key: randomUUID(),
  });
  const location = created.location as { id: string; version: number };
  await api(page, "PUT", `/api/location-tree/${location.id}/for-trade`, {
    for_trade: true,
    version: location.version,
    idempotency_key: randomUUID(),
  });
  return location.id;
}

const heading = (page: Page) => page.getByRole("heading", { level: 1 });
const isPhone = (page: Page) => (page.viewportSize()?.width ?? 1280) <= 760;

/** On a phone, selects the builder's pane (the other one is hidden, so out of the accessibility tree). */
async function show(page: Page, pane: "Proposal" | "Cards") {
  if (!isPhone(page)) return;
  await page
    .getByRole("tablist", { name: "Proposal builder" })
    .getByRole("tab", {
      name: pane === "Cards" ? "Cards" : /^Proposal/,
      exact: pane === "Cards",
    })
    .click();
}

/** A fresh pair with unambiguous one-card needs, opened only through real UI entry points. */
async function draftPair(
  page: Page,
  signInOther: () => Promise<{ page: Page }>
) {
  const ids = seedCatalog();
  const other = await signInOther();
  const handle = await nameCollector(other.page, "Misty W");
  await hold(
    other.page,
    await forTradeBinder(other.page, "Misty Binder"),
    ids["PAL 185"],
    3
  );
  await signInAsOwner(page, "/collection");
  await nameCollector(page, "Ash K");
  await hold(page, await forTradeBinder(page, "Ash Binder"), ids["SVI 166"], 3);
  await befriend(other.page, page);
  return { ids, other, handle };
}

async function leaveForCollection(page: Page) {
  await page
    .getByRole("navigation", { name: "Main views" })
    .getByRole("link", { name: "Collection", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page).toHaveURL(`${ORIGIN}/collection`);
}

for (const phone of [false, true]) {
  test.describe(phone ? "phone" : "desktop", () => {
    const options = {
      viewport: phone
        ? { width: 375, height: 812 }
        : { width: 1280, height: 800 },
      isMobile: phone,
      hasTouch: phone,
    };
    test.use(options);
    test("message precedes the reachable Send action", async ({
      page,
      collectors,
    }) => {
      const { other } = await draftPair(page, () =>
        collectors.signIn({ contextOptions: options })
      );
      await page.goto(`${ORIGIN}/trades/new/${await traderIdOf(other.page)}`);
      await page
        .getByRole("button", { name: /^Add to You get, Iono, PAL 185,/ })
        .click();
      await show(page, "Proposal");
      const message = page.getByRole("textbox", { name: "Message (optional)" });
      const send = page.getByRole("button", {
        name: "Send Trade Proposal",
        exact: true,
      });
      await expect(send).toBeEnabled();
      await message.scrollIntoViewIfNeeded();
      await expect
        .poll(async () => {
          const field = await message.boundingBox();
          const action = await send.boundingBox();
          return (
            field !== null &&
            action !== null &&
            field.y + field.height <= action.y
          );
        })
        .toBe(true);
      await message.focus();
      await page.keyboard.press("Tab");
      await expect(send).toBeFocused();
      await expect(send).toBeInViewport();
      // Focusing each control must scroll it clear of the fixed phone navigation.
      for (const control of [message, send]) {
        await control.focus();
        await expect(control).toBeInViewport();
        await expect
          .poll(() =>
            control.evaluate((element, phone) => {
              const box = element.getBoundingClientRect();
              const nav = [
                ...document.querySelectorAll('nav[aria-label="Main views"]'),
              ]
                .map((element) => element.getBoundingClientRect())
                .find((box) => box.width > 0 && box.height > 0);
              const bottom = phone && nav ? nav.top : window.innerHeight;
              return (
                box.top >= 0 &&
                box.bottom <= bottom &&
                element.contains(
                  document.elementFromPoint(
                    box.x + box.width / 2,
                    box.y + box.height / 2
                  )
                )
              );
            }, phone)
          )
          .toBe(true);
      }
    });
    for (const seed of ["", "Opening message"]) {
      test(`message changes and revert from ${JSON.stringify(seed)}`, async ({
        page,
        collectors,
      }) => {
        const { other } = await draftPair(page, () =>
          collectors.signIn({ contextOptions: options })
        );
        const url = `${ORIGIN}/trades/new/${await traderIdOf(other.page)}`;
        await page.goto(`${url}?draft=${encodeURIComponent(seed)}`);
        await expect(heading(page)).toHaveText("Trade Proposal to Misty W");
        await show(page, "Proposal");
        const message = page.getByRole("textbox", {
          name: "Message (optional)",
        });
        await expect(message).toHaveValue(seed);
        const leave = () =>
          page
            .getByRole("navigation", { name: "Main views" })
            .getByRole("link", { name: "Collection", exact: true })
            .click();
        const dialog = page.getByRole("dialog", {
          name: "Discard this proposal to Misty W?",
        });
        // An untouched seed is clean, and is not persisted.
        await leaveForCollection(page);
        await page.goto(`${url}?draft=${encodeURIComponent(seed)}`);
        await show(page, "Proposal");
        const edited = seed ? "" : "A message with trailing space ";
        await message.fill(edited);
        await leave();
        await expect(dialog).toBeVisible();
        await dialog.getByRole("button", { name: "Keep editing" }).click();
        await expect(message).toHaveValue(edited);
        const warning = page.waitForEvent("dialog");
        void page.reload().catch(() => {});
        const native = await warning;
        expect(native.type()).toBe("beforeunload");
        await native.dismiss();
        await expect(message).toHaveValue(edited);
        await message.fill(seed);
        await leaveForCollection(page);
        await page.goto(`${url}?draft=${encodeURIComponent(seed)}`);
        await show(page, "Proposal");
        await message.fill(edited);
        await message.fill(seed);
        await page.getByRole("radio", { name: "You pay", exact: true }).click();
        await leave();
        await expect(dialog).toBeVisible();
        await dialog.getByRole("button", { name: "Keep editing" }).click();
        await page.getByRole("radio", { name: "No cash", exact: true }).click();
        await message.fill(edited);
        await leave();
        await dialog
          .getByRole("button", { name: "Discard", exact: true })
          .click();
        await expect(page).toHaveURL(`${ORIGIN}/collection`);
        await page.goto(url);
        await show(page, "Proposal");
        await expect(message).toHaveValue("");
      });
    }
  });
}
