import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { signInAsOwner } from "./support/sign-in";
import { createDeck, ORIGIN } from "./support/loans";

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
    await page.goto(`${ORIGIN}/decks/${deck}`);
    await page.getByRole("button", { name: "Publish", exact: true }).click();
    const title = page.getByRole("textbox", {
      name: "Public title",
      exact: true,
    });
    await expect(title).toBeFocused();
    await expect(title).toHaveValue("");
    await expect(title).toHaveAccessibleDescription(
      /A public title is required to publish\./
    );
    await expect(
      page.getByRole("button", { name: "Publish Unlisted snapshot" })
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
