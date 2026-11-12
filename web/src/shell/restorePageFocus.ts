import { RESTORE_WINDOW_MS } from "./restorePageScroll";

/** The control that had focus when a history entry was left: the element itself, and how to find its remounted twin. */
export type SavedFocus = {
  element: Element;
  tag: string;
  href: string | null;
  name: string;
};

export type PageEntryFocus = {
  kind: "heading";
  state: "pending" | "completed" | "cancelled";
  opener: Element | null;
};

/** One request per pushed entry. Replacements share its lifecycle, never a fresh exemption. */
export function createPageEntryFocus(): PageEntryFocus {
  return { kind: "heading", state: "pending", opener: document.activeElement };
}

export type PageFocus = SavedFocus | PageEntryFocus;

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

/** Wait for entry content, then watch briefly for a loading heading being replaced. A completed
 * request can recover its own removed heading in this visit, but cannot restart on a canonical replacement. */
function focusPageEntry(
  container: HTMLElement,
  request: PageEntryFocus
): () => void {
  if (request.state !== "pending") return () => {};
  let heading: HTMLElement | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const detach = () => {
    observer.disconnect();
    clearTimeout(timer);
    window.removeEventListener("pointerdown", cancel);
    window.removeEventListener("keydown", cancel);
    window.removeEventListener("focusin", focused);
  };
  const cancel = () => {
    request.state = "cancelled";
    detach();
  };
  const focused = (event: FocusEvent) => {
    if (event.target !== heading) cancel();
  };
  const attempt = () => {
    const active = document.activeElement;
    if (heading?.isConnected) {
      if (active !== heading) cancel();
      return;
    }
    if (
      active !== document.body &&
      !(request.state === "pending" && active === request.opener)
    ) {
      cancel();
      return;
    }
    const next = container.querySelector<HTMLElement>("h1");
    if (!next || next.closest("[hidden],[inert]")) return;
    heading = next;
    heading.tabIndex = -1;
    heading.classList.add("outline-none");
    heading.focus({ preventScroll: true });
    if (document.activeElement === heading) {
      request.state = "completed";
      // The entry window starts with the first heading, so slow initial data reads still work.
      timer ??= setTimeout(detach, RESTORE_WINDOW_MS);
    }
  };
  const observer = new MutationObserver(attempt);
  observer.observe(container, { childList: true, subtree: true });
  window.addEventListener("pointerdown", cancel, { once: true });
  window.addEventListener("keydown", cancel, { once: true });
  window.addEventListener("focusin", focused);
  attempt();
  // Effect cleanup detaches this visit without reviving or cancelling the shared request.
  return detach;
}

/** Back or Forward gives focus back to the saved control. Scroll is the shell's to restore. */
export function restorePageFocus(
  container: HTMLElement | null | undefined,
  saved: PageFocus | null | undefined
): () => void {
  if (!container || !saved) return () => {};
  if ("kind" in saved) return focusPageEntry(container, saved);
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
  if (document.activeElement === document.body) {
    observer = new MutationObserver(attempt);
    observer.observe(container, { childList: true, subtree: true });
    timer = setTimeout(stop, RESTORE_WINDOW_MS);
    window.addEventListener("pointerdown", stop, { once: true });
    window.addEventListener("keydown", stop, { once: true });
  }
  return stop;
}
