import { expect, type Page } from "@playwright/test";

/**
 * Opening a Deck shows the deck builder at /decks/<id> (#176). Until #181 replaces them, the old Decks page's panels
 * for that Deck (the Holdings checks and cost, the Holdings panel, Publish and the exports) sit in a closed
 * "Holdings, publishing and exports" section at the foot of the builder. This opens it and waits for the panels.
 *
 * The section starts closed each time the builder opens a Deck, so call this once after every such opening (a
 * second call in the same opening would close it again).
 */
export async function openDeckTools(page: Page) {
  await expect(page).toHaveURL(/\/decks\/[^/?#]+$/);
  await page
    .getByText("Holdings, publishing and exports", { exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: /^Checks for / })
  ).toBeVisible();
}
