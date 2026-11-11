import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { signInAsOwner } from "./support/sign-in";

const ORIGIN = process.env.TEST_ORIGIN || "http://localhost:5173";

test("Decks read failure offers one Retry and recovers the list", async ({
  page,
}) => {
  await signInAsOwner(page, "/decks");
  const name = `Recovery Deck ${randomUUID().slice(0, 8)}`;
  const created = await page.request.post(`${ORIGIN}/api/decks`, {
    headers: { origin: ORIGIN },
    data: { name, idempotency_key: randomUUID() },
  });
  expect(created.status()).toBe(201);

  let fail = true;
  let reads = 0;
  await page.route(/\/api\/decks(?:\?.*)?$/, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    reads += 1;
    if (fail) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ detail: { code: "SERVICE_UNAVAILABLE" } }),
      });
    } else await route.continue();
  });
  await page.reload();
  const decks = page.getByRole("region", { name: "Your Decks", exact: true });
  const message = "Decks are temporarily unavailable.";
  const notice = decks.getByRole("status").locator("span");
  const retry = decks.getByRole("button", { name: "Retry", exact: true });
  await expect(notice).toHaveText(message);
  await expect(decks.getByText(message, { exact: true })).toHaveCount(1);
  await expect(
    decks.getByRole("button", { name: "Retry", exact: true })
  ).toHaveCount(1);
  await test.info().attach("failed-decks-dom", {
    body: await decks.innerText(),
    contentType: "text/plain",
  });

  // A second failed read keeps both the exact message and keyboard focus on Retry.
  await retry.focus();
  const failedRetry = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/decks" &&
      response.status() === 503
  );
  await retry.press("Enter");
  await failedRetry;
  await expect(notice).toHaveText(message);
  await expect(retry).toHaveCount(1);
  await expect(retry).toBeFocused();

  const failedReads = reads;
  fail = false;
  await retry.press("Enter");
  await expect(decks.getByRole("link", { name, exact: true })).toBeVisible();
  expect(reads).toBeGreaterThan(failedReads);
  await expect(
    decks.getByRole("heading", { name: "Your Decks", exact: true })
  ).toBeFocused();
  await expect(decks.getByRole("status")).toHaveCount(0);
  await expect(
    decks.getByRole("button", { name: "Retry", exact: true })
  ).toHaveCount(0);
  await expect(decks.getByText(message, { exact: true })).toHaveCount(0);
  await test.info().attach("recovered-decks-dom", {
    body: await decks.innerText(),
    contentType: "text/plain",
  });
});
