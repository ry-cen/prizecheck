import type { Route } from "@playwright/test";
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
      const reads: { route: Route; body: Record<string, unknown> }[] = [];
      await page.route(`**/api/trades/${id}`, async (route) => {
        if (route.request().method() !== "GET") return route.continue();
        const response = await route.fetch();
        reads.push({ route, body: await response.json() });
      });
      const recheck = () =>
        page.evaluate(() =>
          document.dispatchEvent(new Event("visibilitychange"))
        );
      await send.hover();
      await page.mouse.down();
      await recheck();
      await expect.poll(() => reads.length).toBe(1);
      await page.mouse.up();
      await expect(
        page.getByRole("button", { name: "Sending…", exact: true })
      ).toBeDisabled();
      await expect(editor).toHaveAttribute("readonly", "");
      expect(posts).toEqual([]);
      await recheck();
      await expect.poll(() => reads.length).toBe(2);
      const obsolete = async () => {
        // Superseded reads may already have been aborted by the real fetch signal.
        try {
          await reads[0].route.fulfill({ json: reads[0].body });
        } catch (error) {
          expect(reads[0].route.request().failure()?.errorText).toContain(
            "ABORTED"
          );
        }
      };
      const newest = async () => {
        if (outcome === "failed") await reads[1].route.abort("failed");
        else
          await reads[1].route.fulfill({
            json: { ...reads[1].body, can_message: outcome === "writable" },
          });
      };
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
        expect(posts).toEqual([]);
        if (outcome === "failed") {
          await expect(editor).toHaveValue("Held body 日本語");
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
        }
      }
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
  let held: Route | undefined;
  let detail: unknown;
  const bodies: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname === `/api/trades/${id}/messages`
    )
      bodies.push(request.postData()!);
  });
  await page.route(`**/api/trades/${id}`, async (route) => {
    detail = await (await route.fetch()).json();
    held = route;
  });
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange"))
  );
  await expect.poll(() => Boolean(held)).toBe(true);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Sending…", exact: true })
  ).toBeDisabled();
  await page.goto(`${ORIGIN}/collection`);
  try {
    await held!.fulfill({ json: detail });
  } catch {
    expect(held!.request().failure()?.errorText).toContain("ABORTED");
  }
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
  let held: Route | undefined;
  let detail: unknown;
  await page.route(`**/api/trades/${id}`, async (route) => {
    detail = await (await route.fetch()).json();
    held = route;
  });
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange"))
  );
  await expect.poll(() => Boolean(held)).toBe(true);
  await retry.click();
  await expect(
    page.getByRole("button", { name: "Sending…", exact: true })
  ).toBeDisabled();
  expect(bodies).toHaveLength(1);
  await held!.fulfill({ json: detail });
  await expect(editor).toHaveValue("");
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toBe(bodies[0]);
  await expect(
    page
      .getByRole("list", { name: "Messages and changes" })
      .getByText("You: One message, one key", { exact: true })
  ).toHaveCount(1);
});
