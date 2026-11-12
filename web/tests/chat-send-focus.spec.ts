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
import { forTradeLeaf, propose } from "./support/trades";
import { signInAsOwner } from "./support/sign-in";

for (const width of [1280, 375])
  for (const kind of ["trade", "loan"] as const)
    for (const path of ["box", "keyboard", "click", "away"] as const)
      test(`${kind} send focus at ${width}: ${path}`, async ({
        page,
        collectors,
      }) => {
        await page.setViewportSize({
          width,
          height: width === 375 ? 812 : 800,
        });
        const other = (await collectors.signIn()).page;
        await nameCollector(other, "Misty W");
        const edition = seedCatalog()["PAL 185"];
        await signInAsOwner(page, "/collection");
        await befriend(page, other);
        let id: string;
        if (kind === "trade") {
          await hold(other, await forTradeLeaf(other, "Shelf"), edition, 1);
          id = await propose(page, await accountId(other), [], [[edition, 1]]);
        } else {
          await hold(other, await unsorted(other), edition, 1);
          const loan = await api(page, "POST", "/api/loans", {
            lender_id: await accountId(other),
            lines: [{ edition_id: edition, quantity: "1" }],
            deck_id: null,
            return_by: null,
            idempotency_key: randomUUID(),
          });
          id = loan.thread_id;
        }
        await page.goto(`${ORIGIN}/${kind}s/${id}`);
        const box = page.getByRole("textbox", { name: /^Message / });
        const send = page.getByRole("button", { name: "Send", exact: true });
        await box.fill("Keep typing after this message");
        await expect(send).toBeEnabled();
        await expect(
          page.getByText("Checking chat…", { exact: false })
        ).toHaveCount(0);
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        let arrived!: () => void;
        const started = new Promise<void>((resolve) => {
          arrived = resolve;
        });
        let posts = 0;
        await page.route(`**/api/${kind}s/${id}/messages`, async (route) => {
          posts++;
          arrived();
          await gate;
          await route.continue();
        });
        try {
          if (path === "keyboard") {
            await send.focus();
            await send.press("Enter");
          } else if (path === "click") await send.click();
          else await box.press("Control+Enter");
          await started;
          await expect(box).toBeEnabled();
          if (path === "away")
            await page
              .getByRole("heading", { name: "Chat and changes", exact: true })
              .focus();
          else {
            await expect(
              path === "box"
                ? box
                : page.getByRole("button", { name: "Sending…", exact: true })
            ).toBeFocused();
            await page.keyboard.press(
              path === "box" ? "Control+Enter" : "Enter"
            );
          }
          release();
          await expect(box).toHaveValue("");
          if (path === "away")
            await expect(
              page.getByRole("heading", {
                name: "Chat and changes",
                exact: true,
              })
            ).toBeFocused();
          else {
            await expect(box).toBeFocused();
            await box.press("Tab");
            await expect(send).toBeFocused();
          }
          expect(posts).toBe(1);
        } finally {
          release();
        }
      });
