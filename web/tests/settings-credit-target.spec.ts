import { expect, test } from "./support/collectors";
import { signInAsOwner } from "./support/sign-in";
import { expectTouchTarget } from "./support/touch-target";

test.use({
  viewport: { width: 375, height: 812 },
  isMobile: true,
  hasTouch: true,
});
test("Settings price credit has a full touch target", async ({ page }) => {
  await signInAsOwner(page, "/settings");
  const link = page.getByRole("link", { name: "TCGCSV", exact: true });
  await expect(link).toHaveCount(1);
  await expect(link.locator("..")).toHaveText("Prices from TCGCSV");
  await expectTouchTarget(link);
});
