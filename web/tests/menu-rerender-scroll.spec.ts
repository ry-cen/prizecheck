import { expect, test } from "@playwright/test";

declare global {
  interface Window {
    rerenderMenu: () => Promise<number>;
  }
}
const ORIGIN = process.env.TEST_ORIGIN || "http://localhost:5173";

for (const identity of ["same", "new"] as const) {
  test(`Menu keeps wheel scroll when its parent re-renders with ${identity} items identity`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1270, height: 160 });
    const container = page.locator("#menu-rerender-test");
    const trigger = container.getByRole("button", { name: "Test Menu" });
    const menu = container.getByRole("menu");
    const first = menu.getByRole("menuitem").first();
    const viewport = menu.locator("..");

    await test.step("mount Menu", async () => {
      const response = await page.goto(`${ORIGIN}/`);
      expect(response?.ok()).toBe(true);
      await expect(page.getByRole("main")).toBeVisible();
      await page.evaluate(async (identity) => {
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
        host.id = "menu-rerender-test";
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
          window.rerenderMenu = () =>
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
              items: identity === "new" ? items.slice() : items,
            })
          );
        }
        await new Promise<number>((resolve) => {
          committed = resolve;
          ReactDOMClient.createRoot(host).render(React.createElement(Parent));
        });
      }, identity);
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
    await test.step("wheel scrolls", async () => {
      await viewport.hover();
      await page.mouse.wheel(0, 1000);
      await expect
        .poll(() => viewport.evaluate((el) => el.scrollTop))
        .toBeGreaterThan(0);
      await expect(first).toBeFocused();
    });
    await test.step(`re-render with equivalent ${identity} items`, async () => {
      expect(await page.evaluate(() => window.rerenderMenu())).toBe(1);
    });
    await test.step("scroll preserved after re-render", async () => {
      // Suspected bug: new items identity reruns Menu's positioning effect,
      // which reveals the focused first item and resets the collector's scroll.
      await expect(menu).toBeVisible();
      await expect(trigger).toHaveAttribute("aria-expanded", "true");
      await expect
        .poll(() => viewport.evaluate((el) => el.scrollTop))
        .toBeGreaterThan(0);
    });
  });
}
