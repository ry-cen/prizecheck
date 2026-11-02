import { expect, test, type Locator, type Page } from "@playwright/test";

declare global {
  interface Window {
    rerenderFocusMenu: () => Promise<number>;
  }
}
const ORIGIN = process.env.TEST_ORIGIN || "http://localhost:5173";

async function mountMenu(page: Page, height = 160) {
  const container = page.locator("#menu-focus-test");
  const trigger = container.getByRole("button", { name: "Test Menu" });
  const menu = container.getByRole("menu");
  const first = menu.getByRole("menuitem").first();
  const last = menu.getByRole("menuitem").last();
  const viewport = menu.locator("..");
  await test.step("mount Menu", async () => {
    await page.setViewportSize({ width: 1270, height });
    const response = await page.goto(`${ORIGIN}/`);
    expect(response?.ok()).toBe(true);
    await expect(page.getByRole("main")).toBeVisible();
    await page.evaluate(async () => {
      // Read Vite's transformed app entry so these imports use the app's exact
      // optimized module URLs (including their version), sharing its React runtime.
      const response = await fetch("/src/main.tsx");
      if (!response.ok) throw new Error("Vite did not serve the app source");
      const source = await response.text();
      const reactUrl = source.match(/from "([^"]*\/react\.js\?[^"]*)"/)?.[1];
      const clientUrl = source.match(
        /from "([^"]*\/react-dom_client\.js\?[^"]*)"/
      )?.[1];
      if (!reactUrl || !clientUrl)
        throw new Error("App entry did not expose Vite React module URLs");
      const { default: React }: { default: typeof import("react") } =
        await import(reactUrl);
      const {
        default: ReactDOMClient,
      }: {
        default: typeof import("react-dom/client");
      } = await import(clientUrl);
      const menuUrl = "/src/ui/Menu.tsx";
      const { Menu }: typeof import("../src/ui/Menu") = await import(menuUrl);
      const host = document.createElement("div");
      host.id = "menu-focus-test";
      Object.assign(host.style, {
        position: "fixed",
        inset: "0",
        zIndex: "2147483647",
        contain: "layout paint",
        background: "white",
      });
      document.body.append(host);
      const onSelect = () => {};
      const items = [
        { label: "First item", onSelect },
        { label: "Second item", onSelect },
      ];
      let committed: ((revision: number) => void) | undefined;
      function Parent() {
        const [revision, setRevision] = React.useState(0);
        window.rerenderFocusMenu = () =>
          new Promise<number>((resolve) => {
            committed = resolve;
            setRevision((value) => value + 1);
          });
        React.useLayoutEffect(() => {
          // Child layout effects, including Menu positioning, have committed.
          committed?.(revision);
          committed = undefined;
        }, [revision]);
        return React.createElement(
          "div",
          { style: { position: "absolute", top: 65, left: 16 } },
          React.createElement(Menu, {
            label: "Test Menu",
            trigger: "Open Menu",
            triggerClassName: "h-control",
            items: items.slice(),
          })
        );
      }
      await new Promise<number>((resolve) => {
        committed = resolve;
        ReactDOMClient.createRoot(host).render(React.createElement(Parent));
      });
    });
    await expect(trigger).toBeVisible();
  });
  await test.step("open", async () => {
    await trigger.click();
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitem")).toHaveCount(2);
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
  });
  await test.step("focus first item", async () => {
    await expect(first).toBeFocused();
  });
  await test.step("initial scrollTop 0", async () => {
    await expect.poll(() => viewport.evaluate((el) => el.scrollTop)).toBe(0);
  });
  return { trigger, menu, first, last, viewport };
}

async function expectFocusRevealed(item: Locator) {
  await expect(item).toBeFocused();
  await expect
    .poll(() =>
      item.evaluate((el) => {
        const viewport = el.closest('[role="menu"]')!.parentElement!;
        const visible = viewport.getBoundingClientRect();
        const rect = el.getBoundingClientRect();
        return rect.top >= visible.top && rect.bottom <= visible.bottom;
      })
    )
    .toBe(true);
}

test("a smaller Menu scroll cap still reveals the focused last item", async ({
  page,
}) => {
  const { last, viewport } = await mountMenu(page, 800);
  await test.step("End focuses the last item before shrinking", async () => {
    await page.keyboard.press("End");
    await expectFocusRevealed(last);
    await expect.poll(() => viewport.evaluate((el) => el.scrollTop)).toBe(0);
  });
  const previousCap = await viewport.evaluate((el) =>
    parseFloat(el.style.maxHeight)
  );
  await test.step("height shrink reduces the applied cap and reveals focus", async () => {
    await page.setViewportSize({ width: 1270, height: 160 });
    await expect
      .poll(() => viewport.evaluate((el) => parseFloat(el.style.maxHeight)))
      .toBeLessThan(previousCap);
    await expectFocusRevealed(last);
    await expect
      .poll(() => viewport.evaluate((el) => el.scrollTop))
      .toBeGreaterThan(0);
  });
});

test("closing and reopening Menu reveals the initial first item", async ({
  page,
}) => {
  const { trigger, menu, first, viewport } = await mountMenu(page);
  await test.step("wheel scrolls away from the first item", async () => {
    await viewport.hover();
    await page.mouse.wheel(0, 1000);
    await expect
      .poll(() => viewport.evaluate((el) => el.scrollTop))
      .toBeGreaterThan(0);
    await expect(first).toBeFocused();
  });
  await test.step("close", async () => {
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
  });
  await test.step("reopen reveals first item at scrollTop 0", async () => {
    await trigger.click();
    await expect(menu).toBeVisible();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await expectFocusRevealed(first);
    await expect.poll(() => viewport.evaluate((el) => el.scrollTop)).toBe(0);
  });
});

test("an equivalent-items rerender keeps the scroll after keyboard navigation", async ({
  page,
}) => {
  const { menu, last, viewport } = await mountMenu(page);
  await test.step("End focuses and scrolls to the last item", async () => {
    await page.keyboard.press("End");
    await expectFocusRevealed(last);
    await expect
      .poll(() => viewport.evaluate((el) => el.scrollTop))
      .toBeGreaterThan(0);
  });
  const previousScroll = await viewport.evaluate((el) => el.scrollTop);
  await test.step("re-render with equivalent new items", async () => {
    expect(await page.evaluate(() => window.rerenderFocusMenu())).toBe(1);
  });
  await test.step("keyboard scroll preserved after re-render", async () => {
    await expect(menu).toBeVisible();
    await expectFocusRevealed(last);
    await expect
      .poll(() => viewport.evaluate((el) => el.scrollTop))
      .toBe(previousScroll);
  });
});
