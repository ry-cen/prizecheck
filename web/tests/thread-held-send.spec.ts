import type { Page, Route } from "@playwright/test";
import { expect, test } from "./support/collectors";
import {
  ORIGIN,
  accountId,
  befriend,
  hold,
  nameCollector,
  seedCatalog,
} from "./support/loans";
import { forTradeLeaf, propose } from "./support/trades";
import { signInAsOwner } from "./support/sign-in";

/** TradeScreen resolves its two offer reads; chat reads detail directly with a
 * separate AbortSignal. Tag only those resolved offer reads so the fixture holds
 * the permission owner, while all parent refresh I/O still runs normally. */
async function identifyOfferReads(
  page: import("@playwright/test").Page,
  id: string
) {
  await page.addInitScript((thread) => {
    const original = window.fetch.bind(window);
    const offerSignals = new WeakSet<AbortSignal>();
    let permissionRead = 0;
    Object.defineProperty(window, "__prizecheckPermissionRead", {
      get: () => permissionRead,
    });
    window.fetch = (input, init) => {
      const path = new URL(
        input instanceof Request ? input.url : String(input),
        location.href
      ).pathname;
      if (path === `/api/trades/resolve/${thread}` && init?.signal)
        offerSignals.add(init.signal);
      if (path === `/api/trades/${thread}` && init?.signal) {
        const headers = new Headers(init.headers);
        if (offerSignals.has(init.signal))
          headers.set("x-prizecheck-test-reader", "offer");
        else
          headers.set(
            "x-prizecheck-test-permission-read",
            String(++permissionRead)
          );
        init = { ...init, headers };
      }
      return original(input, init);
    };
  }, id);
}

type PermissionOutcome = "writable" | "read-only" | "failed";
type HeldRead = {
  route: Route;
  sequence: number;
  settled?: Promise<void>;
  outcome?: PermissionOutcome;
  delivered?: boolean;
};
const holdCleanups = new WeakMap<Page, Set<() => Promise<void>>>();

/** Snapshot before interception; route arrival does no backend/body I/O. Source
 * sequence numbers distinguish an obsolete request even if it arrives late. */
