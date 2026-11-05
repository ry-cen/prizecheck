import type { Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { expect, test } from "./support/collectors";
import {
  accountId,
  api,
  befriend,
  hold,
  lendHandedOver,
  loanView,
  loanItems,
  loanStep,
  nameCollector,
  ORIGIN,
  seedCatalog,
  unsorted,
} from "./support/loans";
import { signInAsOwner } from "./support/sign-in";

test.use({ viewport: { width: 1280, height: 800 } });
const composer = (page: Page) =>
  page.getByRole("dialog", { name: "Borrow Request to Misty W" });
async function draft(page: Page, lender: Page, edition: string) {
  const account = await accountId(page),
    friend = await accountId(lender);
  await page.evaluate(
    ({ account, friend, edition }) => {
      sessionStorage.setItem(
        "prizecheck.borrowDrafts." + account,
        JSON.stringify([
          {
            friend: {
              collector_id: friend,
              display_name: "Misty W",
              handle: null,
            },
            lines: [
              {
                edition_id: edition,
                name: "Iono",
                set_code: "PAL",
                collector_number: "185",
                descriptor: {},
                image_url: null,
                quantity: 1,
                cap: 3,
                lendable: "",
              },
            ],
            deckId: null,
            returnBy: "",
            replaces: null,
          },
        ])
      );
    },
    { account, friend, edition }
  );
  await page.reload();
  await page
    .getByRole("button", { name: "Review Borrow Request to Misty W" })
    .click();
  return composer(page);
}
async function openOffer(page: Page, select = true) {
  if (select) {
    await page.goto(`${ORIGIN}/`);
    await page
      .getByRole("region", { name: "Cards", exact: true })
      .getByRole("button", { name: /Iono/ })
      .first()
      .click();
  }
  const bar = page.getByRole("region", { name: "Selection" });
  await bar.getByRole("button", { name: "Actions", exact: true }).click();
  await bar.getByRole("button", { name: "Lend to a Friend…" }).click();
  return page.getByRole("dialog", { name: "Lend to a Friend", exact: true });
}
async function lostPost(page: Page, path: string, commit: boolean) {
  await page.route(
    `${ORIGIN}${path}`,
    async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      if (commit) await route.fetch();
      await route.abort();
    },
    { times: 1 }
  );
}

test("a lost Borrow Request answer is sent again once", async ({
  page,
  collectors,
}) => {
  // slow (process): two real collector contexts and a catalog import.
  test.slow();
  const ids = seedCatalog(),
    other = await collectors.signIn({ next: "/loans" }),
    lender = other.page;
  await nameCollector(lender, "Misty W");
  await hold(lender, await unsorted(lender), ids["PAL 185"], 3);
  await signInAsOwner(page, "/loans");
  await nameCollector(page, "Ash K");
  await befriend(page, lender);
  const form = await draft(page, lender, ids["PAL 185"]);
  await lostPost(page, "/api/loans", true);
  await form.getByRole("button", { name: "Send Borrow Request" }).click();
  await expect(form).toContainText(
    "Your Borrow Request may not have been sent."
  );
  await form.getByRole("button", { name: "Send it again" }).click();
  await expect(
    page.getByRole("region", { name: "Notifications" })
  ).toContainText("It was sent.");
  const loans = await loanItems(lender);
  expect(loans).toHaveLength(1);
});

test("Don't send it after an unsent Lend Offer ends the offer and frees the form", async ({
  page,
  collectors,
}) => {
  // slow (process): two real collector contexts and a catalog import.
  test.slow();
  const ids = seedCatalog(),
    other = await collectors.signIn({ next: "/loans" });
  await nameCollector(other.page, "Ash K");
  await signInAsOwner(page, "/");
  await nameCollector(page, "Misty W");
  await befriend(page, other.page);
  await hold(page, await unsorted(page), ids["PAL 185"], 1);
  const form = await openOffer(page);
  await form
    .getByRole("combobox", { name: "Friend" })
    .selectOption({ label: "Ash K" });
  await lostPost(page, "/api/loans/offers", false);
  await form.getByRole("button", { name: "Send offer of 1 card" }).click();
  await form.getByRole("button", { name: "Don't send it" }).click();
  await expect(form).toContainText("It wasn't sent.");
  await expect(form.getByRole("combobox", { name: "Friend" })).toBeEnabled();
  await form.getByRole("button", { name: "Send offer of 1 card" }).click();
  await expect(form).toContainText("Offer sent to Ash K.");
  const loans = await loanItems(other.page);
  expect(loans).toHaveLength(1);
});

