import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";
import { animationsFinished } from "./motion";

/**
 * The app redesign's shared page check (spec "Testing Decisions"). Every page runs it at 1280×800 and
 * 375×812 on its main states, with its dialogs and sheets open as well as closed:
 *
 * - axe at WCAG 2.2 AA (incomplete results, such as text over artwork, are not failures);
 * - no page-level horizontal scroll (a wide table scrolls inside its own box instead);
 * - at phone widths (760 px or narrower), every visible interactive element at least 44 px tall and wide,
 *   or with a 44 px tap area around its centre (the kit's tap-area extension for small chips).
 *
 * Checks read roles, boxes and hit tests, never class names. Entry animations finish first, so a
 * drawer that is still sliding in is not measured.
 */
export async function expectPageChecks(page: Page, state: string) {
  await animationsFinished(page);

  const axe = await new AxeBuilder({ page }).withTags(WCAG_AA).analyze();
  expect(
    axe.violations.map(
      (violation) =>
        `${violation.id}: ${violation.nodes.map((node) => node.target.join(" ")).join(" | ")}`
    ),
    `WCAG 2.2 AA violations in ${state}`
  ).toEqual([]);

  const width = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(
    width.scroll,
    `page-level horizontal scroll in ${state} (${width.scroll} px of content in ${width.client} px)`
  ).toBeLessThanOrEqual(width.client);

  const viewport = page.viewportSize();
  if (viewport && viewport.width <= PHONE_MAX_WIDTH)
    expect(
      await smallTargets(page),
      `phone targets under ${TOUCH_TARGET} px in ${state}`
    ).toEqual([]);
}

export const WCAG_AA = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const PHONE_MAX_WIDTH = 760;
const TOUCH_TARGET = 44;

/**
 * Visible interactive elements smaller than 44 px in either direction with no 44 px tap area. An inline
 * link inside a paragraph is exempt, a checkbox or radio is measured by its label, and anything inert,
 * aria-hidden, invisible or parked above or left of the page (a skip link before it is focused) is left
 * out. While a modal is open only the controls inside it count. A small element is scrolled into view and hit-tested at nine points spread over a 44 px square
 * around its centre; it has a tap area when every point lands on it. Half a pixel is allowed for
 * fractional layout. The window's scroll position is restored afterwards.
 */
async function smallTargets(page: Page): Promise<string[]> {
  return page.evaluate((size) => {
    const min = size - 0.5;
    const reach = size / 2 - 0.5;
    const found: string[] = [];
    const start = { x: window.scrollX, y: window.scrollY };
    // With a modal open, only its own controls can be reached.
    const modal =
      document.querySelector<HTMLElement>("dialog:modal") ??
      Array.from(
        document.querySelectorAll<HTMLElement>('[aria-modal="true"]')
      ).pop();
    const controls = (modal ?? document).querySelectorAll<HTMLElement>(
      'button, a[href], input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="checkbox"], [role="switch"], [tabindex]:not([tabindex="-1"])'
    );
    const describe = (element: HTMLElement, box: DOMRect) =>
      `${element.tagName.toLowerCase()} "${(element.getAttribute("aria-label") || element.textContent || "").trim().slice(0, 40)}" ${Math.round(box.width)}x${Math.round(box.height)}`;
    const hitsItself = (element: HTMLElement, box: DOMRect) => {
      const x = box.left + box.width / 2;
      const y = box.top + box.height / 2;
      for (const dx of [-reach, 0, reach])
        for (const dy of [-reach, 0, reach]) {
          const hit = document.elementFromPoint(x + dx, y + dy);
          if (!hit || !(hit === element || element.contains(hit))) return false;
        }
      return true;
    };
    for (const element of Array.from(controls)) {
      if (element.closest("[inert]") || element.closest('[aria-hidden="true"]'))
        continue;
      const style = getComputedStyle(element);
      if (style.visibility === "hidden" || style.opacity === "0") continue;
      if (element.matches("a") && element.parentElement?.closest("p")) continue;
      const measured = element.matches(
        'input[type="checkbox"], input[type="radio"]'
      )
        ? (element.closest("label") ?? element)
        : element;
      let box = measured.getBoundingClientRect();
      if (!box.width || !box.height) continue;
      if (box.bottom + window.scrollY <= 0 || box.right + window.scrollX <= 0)
        continue;
      if (box.width >= min && box.height >= min) continue;
      const inView =
        box.top - reach >= 0 &&
        box.left - reach >= 0 &&
        box.bottom + reach <= window.innerHeight &&
        box.right + reach <= window.innerWidth;
      if (!inView) {
        measured.scrollIntoView({ block: "center", inline: "center" });
        box = measured.getBoundingClientRect();
      }
      if (!hitsItself(measured, box)) found.push(describe(element, box));
    }
    window.scrollTo(start.x, start.y);
    return found;
  }, TOUCH_TARGET);
}