async function holdDetailReads(page: Page, id: string) {
  const response = await page.request.get(`${ORIGIN}/api/trades/${id}`);
  expect(response.ok()).toBe(true);
  const body: Record<string, unknown> = await response.json();
  await response.dispose();
  const reads: HeldRead[] = [];
  let closing = false;
  let cleanupPromise: Promise<void> | undefined;
  let obsoleteThrough = 0;
  let outcomeFrom = Infinity;
  let policy: PermissionOutcome | undefined;
  const pattern = `**/api/trades/${id}`;

  function settle(read: HeldRead, outcome?: PermissionOutcome): Promise<void> {
    if (read.settled) return read.settled;
    read.outcome = outcome;
    read.settled = (async () => {
      try {
        // Teardown aborts; it must never grant permission to a held send.
        if (outcome === undefined || outcome === "failed")
          await read.route.abort("failed");
        else
          await read.route.fulfill({
            json: { ...body, can_message: outcome === "writable" },
          });
        const failure = read.route.request().failure();
        read.delivered =
          !failure ||
          (outcome === "failed" && failure.errorText.includes("ERR_FAILED"));
      } catch (error) {
        // Navigation/teardown can settle a route without an ABORTED failure on
        // its Request. Only teardown may tolerate Playwright's handled state;
        // a failed outcome delivery in the test body must still fail the test.
        if (
          outcome === undefined &&
          error instanceof Error &&
          /(?:^|: )Route is already handled!$/.test(error.message)
        ) {
          read.delivered = false;
          return;
        }
        // Real supersession/departure aborts older requests. A current request's
        // failure must not be treated as delivery; assertLatestOutcome checks it.
        if (!read.route.request().failure()?.errorText.includes("ABORTED"))
          throw error;
        read.delivered = false;
      }
    })();
    return read.settled;
  }
  const handler = (route: Route) => {
    if (
      route.request().method() !== "GET" ||
      route.request().headers()["x-prizecheck-test-reader"] === "offer"
    )
      return route.continue();
    const sequence = Number(
      route.request().headers()["x-prizecheck-test-permission-read"]
    );
    const read: HeldRead = { route, sequence };
    reads.push(read);
    expect(sequence).toBeGreaterThan(0);
    if (closing) return settle(read);
    if (policy && sequence >= outcomeFrom) return settle(read, policy);
    if (sequence <= obsoleteThrough) return settle(read, "writable");
  };
  function cleanup(): Promise<void> {
    if (cleanupPromise) return cleanupPromise;
    closing = true;
    cleanupPromise = (async () => {
      // Abort before removing interception: Playwright 1.63 forwards in-flight
      // routes when the last interceptor is removed. Forwarding an unanswered
      // permission read could grant a held send and makes a later abort fail.
      // New callbacks see closing and abort; collect their settlements as well.
      const results: PromiseSettledResult<void>[] = [];
      let drained = 0;
      while (drained < reads.length) {
        const batch = reads.slice(drained);
        drained = reads.length;
        results.push(
          ...(await Promise.allSettled(batch.map((read) => settle(read))))
        );
      }
      const failure = results.find((result) => result.status === "rejected");
      // If an abort failed for a real reason, retain the abort-only interceptor
      // until context teardown rather than forwarding its unanswered request.
      if (failure?.status === "rejected") throw failure.reason;
      await page.unroute(pattern, handler);
    })();
    return cleanupPromise;
  }
  const cleanups = holdCleanups.get(page) ?? new Set<() => Promise<void>>();
  holdCleanups.set(page, cleanups);
  cleanups.add(cleanup); // Registered before interception, including timeout paths.
  await page.route(pattern, handler);
  const startedSequence = () =>
    page.evaluate(() =>
      Number(Reflect.get(window, "__prizecheckPermissionRead"))
    );
  return {
    cleanup,
    startedSequence,
    async waitForNewer(sequence = 0) {
      await expect
        .poll(() => Math.max(0, ...reads.map((read) => read.sequence)))
        .toBeGreaterThan(sequence);
      return reads.reduce((latest, read) =>
        read.sequence > latest.sequence ? read : latest
      );
    },
    async releaseObsolete(before: number) {
      obsoleteThrough = before - 1;
      await Promise.all(
        reads
          .filter((read) => read.sequence <= obsoleteThrough)
          .map((read) => settle(read, "writable"))
      );
    },
    async settleNewest(outcome: PermissionOutcome, from = 1) {
      outcomeFrom = from;
      policy = outcome;
      // Deliberately include the actual newest owner and every superseding read.
      // Keep this policy installed through the terminal assertions, for every
      // outcome. No later real-backend writable read can substitute for it.
      await Promise.all(
        reads
          .filter((read) => read.sequence >= outcomeFrom)
          .map((read) => settle(read, outcome))
      );
    },
    async assertLatestOutcome(outcome: PermissionOutcome) {
      await expect
        .poll(async () => {
          const sequence = await startedSequence();
          const latest = reads.find((read) => read.sequence === sequence);
          return { outcome: latest?.outcome, delivered: latest?.delivered };
        })
        .toEqual({ outcome, delivered: true });
    },
  };
}

test.afterEach(async ({ page }, info) => {
  const results = await Promise.allSettled(
    [...(holdCleanups.get(page) ?? [])].map((cleanup) => cleanup())
  );
  holdCleanups.delete(page);
  // On failure, do not wait on unrelated callbacks or replace the first error.
  const failed = info.status !== info.expectedStatus;
  // A failed abort leaves the closing interceptor installed until the page's
  // fixture closes its context; removing it here could resume that request.
  const cleanupFailed = results.some((result) => result.status === "rejected");
  const removal = cleanupFailed
    ? []
    : await Promise.allSettled([
        page.unrouteAll({ behavior: failed ? "ignoreErrors" : "wait" }),
      ]);
  const errors = [...results, ...removal].filter(
    (result) => result.status === "rejected"
  );
  if (errors.length) {
    if (!failed) throw errors[0].reason;
    await info.attach("permission-hold-cleanup-errors", {
      body: errors.map((error) => String(error.reason)).join("\n"),
      contentType: "text/plain",
    });
  }
});

