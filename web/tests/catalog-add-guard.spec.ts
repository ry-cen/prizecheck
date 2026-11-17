import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { signInAsOwner } from "./support/sign-in";

// A second tap on Add that lands right after the first add finished is the same press arriving twice, not a second add:
// it must not put a hidden extra copy under the first one's "Added 1 copy" message. A deliberate press after the
// short guard window adds again, with its own message and Undo.
for (const viewport of [
  { width: 1280, height: 800 },
  { width: 375, height: 812 },
]) {
  test(`a quick second tap on Add adds one copy, and a later Add adds another, at ${viewport.width}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    execFileSync(
      ".venv/bin/python",
      ["-c", "from test_catalog_browse import seed_popup\nseed_popup()"],
      { env: { ...process.env, PYTHONPATH: "api:api/tests" } }
    );
    const posts: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && request.url().includes("/api/"))
        posts.push(request.url());
    });
    await signInAsOwner(page, "/catalog");
    await page
      .getByRole("region", { name: "Catalog results" })
      .getByRole("button", { name: /^Switch,/ })
      .click();
    const popup = page.getByRole("dialog");
    const add = popup.getByRole("button", { name: "Add 1", exact: true });
    await expect(add).toBeEnabled();

    // "Where your copies are" says "1 copy owned" or "N copies owned" (or that there are none) once it has counted.
    const where = popup.getByText(
      /^(You don't own this Edition yet\.|\d[\d,]* (copy|copies) owned)$/
    );
    const owned = async () => {
      const text = (await where.textContent()) ?? "";
      return Number(/^(\d[\d,]*)/.exec(text)?.[1].replace(/,/g, "") ?? 0);
    };
    await expect(where).toBeVisible();
    const before = await owned();
    const sentBefore = posts.length;

    // The first add finishes; the second tap arrives straight after.
    const finished = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().includes("/api/")
    );
    await add.click();
    await finished;
    await add.dispatchEvent("click");
    await add.dispatchEvent("click");

    await expect.poll(owned).toBe(before + 1);
    await expect(popup.getByText("Added 1 copy to Unsorted.")).toBeVisible();
    expect(posts.length - sentBefore).toBe(1);
    await expect(add).toBeFocused();

    // After the guard window a deliberate Add works as before, with its own message and Undo.
    await expect(add).not.toHaveAttribute("aria-disabled", "true");
    await add.click();
    await expect.poll(owned).toBe(before + 2);
    await expect(popup.getByText("Added 1 copy to Unsorted.")).toBeVisible();
    expect(posts.length - sentBefore).toBe(2);
    await popup.getByRole("button", { name: "Undo", exact: true }).click();
    await expect.poll(owned).toBe(before + 1);
  });
}
