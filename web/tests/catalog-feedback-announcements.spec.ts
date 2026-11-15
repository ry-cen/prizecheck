import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { signInAsOwner } from "./support/sign-in";

for (const undo of [false, true]) {
  test(`one Add${undo ? " then Undo" : ""} updates each live region once`, async ({
    page,
  }) => {
    execFileSync(
      ".venv/bin/python",
      ["-c", "from test_catalog_browse import seed_popup\nseed_popup()"],
      { env: { ...process.env, PYTHONPATH: "api:api/tests" } }
    );
    await signInAsOwner(page, "/catalog");
    await page
      .getByRole("region", { name: "Catalog results" })
      .getByRole("button", { name: /^Switch,/ })
      .click();
    const popup = page.getByRole("dialog");
    await expect(
      popup.getByRole("button", { name: "Add 1", exact: true })
    ).toBeEnabled();
    await page.evaluate(() => {
      const selector = '[aria-live], [role="status"], [role="alert"]';
      const last = new WeakMap<Element, string>();
      const updates: string[] = [];
      document
        .querySelectorAll(selector)
        .forEach((el) => last.set(el, el.textContent ?? ""));
      new MutationObserver(() => {
        document.querySelectorAll(selector).forEach((el) => {
          const text = el.textContent ?? "";
          if (last.get(el) === text) return;
          last.set(el, text);
          if (!el.closest('[aria-live="off"]') && text.trim())
            updates.push(text);
        });
        document.documentElement.dataset.feedbackUpdates =
          JSON.stringify(updates);
      }).observe(document.body, {
        childList: true,
        characterData: true,
        subtree: true,
      });
    });
    await popup.getByRole("button", { name: "Add 1", exact: true }).click();
    await expect(
      popup.getByRole("button", { name: "Undo", exact: true })
    ).toBeVisible();
    const updates = () =>
      page.evaluate(
        () =>
          JSON.parse(
            document.documentElement.dataset.feedbackUpdates ?? "[]"
          ) as string[]
      );
    await expect
      .poll(async () =>
        (await updates()).filter((text) => /^Added /.test(text))
      )
      .toEqual(["Added 1 copy to Unsorted."]);
    if (undo) {
      await popup.getByRole("button", { name: "Undo", exact: true }).click();
      await expect
        .poll(async () =>
          (await updates()).filter((text) => /^Undo removed/.test(text))
        )
        .toEqual(["Undo removed 1 card from Unsorted."]);
    }
    await popup.getByRole("button", { name: /^Close/ }).click();
    const toast = page.getByRole("region", { name: "Notifications" });
    await expect(toast).toContainText(
      undo ? "Undo removed 1 card from Unsorted." : "Added 1 card to Unsorted."
    );
    await expect
      .poll(async () =>
        (await updates()).filter((text) => /^(Added |Undo removed)/.test(text))
      )
      .toHaveLength(undo ? 2 : 1);
  });
}
