import { randomUUID } from "node:crypto";
import { test, expect } from "./support/collectors";
import { signInAsOwner } from "./support/sign-in";
import { startAsNewOwner } from "./support/owner";

for (const viewport of [
  { width: 1280, height: 800 },
  { width: 375, height: 812 },
]) {
  test(`Deck and Want List entry focus and Back at ${viewport.width}`, async ({
    page,
    collectors,
  }) => {
    await page.setViewportSize(viewport);
    await startAsNewOwner(collectors.pool);
    await signInAsOwner(page, "/decks");
    const name = `Focus Deck ${randomUUID()}`;
    const response = await page.request.post("/api/decks", {
      headers: { origin: new URL(page.url()).origin },
      data: { name, idempotency_key: randomUUID() },
    });
    expect(response.status()).toBe(201);
    await page.reload();
    const main = page.locator("main:visible");
    const opener = main.getByRole("link", { name, exact: true });
    await opener.focus();
    const scroll = await page.evaluate(() => window.scrollY);
    await opener.click();
    await expect(main.getByRole("heading", { level: 1 })).toBeFocused();
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
    await page.goBack();
    await expect(opener).toBeFocused();
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(scroll);
    await opener.click();
    await expect(main.getByRole("heading", { level: 1 })).toBeFocused();
    const wantList = main.getByRole("button", {
      name: "Want List",
      exact: true,
    });
    await wantList.click();
    await expect(main.getByRole("heading", { level: 1 })).toBeFocused();
    await page.goBack();
    await expect(wantList).toBeFocused();
  });
}