for (const outcome of ["writable", "read-only", "failed"] as const) {
  for (const order of ["obsolete-first", "newest-first"] as const) {
    test(`native held chat sends only after the newest read: ${outcome}, ${order}`, async ({
      page,
      collectors,
    }) => {
      const other = (await collectors.signIn()).page;
      await nameCollector(other, "Misty W");
      const edition = seedCatalog()["PAL 185"];
      await hold(other, await forTradeLeaf(other, "Shelf"), edition, 1);
      await signInAsOwner(page, "/collection");
      await befriend(page, other);
      const id = await propose(
        page,
        await accountId(other),
        [],
        [[edition, 1]]
      );
      await identifyOfferReads(page, id);
      await page.goto(`${ORIGIN}/trades/${id}`);
      const editor = page.getByRole("textbox", { name: /^Message / });
      const send = page.getByRole("button", { name: "Send", exact: true });
      await editor.fill("Held body 日本語");
      await expect(send).toBeEnabled();
      const posts: string[] = [];
      await page.route(`**/api/trades/${id}/messages`, async (route) => {
        posts.push(route.request().postData()!);
        await route.continue();
      });
      const held = await holdDetailReads(page, id);
      const recheck = () =>
        page.evaluate(() =>
          document.dispatchEvent(new Event("visibilitychange"))
        );
      await send.hover();
      await page.mouse.down();
      await recheck();
      await held.waitForNewer();
      await page.mouse.up();
      await expect(
        page.getByRole("button", { name: "Sending…", exact: true })
      ).toBeDisabled();
      await expect(editor).toHaveAttribute("readonly", "");
      expect(posts).toEqual([]);
      const previous = await held.startedSequence();
      await recheck();
      const selected = await held.waitForNewer(previous);
      const obsolete = () => held.releaseObsolete(selected.sequence);
      const newest = () => held.settleNewest(outcome, selected.sequence);
      if (order === "obsolete-first") {
        await obsolete();
        expect(posts).toEqual([]);
        await expect(editor).toHaveAttribute("readonly", "");
        await newest();
      } else {
        await newest();
        await obsolete();
      }
      if (outcome === "writable") {
        await expect(
          page.getByRole("list", { name: "Messages and changes" })
        ).toContainText("Held body 日本語");
        expect(posts).toHaveLength(1);
        expect(JSON.parse(posts[0]).body).toBe("Held body 日本語");
        expect(JSON.parse(posts[0]).idempotency_key).toMatch(/^[0-9a-f-]{36}$/);
        await expect(editor).toHaveValue("");
      } else {
        if (outcome === "failed") {
          await expect(editor).toHaveValue("Held body 日本語");
          await expect(editor).not.toHaveAttribute("readonly", "");
          await expect(
            page
              .getByRole("status")
              .filter({ hasText: "Chat couldn't be checked." })
          ).toBeVisible();
          await expect(
            page.getByRole("button", { name: "Retry", exact: true })
          ).toBeVisible();
        } else {
          await expect(
            page.getByRole("heading", { name: "Chat and changes", exact: true })
          ).toBeFocused();
          await expect(editor).toHaveCount(0);
        }
        // Check no POST only after the held intent reached its terminal state.
        expect(posts).toEqual([]);
      }
      await held.assertLatestOutcome(outcome);
      if (outcome !== "writable") expect(posts).toEqual([]);
    });
  }
}

