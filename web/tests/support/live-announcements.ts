import type { Page } from "@playwright/test";

// What a screen reader would be told, as a page's live regions change (see announcements.spec.ts). `watch` records every
// addition to a live region it would speak: not one switched off (aria-live="off"), and nothing outside the open modal
// dialog (inert). It is an approximation, so cases that matter also read the region itself.

/** Starts recording on this page now and on every page it loads next. */
export async function watch(page: Page) {
  await page.addInitScript(recorder);
  await page.evaluate(recorder);
}

function recorder() {
  const selector = '[aria-live], [role="status"], [role="alert"], output';
  const clean = (text: string | null) =>
    (text ?? "").replace(/\s+/g, " ").trim();
  const updates: string[] = [];
  const spoken = (region: Element) => {
    // The nearest aria-live decides: "off" silences the region and what is inside it.
    if (region.closest("[aria-live]")?.getAttribute("aria-live") === "off")
      return false;
    // A closed dialog, and anything hidden or inert, isn't rendered for a screen reader (the results dialog keeps its
    // status text in the page while it is closed).
    if (region.closest("dialog:not([open]), [hidden], [inert]")) return false;
    // A modal dialog makes the rest of the page inert, so nothing outside it is spoken.
    const modal = [...document.querySelectorAll("dialog[open]")].at(-1);
    return !modal || modal.contains(region);
  };
  // What a screen reader says for a live region is the text added to it (not what stays), and a region that appears with
  // words in it.
  new MutationObserver((records) => {
    const added = new Map<Element, string[]>();
    const note = (region: Element | null, text: string) => {
      if (!region || !text || !spoken(region)) return;
      added.set(region, [...(added.get(region) ?? []), text]);
    };
    for (const record of records) {
      if (record.type === "characterData")
        note(
          (record.target.parentElement ?? null)?.closest(selector) ?? null,
          clean(record.target.textContent)
        );
      else
        record.addedNodes.forEach((node) => {
          const el = node instanceof Element ? node : node.parentElement;
          const inside = (record.target as Element).closest?.(selector);
          if (inside) note(inside, clean(node.textContent));
          else if (node instanceof Element) {
            if (node.matches(selector)) note(node, clean(node.textContent));
            node
              .querySelectorAll(selector)
              .forEach((region) => note(region, clean(region.textContent)));
          } else if (el) note(el.closest(selector), clean(node.textContent));
        });
    }
    for (const texts of added.values()) updates.push(clean(texts.join(" ")));
    document.documentElement.dataset.liveUpdates = JSON.stringify(updates);
  }).observe(document.documentElement, {
    childList: true,
    characterData: true,
    subtree: true,
  });
  document.documentElement.dataset.liveUpdates = "[]";
}

export const heard = (page: Page) =>
  page.evaluate(
    () =>
      JSON.parse(
        document.documentElement.dataset.liveUpdates ?? "[]"
      ) as string[]
  );

/** The text of every live region a script would find, leaving out the ones switched off (a silenced toast). */
export const snapshot = (page: Page) =>
  page.evaluate(() =>
    [
      ...document.querySelectorAll(
        '[aria-live], [role="status"], [role="alert"]'
      ),
    ]
      .filter(
        (el) => el.closest("[aria-live]")?.getAttribute("aria-live") !== "off"
      )
      .map((el) => (el.textContent ?? "").replace(/\s+/g, " ").trim())
      .filter(Boolean)
  );

/** Everything heard since `mark` (a count from `heard`). */
export async function since(page: Page, mark: number) {
  return (await heard(page)).slice(mark);
}

/** Lets a step's late announcements land: call it once the step's last visible effect is on screen, and two more
 * frames have drawn. */
export async function settle(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((done) =>
        requestAnimationFrame(() => requestAnimationFrame(() => done()))
      )
  );
}