test("a Lend Offer confirmed from a reopened notice refreshes the Collection", async ({
  page,
  collectors,
}) => {
  // slow (process): two real collector contexts and a catalog import.
  test.slow();
  const ids = seedCatalog(),
    other = await collectors.signIn({ next: "/loans" });
  await nameCollector(other.page, "Ash K");
  await signInAsOwner(page, "/");
  await nameCollector(page, "Misty W");
  await befriend(page, other.page);
  const location = await unsorted(page);
  await hold(page, location, ids["PAL 185"], 1);
  let form = await openOffer(page);
  await form
    .getByRole("combobox", { name: "Friend" })
    .selectOption({ label: "Ash K" });
  await lostPost(page, "/api/loans/offers", true);
  await form.getByRole("button", { name: "Send offer of 1 card" }).click();
  await expect(form).toContainText("Your Lend Offer may not have been sent.");
  await form.getByRole("button", { name: "Close Lend to a Friend" }).click();
  form = await openOffer(page, false);
  await hold(page, location, ids["PAL 172"], 1);
  const tree = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === "/api/location-tree" &&
      r.request().method() === "GET"
  );
  await form.getByRole("button", { name: "Send it again" }).click();
  await expect(form).toContainText("It was sent.");
  await tree;
  await form.getByRole("button", { name: "Close Lend to a Friend" }).click();
  const cards = page.getByRole("region", { name: "Cards", exact: true });
  await expect(
    cards.getByRole("button", { name: /Boss's Orders/ })
  ).toBeVisible();
  await expect(
    cards.getByRole("button", { name: /Iono/ }).first()
  ).toHaveAttribute("aria-pressed", "true");
});

test("a lost start return is checked after a reload, not started twice", async ({
  page,
  collectors,
}) => {
  // slow (process): two real collector contexts and a catalog import.
  test.slow();
  const ids = seedCatalog(),
    other = await collectors.signIn({ next: "/loans" }),
    lender = other.page;
  await nameCollector(lender, "Misty W");
  await hold(lender, await unsorted(lender), ids["PAL 185"], 3);
  await signInAsOwner(page, "/loans");
  await nameCollector(page, "Ash K");
  await befriend(page, lender);
  const round = await lendHandedOver(lender, page, [[ids["PAL 185"], 3]]);
  const id = (await loanView(page, round)).thread_id;
  await page.goto(`${ORIGIN}/loans/${id}`);
  await page.getByRole("button", { name: "Some back" }).click();
  await lostPost(page, `/api/loans/${id}/returns`, true);
  await page.getByRole("button", { name: "Give these back" }).click();
  await expect(page.getByRole("main")).toContainText(
    "Your return may not have been started."
  );
  await page.reload();
  await expect(
    page.getByRole("group", { name: "Loan terms and actions" })
  ).toBeDisabled();
  await page.getByRole("button", { name: "Send it again" }).click();
  await expect(page.getByRole("main")).toContainText("It was sent.");
  const loan = await loanView(page, id);
  expect(loan.pending_return?.lines).toHaveLength(1);
  expect(loan.pending_return?.lines[0].copies).toBe("3");
});

test("a lost write-off is confirmed with Check again", async ({
  page,
  collectors,
}) => {
  // slow (process): two real collector contexts and a catalog import.
  test.slow();
  const ids = seedCatalog(),
    other = await collectors.signIn({ next: "/loans" }),
    lender = other.page;
  await nameCollector(lender, "Misty W");
  await hold(lender, await unsorted(lender), ids["PAL 185"], 3);
  await signInAsOwner(page, "/loans");
  await nameCollector(page, "Ash K");
  await befriend(page, lender);
  const round = await lendHandedOver(lender, page, [[ids["PAL 185"], 3]]);
  const id = (await loanView(page, round)).thread_id;
  await lender.goto(`${ORIGIN}/loans/${id}`);
  await lender.getByRole("button", { name: "More for this Loan" }).click();
  await lender.getByRole("menuitem", { name: "Write off…" }).click();
  await lender
    .getByRole("group", { name: /^Copies of Iono, .* to write off$/ })
    .getByRole("button", { name: /^Increase/ })
    .click();
  await lostPost(lender, `/api/loans/${id}/write-off`, true);
  await lender.getByRole("button", { name: "Write off", exact: true }).click();
  await expect(lender.getByRole("main")).toContainText(
    "Your Write-off may not have been saved."
  );
  await lender.reload();
  await expect(
    lender.getByRole("button", { name: "More for this Loan" })
  ).toHaveCount(0);
  await expect(
    lender.getByRole("group", { name: "Loan terms and actions" })
  ).toBeDisabled();
  await lender.route(
    `${ORIGIN}/api/loans/command-keys/void`,
    (route) => route.fulfill({ status: 503, json: {} }),
    { times: 1 }
  );
  await lender.getByRole("button", { name: "Send it again" }).click();
  await expect(
    lender.getByRole("button", { name: "Check again" })
  ).toBeVisible();
  await lender.getByRole("button", { name: "Check again" }).click();
  await expect(lender.getByRole("main")).toContainText("It was sent.");
  const loan = await loanView(lender, id);
  expect(loan.lines[0].written_off).toBe("1");
});

test("sign-out deletes the request details and keeps the note", async ({
  page,
  collectors,
}) => {
  // slow (process): two real collector contexts and a catalog import.
  test.slow();
  const ids = seedCatalog(),
    other = await collectors.signIn({ next: "/loans" }),
    lender = other.page;
  await nameCollector(lender, "Misty W");
  await hold(lender, await unsorted(lender), ids["PAL 185"], 3);
  await signInAsOwner(page, "/loans");
  await nameCollector(page, "Ash K");
  await befriend(page, lender);
  const form = await draft(page, lender, ids["PAL 185"]);
  await lostPost(page, "/api/loans", true);
  await form.getByRole("button", { name: "Send Borrow Request" }).click();
  await expect(form).toContainText(
    "Your Borrow Request may not have been sent."
  );
  await form.getByRole("button", { name: "Keep draft" }).click();
  await page.getByRole("button", { name: "Account", exact: true }).click();
  await page.getByRole("menuitem", { name: "Sign out", exact: true }).click();
  await expect(
    page.getByRole("link", { name: "Continue with Google" })
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() =>
        Object.keys(localStorage).some((k) =>
          k.startsWith("prizecheck:loan-intent:v2:")
        )
      )
    )
    .toBe(true);
  await expect
    .poll(() =>
      page.evaluate(() =>
        Object.keys(localStorage).filter((k) =>
          k.startsWith("prizecheck:loan-body:v2:")
        )
      )
    )
    .toEqual([]);
});