test("native IME composition keeps the message draft until an explicit Send", async ({
  page,
  collectors,
}) => {
  const other = (await collectors.signIn()).page;
  await nameCollector(other, "Misty W");
  const edition = seedCatalog()["PAL 185"];
  await hold(other, await forTradeLeaf(other, "Shelf"), edition, 1);
  await signInAsOwner(page, "/collection");
  await befriend(page, other);
  const id = await propose(page, await accountId(other), [], [[edition, 1]]);
  await identifyOfferReads(page, id);
  await page.goto(`${ORIGIN}/trades/${id}`);
  const editor = page.getByRole("textbox", { name: /^Message / });
  await expect(editor).toBeEnabled();
  const bodies: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname === `/api/trades/${id}/messages`
    )
      bodies.push(request.postData()!);
  });
  await editor.focus();
  const ime = await page.context().newCDPSession(page);
  try {
    // Chromium's real composition path, rather than dispatching DOM composition events.
    await ime.send("Input.imeSetComposition", {
      text: "日本語",
      selectionStart: 3,
      selectionEnd: 3,
    });
    await expect(editor).toHaveValue("日本語");
    await ime.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Process",
      code: "Enter",
      windowsVirtualKeyCode: 229,
    });
    await ime.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Process",
      code: "Enter",
      windowsVirtualKeyCode: 229,
    });
    expect(bodies).toEqual([]);
    await ime.send("Input.insertText", { text: "日本語" });
    await expect(editor).toHaveValue("日本語");
    expect(bodies).toEqual([]);
  } finally {
    await ime.detach();
  }
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(
    page.getByRole("list", { name: "Messages and changes" })
  ).toContainText("日本語");
  expect(bodies).toHaveLength(1);
  expect(JSON.parse(bodies[0]).body).toBe("日本語");
});

async function chatItem(
  page: import("@playwright/test").Page,
  collectors: {
    signIn: () => Promise<{ page: import("@playwright/test").Page }>;
  }
) {
  const other = (await collectors.signIn()).page;
  await nameCollector(other, "Misty W");
  const edition = seedCatalog()["PAL 185"];
  await hold(other, await forTradeLeaf(other, "Shelf"), edition, 1);
  await signInAsOwner(page, "/collection");
  await befriend(page, other);
  const id = await propose(page, await accountId(other), [], [[edition, 1]]);
  await identifyOfferReads(page, id);
  await page.goto(`${ORIGIN}/trades/${id}`);
  await expect(page.getByRole("textbox", { name: /^Message / })).toBeEnabled();
  return id;
}

test("native held chat is dropped on a real document departure without a POST", async ({
  page,
  collectors,
}) => {
  const id = await chatItem(page, collectors);
  await page
    .getByRole("textbox", { name: /^Message / })
    .fill("Not sent after leaving");
  const held = await holdDetailReads(page, id);
  const bodies: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname === `/api/trades/${id}/messages`
    )
      bodies.push(request.postData()!);
  });
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange"))
  );
  await held.waitForNewer();
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Sending…", exact: true })
  ).toBeDisabled();
  await page.goto(`${ORIGIN}/collection`);
  await held.cleanup();
  await expect(page).toHaveURL(`${ORIGIN}/collection`);
  expect(bodies).toEqual([]);
});

test("native unknown chat holds its exact replay body and key through a permission read", async ({
  page,
  collectors,
}) => {
  const id = await chatItem(page, collectors);
  const editor = page.getByRole("textbox", { name: /^Message / });
  const bodies: string[] = [];
  await page.route(`**/api/trades/${id}/messages`, async (route) => {
    bodies.push(route.request().postData()!);
    if (bodies.length === 1) {
      await route.fetch();
      await route.abort("failed");
    } else await route.continue();
  });
  await editor.fill("One message, one key");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const retry = page
    .locator("form")
    .filter({ has: editor })
    .getByRole("button", { name: "Retry", exact: true });
  await expect(retry).toBeEnabled();
  const held = await holdDetailReads(page, id);
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange"))
  );
  await held.waitForNewer();
  await retry.click();
  await expect(
    page.getByRole("button", { name: "Sending…", exact: true })
  ).toBeDisabled();
  expect(bodies).toHaveLength(1);
  await expect(editor).toHaveAttribute("readonly", "");
  await held.settleNewest("writable");
  await expect(editor).toHaveValue("");
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toBe(bodies[0]);
  await expect(
    page
      .getByRole("list", { name: "Messages and changes" })
      .getByText("You: One message, one key", { exact: true })
  ).toHaveCount(1);
  await held.assertLatestOutcome("writable");
});
