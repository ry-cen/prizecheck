import { randomUUID } from "node:crypto";
import { test, expect } from "./support/collectors";
import { signInAsOwner } from "./support/sign-in";
import { startAsNewOwner } from "./support/owner";
import { legalEdition, promoteLegalCatalog } from "./support/legal-deck";
import { setLine } from "./support/loans";

const ORIGIN = process.env.TEST_ORIGIN || "http://localhost:5173";

for (const viewport of [
  { width: 1280, height: 800 },
  { width: 375, height: 812 },
]) {
  test(`Deck and Want List entry focus and Back at ${viewport.width}`, async ({
    page,
    collectors,
  }) => {
    await page.setViewportSize(viewport);
    promoteLegalCatalog();
    await startAsNewOwner(collectors.pool);
    await signInAsOwner(page, "/decks");
    const name = `Focus Deck ${randomUUID()}`;
    const response = await page.request.post(`${ORIGIN}/api/decks`, {
      headers: { origin: ORIGIN },
      data: { name, idempotency_key: randomUUID() },
    });
    expect(response.status()).toBe(201);
    const deckId = (await response.json()).location.id;
    // A populated Deck opens its Deck pane on phones, where the Want List opener lives.
    await setLine(page, deckId, await legalEdition("me01-001"), 1);
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
