import { traderIdOf } from "./support/conversations";
// Native and app leave guards protect only edits made since the builder opened.
import { execFileSync } from "node:child_process";
import { randomInt, randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { expect, test } from "./support/collectors";
import { expectPageChecks } from "./support/page-check";
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

/** Misty sends Ash a Trade Proposal through the API; returns its id. */
async function propose(
  page: Page,
  to: string,
  give: [string, number][],
  get: [string, number][]
): Promise<string> {
  const line = ([edition_id, n]: [string, number]) => ({
    edition_id,
    quantity: String(n),
  });
  const trade = await api(page, "POST", "/api/trades", {
    recipient_id: to,
    you_give: give.map(line),
    you_get: get.map(line),
    idempotency_key: randomUUID(),
  });
  return trade.thread_id as string;
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

function recordNativeDialogs(page: Page) {
  const dialogs: string[] = [];
  page.on("dialog", (d) => {
    dialogs.push(d.type());
    void d.dismiss();
  });
  return dialogs;
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
    for (const counter of [true, false]) {
      test(`${counter ? "Counter" : "New proposal"}: reverting clears the mounted in-app guard`, async ({
        page,
        collectors,
      }) => {
        const { ids, other, handle } = await draftPair(page, () =>
          collectors.signIn({ contextOptions: options })
        );
        const id = counter
          ? await propose(
              other.page,
              await accountId(page),
              [[ids["PAL 185"], 1]],
              [[ids["SVI 166"], 1]]
            )
          : null;
        await page.goto(
          counter
            ? `${ORIGIN}/trades/${id}`
            : `${ORIGIN}/friends/${handle}/trade-list`
        );
        await page
          .getByRole("button", {
            name: counter ? "Counter" : "Propose trade to Misty W",
            exact: true,
          })
          .click();
        await expect(heading(page)).toHaveText(
          counter ? "Counter to Misty W" : "Trade Proposal to Misty W"
        );
        await show(page, "Proposal");
        const nativeDialogs = recordNativeDialogs(page);
        await page.getByRole("radio", { name: "You pay", exact: true }).click();
        // Prove the mounted guard was armed before reverting the edit.
        await page
          .getByRole("navigation", { name: "Main views" })
          .getByRole("link", { name: "Collection", exact: true })
          .click();
        const dialog = page.getByRole("dialog", {
          name: counter
            ? "Discard this Counter to Misty W?"
            : "Discard this proposal to Misty W?",
        });
        await expect(dialog).toBeVisible();
        await dialog.getByRole("button", { name: "Keep editing" }).click();
        await page.getByRole("radio", { name: "No cash", exact: true }).click();
        await expect(
          page.getByRole("radio", { name: "No cash", exact: true })
        ).toBeChecked();
        // No reload or remount between reverting and this departure.
        await leaveForCollection(page);
        expect(nativeDialogs).toEqual([]);
      });
    }

    for (const departure of ["reload", "in-app"] as const) {
      test(`New proposal: untouched nonempty match prefill leaves on ${departure} without a dialog`, async ({
        page,
        collectors,
      }) => {
        const { ids, other } = await draftPair(page, () =>
          collectors.signIn({ contextOptions: options })
        );
        await api(page, "PUT", `/api/trade-wants/${ids["PAL 185"]}`, {
          quantity: "1",
        });
        await api(other.page, "PUT", `/api/trade-wants/${ids["SVI 166"]}`, {
          quantity: "1",
        });
        await page.goto(`${ORIGIN}/trades/find`);
        await page
          .getByRole("list", { name: "Matches" })
          .getByRole("button", { name: /^Misty W/ })
          .click();
        await page
          .getByRole("button", {
            name: "Propose trade to Misty W",
            exact: true,
          })
          .click();
        await expect(heading(page)).toHaveText("Trade Proposal to Misty W");
        await show(page, "Proposal");
        for (const name of [
          "Iono (PAL 185) you get",
          "Arven (SVI 166) you give",
        ]) {
          await expect(
            page
              .getByRole("group", { name, exact: true })
              .getByText("1", { exact: true })
          ).toHaveText("1");
        }
        const nativeDialogs = recordNativeDialogs(page);
        if (departure === "reload") {
          await page.reload();
          await expect(heading(page)).toHaveText("Trade Proposal to Misty W");
          await show(page, "Proposal");
          // The opening seed is memory-only: a document reload opens an empty draft.
          await expect(
            page.getByRole("group", {
              name: "Iono (PAL 185) you get",
              exact: true,
            })
          ).toHaveCount(0);
          await expect(
            page.getByRole("group", {
              name: "Arven (SVI 166) you give",
              exact: true,
            })
          ).toHaveCount(0);
        } else {
          await leaveForCollection(page);
        }
        await expect(page.getByRole("dialog")).toHaveCount(0);
        expect(nativeDialogs).toEqual([]);
      });
    }

    for (const counter of [true, false]) {
      const mode = counter ? "Counter" : "New proposal";
      for (const action of [
        "reload",
        "document",
        "shell",
        "back link",
        "browser Back",
        "unchanged",
        "reverted",
      ]) {
        test(`${mode}: ${action} protects only unsent edits`, async ({
          page,
          collectors,
        }) => {
          const ids = seedCatalog();
          const other = await collectors.signIn({ contextOptions: options });
          const handle = await nameCollector(other.page, "Misty W");
          await hold(
            other.page,
            await forTradeBinder(other.page, "Misty Binder"),
            ids["PAL 185"],
            3
          );
          await signInAsOwner(page, "/collection");
          await nameCollector(page, "Ash K");
          await hold(
            page,
            await forTradeBinder(page, "Ash Binder"),
            ids["SVI 166"],
            3
          );
          await befriend(other.page, page);
          const id = await propose(
            other.page,
            await accountId(page),
            [[ids["PAL 185"], 1]],
            [[ids["SVI 166"], 1]]
          );
          const target = counter
            ? `${ORIGIN}/trades/${id}`
            : `${ORIGIN}/friends/${handle}/trade-list`;
          const url = counter
            ? `${ORIGIN}/trades/${id}/counter`
            : `${ORIGIN}/trades/new/${await traderIdOf(other.page)}`;
          await page.goto(target);
          await page
            .getByRole("button", {
              name: counter ? "Counter" : "Propose trade to Misty W",
              exact: true,
            })
            .click();
          await expect(heading(page)).toHaveText(
            counter ? "Counter to Misty W" : "Trade Proposal to Misty W"
          );
          const edit = async () => {
            await show(page, "Proposal");
            await page
              .getByRole("radio", { name: "You pay", exact: true })
              .click();
          };
          if (action !== "unchanged") await edit();
          if (action === "reverted")
            await page
              .getByRole("radio", { name: "No cash", exact: true })
              .click();
          if (action === "reload" || action === "document") {
            for (const stay of [true, false]) {
              const warning = page.waitForEvent("dialog");
              const navigation = (
                action === "reload"
                  ? page.reload()
                  : page.goto(`${ORIGIN}/collection`)
              ).catch((e) => e);
              const prompt = await warning;
              expect(prompt.type()).toBe("beforeunload");
              if (stay) await prompt.dismiss();
              else await prompt.accept();
              const result =
                action === "reload" && stay ? null : await navigation;
              if (stay) {
                if (action === "document") expect(result).toBeInstanceOf(Error);
                await expect(page).toHaveURL(url);
                if (counter)
                  await expect(
                    page.getByRole("region", { name: "Proposed changes" })
                  ).toContainText("Complete the cash amount before sending.");
                await expect(
                  page.getByRole("radio", { name: "You pay", exact: true })
                ).toBeChecked();
              } else if (action === "reload") {
                await show(page, "Proposal");
                await expect(
                  page.getByRole("radio", { name: "No cash", exact: true })
                ).toBeChecked();
                if (counter)
                  await expect(
                    page.getByRole("region", { name: "Proposed changes" })
                  ).toContainText("No changes yet.");
              } else await expect(page).toHaveURL(`${ORIGIN}/collection`);
            }
          } else {
            const nativeDialogs: string[] = [];
            page.on("dialog", (d) => {
              nativeDialogs.push(d.type());
              void d.dismiss();
            });
            if (action === "unchanged" || action === "reverted") {
              await page.reload();
              await expect(heading(page)).toBeVisible();
              await page
                .getByRole("navigation", { name: "Main views" })
                .getByRole("link", { name: "Collection", exact: true })
                .click();
              await expect(page).toHaveURL(`${ORIGIN}/collection`);
              await expect(page.getByRole("dialog")).toHaveCount(0);
            } else {
              const leave = async () => {
                if (action === "shell")
                  await page
                    .getByRole("navigation", { name: "Main views" })
                    .getByRole("link", { name: "Collection", exact: true })
                    .click();
                else if (action === "back link")
                  await page
                    .getByRole("link", {
                      name: counter
                        ? "Misty W's Trade Proposal"
                        : "Misty W's Trade List",
                      exact: true,
                    })
                    .click();
                else await page.goBack();
              };
              await leave();
              const dialog = page.getByRole("dialog", {
                name: counter
                  ? "Discard this Counter to Misty W?"
                  : "Discard this proposal to Misty W?",
              });
              await expect(dialog).toBeVisible();
              await expect(dialog).toContainText(
                counter
                  ? "Your unsent changes will be discarded. Misty W's Trade Proposal stays as it was."
                  : "Your unsent changes will be discarded."
              );
              await dialog
                .getByRole("button", { name: "Keep editing" })
                .click();
              await expect(page).toHaveURL(url);
              await expect(
                page.getByRole("radio", { name: "You pay", exact: true })
              ).toBeChecked();
              await leave();
              await dialog
                .getByRole("button", { name: "Discard", exact: true })
                .click();
              await expect(page).not.toHaveURL(url);
            }
            expect(nativeDialogs).toEqual([]);
          }
        });
      }
    }
  });
}
