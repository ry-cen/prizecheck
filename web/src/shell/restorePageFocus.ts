import { RESTORE_WINDOW_MS } from "./restorePageScroll";

/** The control that had focus when a history entry was left: the element itself, and how to find its remounted twin. */
export type SavedFocus = {
  element: Element;
  tag: string;
  href: string | null;
  name: string;
};

export type PageFocus = SavedFocus | "heading";

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
  const twins = [...container.querySelectorAll<HTMLElement>(saved.tag)].filter(
    (element) =>
      element.getAttribute("href") === saved.href &&
      nameOf(element) === saved.name
  );
  // Two controls alike can't tell which one was left; guessing could focus one off screen.
  return twins.length === 1 ? twins[0] : null;
}

/** A forward page entry focuses its heading; Back or Forward restores the control that left the entry.
 * Both wait for the target to be drawn; focus moved by
 * the collector or the page first, any input, or a bounded wait releases it. Scroll is the shell's to restore. */
export function restorePageFocus(
  container: HTMLElement | null | undefined,
  saved: PageFocus | null | undefined
): () => void {
  if (!container || !saved) return () => {};
  let stopped = false;
  let observer: MutationObserver | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    stopped = true;
    observer?.disconnect();
    clearTimeout(timer);
    window.removeEventListener("pointerdown", stop);
    window.removeEventListener("keydown", stop);
    window.removeEventListener("focusin", stop);
  };
  const attempt = () => {
    const active = document.activeElement;
    if (
      active &&
      active !== document.body &&
      !(saved === "heading" && active === initialFocus)
    )
      return stop();
    const element =
      saved === "heading"
        ? container.querySelector<HTMLElement>("h1")
        : find(container, saved);
    if (!element || element.closest("[hidden],[inert]")) return;
    if (saved === "heading") {
      element.tabIndex = -1;
      element.classList.add("outline-none");
    }
    element.focus({ preventScroll: true });
    if (document.activeElement === element) stop();
  };
  const initialFocus = document.activeElement;
  attempt();
  // Leaving dropped focus to the body while the page was hidden or remounted; wait for the control to be drawn.
  if (
    !stopped &&
    (document.activeElement === document.body ||
      (saved === "heading" && document.activeElement === initialFocus))
  ) {
    observer = new MutationObserver(attempt);
    observer.observe(container, { childList: true, subtree: true });
    if (saved !== "heading") timer = setTimeout(stop, RESTORE_WINDOW_MS);
    window.addEventListener("pointerdown", stop, { once: true });
    window.addEventListener("keydown", stop, { once: true });
    if (saved === "heading")
      window.addEventListener("focusin", stop, { once: true });
  }
  return stop;
}