// Terms checks never create a durable intent. Both reads use the thread resolver.
const terms = (page: Page) =>
  page.getByRole("dialog", { name: "Change Loan terms" });
const checkFailed =
  "The Loan could not be checked. Your changes are kept. Retry the check.";
const changed =
  "This Loan changed. Close this editor to view the current terms.";
async function requestFixture(
  page: Page,
  collectors: { signIn(options: { next: string }): Promise<{ page: Page }> }
) {
  const ids = seedCatalog();
  const { page: lender } = await collectors.signIn({ next: "/loans" });
  await nameCollector(lender, "Misty W");
  await hold(lender, await unsorted(lender), ids["PAL 185"], 3);
  await signInAsOwner(page, "/loans");
  await nameCollector(page, "Ash K");
  await befriend(page, lender);
  return { ids, lender };
}
async function gateFixture(
  page: Page,
  collectors: Parameters<typeof requestFixture>[1]
) {
  const { ids, lender } = await requestFixture(page, collectors);
  const loan = await api(page, "POST", "/api/loans", {
    lender_id: await accountId(lender),
    lines: [{ edition_id: ids["PAL 185"], quantity: "1" }],
    deck_id: null,
    return_by: null,
    idempotency_key: randomUUID(),
  });
  const id: string = loan.thread_id;
  await page.goto(`${ORIGIN}/loans/${id}`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "More for this Loan" })
  ).toBeVisible();
  const sends: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname === `/api/loans/${id}/terms`
    )
      sends.push(request.postData() ?? "");
  });
  return { lender, id, sends };
}
async function openTerms(page: Page) {
  await page.getByRole("button", { name: "More for this Loan" }).click();
  await page.getByRole("menuitem", { name: "Change terms" }).click();
  return terms(page);
}
async function failRead(page: Page, id: string, failure: string) {
  const url = `${ORIGIN}/api/loans/resolve/${id}`;
  if (failure === "abort") {
    await page.evaluate((url) => {
      const original = window.fetch;
      window.fetch = (input, init) => {
        const target =
          input instanceof Request
            ? input.url
            : new URL(String(input), location.href).href;
        return target === url
          ? Promise.reject(new DOMException("x", "AbortError"))
          : original(input, init);
      };
      Object.assign(window, {
        restoreLoanRead: () => {
          window.fetch = original;
        },
      });
    }, url);
    return async () => {
      await page.evaluate(() => {
        Reflect.get(window, "restoreLoanRead")();
      });
    };
  }
  await page.route(url, (route) =>
    failure === "network"
      ? route.abort()
      : route.fulfill({
          status: Number(failure),
          json: { detail: { code: "X" } },
        })
  );
  return async () => {
    await page.unroute(url);
  };
}
async function noIntent(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() =>
        Object.keys(localStorage).filter((key) =>
          key.startsWith("prizecheck:loan-intent:v2:")
        )
      )
    )
    .toEqual([]);
}

