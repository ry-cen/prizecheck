import { randomUUID } from "node:crypto";
import { expect, test } from "./support/collectors";
import {
  ORIGIN,
  accountId,
  api,
  befriend,
  hold,
  nameCollector,
  seedCatalog,
  unsorted,
} from "./support/loans";
import { signInAsOwner } from "./support/sign-in";

for (const transport of ["lost", "delayed"] as const) {
  for (const direction of ["Back", "Forward"] as const) {
    test(`Loan terms retain one command through native dismissal, ${direction} and unload (${transport} POST)`, async ({
      page,
      collectors,
    }) => {
      const lender = (await collectors.signIn()).page;
      await nameCollector(lender, "Misty W");
      await signInAsOwner(page, "/loans");
      const edition = seedCatalog()["PAL 185"];
      await hold(lender, await unsorted(lender), edition, 3);
      await befriend(page, lender);
      const loan = await api(page, "POST", "/api/loans", {
        lender_id: await accountId(lender),
        lines: [{ edition_id: edition, quantity: "3" }],
        idempotency_key: randomUUID(),
      });
      await page.goto(`${ORIGIN}/loans`);
      await page.locator(`main a[href="/loans/${loan.thread_id}"]`).click();
      if (direction === "Forward") {
        await page
          .getByRole("navigation", { name: "Main views" })
          .getByRole("button", { name: /^Collection/ })
          .click();
        await page.goBack();
        await expect(page).toHaveURL(`${ORIGIN}/loans/${loan.thread_id}`);
      }
      await page.getByRole("button", { name: "More for this Loan" }).click();
      await page.getByRole("menuitem", { name: "Change terms" }).click();
      const dialog = page.getByRole("dialog", { name: "Change Loan terms" });
      await dialog.getByRole("spinbutton", { name: "Iono" }).fill("2");
      await expect(
        dialog.getByRole("button", { name: "Save terms" })
      ).toBeEnabled();
      const packets: string[] = [];
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let seen!: () => void;
      const received = new Promise<void>((resolve) => {
        seen = resolve;
      });
      await page.route(
        `**/api/loans/${loan.thread_id}/terms`,
        async (route) => {
          packets.push(route.request().postData()!);
          if (packets.length === 1) {
            seen();
            if (transport === "delayed") await gate;
            const response = await route.fetch();
            if (transport === "lost") await route.abort("failed");
            else await route.fulfill({ response });
          } else await route.continue();
        }
      );
      try {
        await dialog.getByRole("button", { name: "Save terms" }).click();
        await received;
        const retry = dialog.getByRole("button", { name: "Retry request" });
        if (transport === "lost") await expect(retry).toBeEnabled();
        else await expect(retry).toBeDisabled();
        for (const dismiss of ["Close", "Escape", "scrim", "header"] as const) {
          if (dismiss === "Close")
            await dialog
              .getByRole("button", { name: "Close", exact: true })
              .last()
              .click();
          if (dismiss === "header")
            await dialog
              .getByRole("button", { name: "Close", exact: true })
              .first()
              .click();
          if (dismiss === "Escape") await page.keyboard.press("Escape");
          if (dismiss === "scrim") await page.mouse.click(1, 1);
          await expect(dialog).toBeVisible();
          await expect(
            dialog.getByRole("spinbutton", { name: "Iono" })
          ).toBeDisabled();
          expect(packets).toHaveLength(1);
        }
        if (direction === "Back") await page.goBack();
        else await page.goForward();
        await expect(page).toHaveURL(`${ORIGIN}/loans/${loan.thread_id}`);
        await expect(dialog).toBeVisible();
        // Native document navigation, not a synthetic beforeunload event.
        const warning = page.waitForEvent("dialog");
        const navigation = page
          .goto(`${ORIGIN}/collection`)
          .catch((error: Error) => error);
        const prompt = await warning;
        expect(prompt.type()).toBe("beforeunload");
        await prompt.dismiss();
        expect(await navigation).toBeInstanceOf(Error);
        await expect(dialog).toBeVisible();
        expect(packets).toHaveLength(1);
        if (transport === "delayed") release();
        else await retry.click();
        await expect(dialog).toBeHidden();
        expect(packets).toHaveLength(transport === "lost" ? 2 : 1);
        if (transport === "lost") expect(packets[1]).toBe(packets[0]);
        const current = await api(page, "GET", `/api/loans/${loan.thread_id}`);
        expect(current.live_terms.lines[0].requested).toBe("2");
        // Once known, a real unload can complete without a leave warning.
        await page.goto(`${ORIGIN}/collection`);
        await expect(page).toHaveURL(`${ORIGIN}/collection`);
      } finally {
        release();
      }
    });
  }
}
