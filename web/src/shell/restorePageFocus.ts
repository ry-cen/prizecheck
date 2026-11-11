import { RESTORE_WINDOW_MS } from "./restorePageScroll";

/** The control that had focus when a history entry was left: the element itself, and how to find its remounted twin. */
export type SavedFocus = {
  element: Element;
  tag: string;
  href: string | null;
  name: string;
};

const nameOf = (element: Element) =>
  (element.getAttribute("aria-label") ?? element.textContent ?? "").trim();

/** What had focus, unless nothing in particular did. */
export function saveFocus(): SavedFocus | null {
  const element = document.activeElement;
  if (!element || element === document.body) return null;
  return {
    element,
    tag: element.tagName,
    href: element.getAttribute("href"),
    name: nameOf(element),
  };
}

function find(container: HTMLElement, saved: SavedFocus): HTMLElement | null {
  if (saved.element.isConnected && container.contains(saved.element))
    return saved.element as HTMLElement;
  if (!saved.name) return null;
  for (const element of container.querySelectorAll<HTMLElement>(saved.tag))
    if (
      element.getAttribute("href") === saved.href &&
      nameOf(element) === saved.name
    )
      return element;
  return null;
}

/** Back or Forward to an entry gives focus back to the control that left it, once it is drawn again; focus moved by
 * the collector or the page first, any input, or a bounded wait releases it. Scroll is the shell's to restore. */
export function restorePageFocus(
  container: HTMLElement | null | undefined,
  saved: SavedFocus | null | undefined
): () => void {
  if (!container || !saved) return () => {};
  let observer: MutationObserver | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    observer?.disconnect();
    clearTimeout(timer);
    window.removeEventListener("pointerdown", stop);
    window.removeEventListener("keydown", stop);
  };
  const attempt = () => {
    const active = document.activeElement;
    if (active && active !== document.body) return stop();
    const element = find(container, saved);
    if (!element || element.closest("[hidden],[inert]")) return;
    element.focus({ preventScroll: true });
    if (document.activeElement === element) stop();
  };
  attempt();
  // Leaving dropped focus to the body while the page was hidden or remounted; wait for the control to be drawn.
  if (document.activeElement === document.body) {
    observer = new MutationObserver(attempt);
    observer.observe(container, { childList: true, subtree: true });
    timer = setTimeout(stop, RESTORE_WINDOW_MS);
    window.addEventListener("pointerdown", stop, { once: true });
    window.addEventListener("keydown", stop, { once: true });
  }
  return stop;
}