test("a Terms edit whose Loan was declined is blocked at Save and makes no POST", async ({
  page,
  collectors,
}) => {
  // slow (process): two real collectors and catalog import.
  test.slow();
  const f = await gateFixture(page, collectors);
  const form = await openTerms(page);
  await expect(form.getByRole("button", { name: "Save terms" })).toBeEnabled();
  await form.getByRole("spinbutton", { name: "Iono", exact: true }).fill("2");
  await loanStep(f.lender, f.id, "decline");
  await form.getByRole("button", { name: "Save terms" }).click();
  await expect(form).toContainText(changed);
  await expect(form.getByRole("button", { name: "Save terms" })).toBeDisabled();
  expect(f.sends).toEqual([]);
  await noIntent(page);
});
for (const failure of ["503", "401", "403", "network", "abort"]) {
  test(`a failed open check shows Retry check, keeps the changes, and Retry allows Save (${failure})`, async ({
    page,
    collectors,
  }) => {
    // slow (process): two real collectors and catalog import.
    test.slow();
    const f = await gateFixture(page, collectors);
    const restore = await failRead(page, f.id, failure);
    const form = await openTerms(page);
    await expect(form).toContainText(checkFailed);
    await expect(
      form.getByRole("button", { name: "Save terms" })
    ).toBeDisabled();
    await form.getByRole("spinbutton", { name: "Iono", exact: true }).fill("2");
    expect(f.sends).toEqual([]);
    await noIntent(page);
    await restore();
    await form.getByRole("button", { name: "Retry check" }).click();
    await expect(
      form.getByRole("button", { name: "Save terms" })
    ).toBeEnabled();
    await expect(
      form.getByRole("spinbutton", { name: "Iono", exact: true })
    ).toHaveValue("2");
    await form.getByRole("button", { name: "Save terms" }).click();
    await expect(form).toHaveCount(0);
    expect(f.sends).toHaveLength(1);
    expect(JSON.parse(f.sends[0]).lines[0].quantity).toBe("2");
    expect(JSON.parse(f.sends[0]).account_id).toBe(await accountId(page));
    await noIntent(page);
  });
}
test("an unreadable account binding fails the check closed until it is readable again", async ({
  page,
  collectors,
}) => {
  // slow (process): two real collectors and catalog import.
  test.slow();
  const f = await gateFixture(page, collectors);
  const key =
    "prizecheck:loan-epoch:v2:" + encodeURIComponent(await accountId(page));
  await page.evaluate((key) => localStorage.setItem(key, "x"), key);
  const form = await openTerms(page);
  await expect(form).toContainText(checkFailed);
  await expect(form.getByRole("button", { name: "Save terms" })).toBeDisabled();
  expect(f.sends).toEqual([]);
  await page.evaluate((key) => localStorage.setItem(key, "0"), key);
  await form.getByRole("button", { name: "Retry check" }).click();
  await expect(form.getByRole("button", { name: "Save terms" })).toBeEnabled();
  await noIntent(page);
});
for (const failure of ["401", "403"]) {
  test(`a failed pre-Save check keeps Save disabled and makes no POST (${failure})`, async ({
    page,
    collectors,
  }) => {
    // slow (process): two real collectors and catalog import.
    test.slow();
    const f = await gateFixture(page, collectors);
    const form = await openTerms(page);
    await expect(
      form.getByRole("button", { name: "Save terms" })
    ).toBeEnabled();
    await form.getByRole("spinbutton", { name: "Iono", exact: true }).fill("2");
    const restore = await failRead(page, f.id, failure);
    await form.getByRole("button", { name: "Save terms" }).click();
    await expect(form).toContainText(checkFailed);
    await expect(
      form.getByRole("button", { name: "Save terms" })
    ).toBeDisabled();
    await expect(
      form.getByRole("spinbutton", { name: "Iono", exact: true })
    ).toHaveValue("2");
    expect(f.sends).toEqual([]);
    await noIntent(page);
    await restore();
    await form.getByRole("button", { name: "Retry check" }).click();
    await expect(
      form.getByRole("button", { name: "Save terms" })
    ).toBeEnabled();
  });
}
test("a change between opening and Save is caught and makes no POST", async ({
  page,
  collectors,
}) => {
  // slow (process): two real collectors and catalog import.
  test.slow();
  const f = await gateFixture(page, collectors);
  const form = await openTerms(page);
  await expect(form.getByRole("button", { name: "Save terms" })).toBeEnabled();
  await form.getByRole("spinbutton", { name: "Iono", exact: true }).fill("2");
  await loanStep(f.lender, f.id, "decline");
  await form.getByRole("button", { name: "Save terms" }).click();
  await expect(form).toContainText(changed);
  await expect(
    form.getByRole("spinbutton", { name: "Iono", exact: true })
  ).toHaveValue("2");
  expect(f.sends).toEqual([]);
  await noIntent(page);
});
test("a check error is shown alongside a cached change", async ({
  page,
  collectors,
}) => {
  // slow (process): two real collectors and catalog import.
  test.slow();
  const f = await gateFixture(page, collectors);
  const form = await openTerms(page);
  await expect(form.getByRole("button", { name: "Save terms" })).toBeEnabled();
  await loanStep(f.lender, f.id, "decline");
  await form.getByRole("button", { name: "Save terms" }).click();
  await expect(form).toContainText(changed);
  // Persist the failure for all reads; background refresh cannot consume a one-shot route.
  const restore = await failRead(page, f.id, "503");
  await form.getByRole("button", { name: "Retry check" }).click();
  await expect(form).toContainText(checkFailed);
  await expect(form).toContainText(changed);
  await expect(form.getByRole("button", { name: "Save terms" })).toBeDisabled();
  expect(f.sends).toEqual([]);
  await noIntent(page);
  await restore();
});

