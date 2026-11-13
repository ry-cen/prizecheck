import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { signInAsOwner } from "./support/sign-in";
import { createDeck, ORIGIN } from "./support/loans";
import { showAsLegal } from "./support/publish-gate";

for (const viewport of [
  { width: 1280, height: 800 },
  { width: 375, height: 812 },
]) {
  test(`Handle validation and Publish title focus at ${viewport.width}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await signInAsOwner(page, "/settings");
    const handle = page.getByRole("textbox", { name: "Handle", exact: true });
    await handle.fill("a!");
    await page
      .getByRole("button", { name: "Save Handle", exact: true })
      .click();
    await expect(handle).toHaveAttribute("aria-invalid", "true");
    await expect(handle).toBeFocused();
    await expect(handle).toHaveAccessibleDescription(
      /Use 3 to 20 letters, digits and underscores\./
    );
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
          .analyze()
      ).violations
    ).toEqual([]);
    await handle.fill("valid_handle");
    await expect(handle).not.toHaveAttribute("aria-invalid", "true");
    const deck = await createDeck(page, `Title focus ${randomUUID()}`);
    // Match publications.spec.ts: the page requires a legal Target Format result.
    // This journey only opens the dialog; it sends no publish command to the server.
    await showAsLegal(page, deck);
    await page.goto(`${ORIGIN}/decks/${deck}`);
    const publish = page.getByRole("button", { name: "Publish", exact: true });
    await expect(publish).toBeEnabled();
    await publish.click();
    const dialog = page.getByRole("dialog", { name: "Publish", exact: true });
    await expect(dialog).toBeVisible();
    const title = dialog.getByRole("textbox", {
      name: "Public title",
      exact: true,
    });
    await expect(title).toBeFocused();
    await expect(title).toHaveValue("");
    await expect(title).toHaveAccessibleDescription(
      /A public title is required to publish\./
    );
    await expect(
      dialog.getByRole("button", { name: "Publish Unlisted snapshot" })
    ).toBeDisabled();
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
          .analyze()
      ).violations
    ).toEqual([]);
  });
}
