import type { Page, TestInfo } from "@playwright/test";

/** Opt-in diagnostics; keeps platform font identity alongside geometry, including overflowing descendants.
 * Run with FONT_EVIDENCE=1 npm run verify:local -- --suite browser --browser-workers 1 --
 * web/tests/public-header.spec.ts web/tests/pick-location-paths.spec.ts
 * TEST_FONTCONFIG_FILE optionally affects only the launched Chromium process.
 */
export async function captureFontEvidence(page: Page, info: TestInfo) {
  if (process.env.FONT_EVIDENCE !== "1") return;
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  const session = await page.context().newCDPSession(page);
  try {
    await session.send("DOM.enable");
    await session.send("CSS.enable");
    const elements = await page.locator("body *").evaluateAll((nodes) =>
      nodes.map((node, index) => {
        const el = node as HTMLElement;
        el.setAttribute("data-font-evidence", String(index));
        const rect = el.getBoundingClientRect();
        const css = getComputedStyle(el);
        return {
          tag: el.tagName,
          text: el.textContent?.trim().slice(0, 160),
          directText: Array.from(el.childNodes).some(
            (child) =>
              child.nodeType === Node.TEXT_NODE && child.textContent?.trim()
          ),
          header: !!el.closest("header"),
          main: !!el.closest("main"),
          overflowing:
            rect.right > document.documentElement.clientWidth || rect.left < 0,
          rect: rect.toJSON(),
          fontFamily: css.fontFamily,
          fontSize: css.fontSize,
          fontWeight: css.fontWeight,
          display: css.display,
          minWidth: css.minWidth,
          whiteSpace: css.whiteSpace,
        };
      })
    );
    const { root } = await session.send("DOM.getDocument", { depth: -1 });
    const fonts = await Promise.all(
      elements.flatMap((el, index) => {
        if (
          !el.rect.width ||
          !el.rect.height ||
          !el.directText ||
          (!el.header &&
            !el.overflowing &&
            !(
              el.main &&
              /From |Suggested:|has none|has no |Use suggested/.test(
                el.text ?? ""
              )
            ))
        )
          return [];
        return [
          (async () => {
            const { nodeId } = await session.send("DOM.querySelector", {
              nodeId: root.nodeId,
              selector: `[data-font-evidence="${index}"]`,
            });
            if (!nodeId) return { ...el, fonts: [], detached: true };
            const rendered = await session.send("CSS.getPlatformFontsForNode", {
              nodeId,
            });
            return { ...el, fonts: rendered.fonts };
          })(),
        ];
      })
    );
    const metrics = await page.evaluate(() => ({
      viewport: { width: innerWidth, height: innerHeight },
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      banner: document
        .querySelector("header")
        ?.getBoundingClientRect()
        .toJSON(),
      fontsStatus: document.fonts.status,
      userAgent: navigator.userAgent,
    }));
    await info.attach("font-evidence", {
      body: JSON.stringify(
        { metrics, fonts, overflow: elements.filter((el) => el.overflowing) },
        null,
        2
      ),
      contentType: "application/json",
    });
    await info.attach("font-evidence-render", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
  } finally {
    await session.detach();
  }
}