test("a delayed durable POST stays fenced through Close, Escape and Back, and a lost answer then frees leaving", async ({
  page,
  collectors,
}) => {
  // slow (process): two collectors, catalog import and a deliberately held POST.
  test.slow();
  const { lender, ids } = await requestFixture(page, collectors);
  const form = await draft(page, lender, ids["PAL 185"]);
  await form.getByRole("button", { name: "Keep draft" }).click();
  const nav = page.getByRole("navigation", { name: "Main views" });
  await nav.getByRole("button", { name: /^Collection/ }).click();
  await nav.getByRole("button", { name: /^Loans/ }).click();
  await page
    .getByRole("button", { name: "Review Borrow Request to Misty W" })
    .click();
  let release!: () => void, arrived!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const sends: string[] = [];
  await page.route(
    `${ORIGIN}/api/loans`,
    async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      sends.push(route.request().postData() ?? "");
      arrived();
      await held;
      await route.fetch();
      await route.abort();
    },
    { times: 1 }
  );
  await form.getByRole("button", { name: "Send Borrow Request" }).click();
  await started;
  await form.getByRole("button", { name: "Keep draft" }).click();
  await expect(form).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(form).toBeVisible();
  // Exercise the real popstate path while the in-session owner still holds the POST.
  await page.goBack();
  await expect(page).toHaveURL(`${ORIGIN}/loans`);
  await expect(form).toBeVisible();
  await expect(form.getByRole("combobox", { name: "For Deck" })).toBeDisabled();
  expect(sends).toHaveLength(1);
  release();
  await expect(form).toContainText(
    "Your Borrow Request may not have been sent."
  );
  await form.getByRole("button", { name: "Keep draft" }).click();
  await expect(form).toHaveCount(0);
  await nav.getByRole("button", { name: /^Collection/ }).click();
  await expect(page).toHaveURL(`${ORIGIN}/collection`);
  await page
    .getByRole("button", { name: "Review Borrow Request to Misty W" })
    .click();
  await expect(
    composer(page).getByRole("button", { name: "Send Borrow Request" })
  ).toBeDisabled();
  let replay = "";
  await page.route(
    `${ORIGIN}/api/loans`,
    async (route) => {
      replay = route.request().postData() ?? "";
      await route.continue();
    },
    { times: 1 }
  );
  await composer(page).getByRole("button", { name: "Send it again" }).click();
  await expect(composer(page)).toHaveCount(0);
  expect(replay).toBe(sends[0]);
  expect(await loanItems(lender)).toHaveLength(1);
});

