// The two-collector harness (web/tests/support/collectors.ts) that social network journeys use from #247: each other
// collector is a separate account in its own browser context, on the same stack as the test's own page.
import { expect, test } from "./support/collectors";
import { signInAsOwner } from "./support/sign-in";

const ORIGIN = process.env.TEST_ORIGIN || "http://localhost:5173";
const OWNER_EMAIL = process.env.OWNER_EMAIL || "owner@example.test";

async function userId(page: import("@playwright/test").Page): Promise<string> {
  const response = await page.request.get(`${ORIGIN}/auth/session`);
  return ((await response.json()) as { userId: string }).userId;
}

async function locationNames(
  page: import("@playwright/test").Page
): Promise<string[]> {
  const response = await page.request.get(`${ORIGIN}/api/location-tree`);
  expect(response.status()).toBe(200);
  return (
    (await response.json()) as { locations: { name: string }[] }
  ).locations
    .map((l) => l.name)
    .sort();
}

test("two collectors on one stack are separate signed-in accounts", async ({
  page,
  collectors,
}) => {
  const misty = await collectors.signIn();
  // The test's own page signs in after the other collector, as the owner.
  await signInAsOwner(page);
  const owner = await userId(page);
  expect(owner).toBeTruthy();
  expect(owner).not.toBe(misty.userId);
  expect(await userId(misty.page)).toBe(misty.userId);

  // Each sees only their own Locations.
  const made = await misty.page.request.post(`${ORIGIN}/api/location-tree`, {
    headers: { origin: ORIGIN },
    data: {
      name: "Misty's binder",
      parent_id: null,
      idempotency_key: crypto.randomUUID(),
    },
  });
  expect(made.status()).toBe(201);
  expect(await locationNames(misty.page)).toEqual([
    "Misty's binder",
    "Unsorted",
  ]);
  expect(await locationNames(page)).toEqual(["Unsorted"]);

  // Both stay signed in across a reload.
  await misty.page.reload();
  await page.reload();
  await expect(misty.page.getByRole("heading", { level: 1 })).toBeVisible();
  expect(await userId(misty.page)).toBe(misty.userId);
  expect(await userId(page)).toBe(owner);

  // A second call makes a third collector; the owner seat is free again afterwards.
  const brock = await collectors.signIn();
  expect(new Set([owner, misty.userId, brock.userId]).size).toBe(3);
  const { rows } = await collectors.pool.query(
    'SELECT count(*)::int AS n FROM "user" WHERE email=$1',
    [OWNER_EMAIL]
  );
  expect(rows[0].n).toBe(0);
});