test("another tab answers busy while the first holds the scope", async ({
  page,
  collectors,
}) => {
  // slow (process): two collectors and a second page sharing the same real Web Locks manager.
  test.slow();
  const { lender, ids } = await requestFixture(page, collectors);
  const form = await draft(page, lender, ids["PAL 185"]);
  const account = await accountId(page),
    friend = await accountId(lender);
  const other = await page.context().newPage();
  try {
    await other.goto(`${ORIGIN}/loans`);
    const lockName = `prizecheck:loan-scope:${encodeURIComponent(account)}:borrow_request:${friend}`;
    await other.evaluate(async (name) => {
      let acquired!: () => void;
      const ready = new Promise<void>((resolve) => {
        acquired = resolve;
      });
      const held = new Promise<void>((resolve) => {
        Object.assign(window, { releaseLoanLock: resolve });
      });
      void navigator.locks.request(name, async () => {
        acquired();
        await held;
      });
      await ready;
    }, lockName);
    const sends: string[] = [];
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        new URL(request.url()).pathname === "/api/loans"
      )
        sends.push(request.postData() ?? "");
    });
    await form.getByRole("button", { name: "Send Borrow Request" }).click();
    await expect(form).toContainText(
      "This is being checked in another tab. Try again in a moment."
    );
    expect(sends).toEqual([]);
    await noIntent(page);
    await other.evaluate(() => Reflect.get(window, "releaseLoanLock")());
    // A new lock acquisition is an acknowledgement that the first was released.
    await other.evaluate(async (name) => {
      await navigator.locks.request(name, async () => {});
    }, lockName);
    await form.getByRole("button", { name: "Send Borrow Request" }).click();
    await expect(form).toHaveCount(0);
    expect(sends).toHaveLength(1);
  } finally {
    await other.close();
  }
});

test("a session for another account sends nothing and says who to sign in as", async ({
  page,
  collectors,
}) => {
  // slow (process): two collectors and catalog import.
  test.slow();
  const { lender, ids } = await requestFixture(page, collectors);
  const form = await draft(page, lender, ids["PAL 185"]);
  const sends: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/loans"
    )
      sends.push(request.postData() ?? "");
  });
  await page.route(
    `${ORIGIN}/auth/session`,
    (route) =>
      route.fulfill({
        status: 200,
        json: { signedIn: true, userId: "another-account" },
      }),
    { times: 1 }
  );
  await form.getByRole("button", { name: "Send Borrow Request" }).click();
  await expect(form).toContainText("Sign in as Ash K to finish this.");
  expect(sends).toEqual([]);
});

test("a legacy replaces draft cannot be sent", async ({ page, collectors }) => {
  // slow (process): two collectors and catalog import.
  test.slow();
  const f = await gateFixture(page, collectors);
  const view = await loanView(page, f.id);
  await draft(page, f.lender, view.lines[0].edition_id);
  await composer(page).getByRole("button", { name: "Keep draft" }).click();
  const account = await accountId(page);
  await page.evaluate(
    ({ account, id }) => {
      const key = "prizecheck.borrowDrafts." + account;
      const drafts = JSON.parse(sessionStorage.getItem(key) ?? "[]");
      drafts[0].replaces = id;
      sessionStorage.setItem(key, JSON.stringify(drafts));
    },
    { account, id: f.id }
  );
  const sends: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (
      request.method() === "POST" &&
      (path === "/api/loans" || path.endsWith("/terms"))
    )
      sends.push(path);
  });
  await page.reload();
  await page
    .getByRole("button", { name: "Review Borrow Request to Misty W" })
    .click();
  const form = composer(page);
  await expect(form).toContainText(
    "This edit was started before an update. Open the Borrow Request to edit it again."
  );
  await expect(
    form.getByRole("button", { name: "Send Borrow Request" })
  ).toBeDisabled();
  await form.getByRole("button", { name: "View", exact: true }).click();
  await expect(page).toHaveURL(`${ORIGIN}/loans/${f.id}`);
  await page
    .getByRole("button", { name: "Review Borrow Request to Misty W" })
    .click();
  await composer(page)
    .getByRole("button", { name: "Discard", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Review Borrow Request to Misty W" })
  ).toHaveCount(0);
  expect(sends).toEqual([]);
});
