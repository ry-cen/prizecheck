import { modalOpenerOf } from "../ui/modalOpener";
import { RESTORE_WINDOW_MS } from "./restorePageScroll";

/** The control that had focus when a history entry was left: the element itself, and how to find its remounted twin. */
export type SavedFocus = {
  element: Element;
  tag: string;
  href: string | null;
  name: string;
  /** A closing dialog can return to a persistent shell control outside the page. */
  outsidePage?: boolean;
  /** The control that opened the modal dialog this focus was in, when it was in one. */
  modalOpener?: Element;
};

export type PageEntryFocus = {
  kind: "heading";
  state: "pending" | "completed" | "cancelled";
  opener: Element | null;
  /** The opener of the modal dialog this navigation started in, or null when it started outside one. Focus the
   * closing dialog returns there counts like `opener`; focus anywhere else still cancels. */
  modalOpener: Element | null;
  historyFocus?: SavedFocus;
};

const modalHistoryFocus = new WeakMap<Element, SavedFocus>();

const entryFocusCleanup = new WeakMap<PageEntryFocus, () => void>();

/** One request per pushed entry. Replacements share its lifecycle, never a fresh exemption. */
export function createPageEntryFocus(): PageEntryFocus {
  let state: PageEntryFocus["state"] = "pending";
  const request: PageEntryFocus = {
    kind: "heading",
    get state() {
      return state;
    },
    set state(next) {
      state = next;
      // Route changes can settle a request without rerunning the Shell effect.
      if (next !== "pending") entryFocusCleanup.get(request)?.();
    },
    opener: document.activeElement,
    modalOpener: null,
    historyFocus: document.activeElement
      ? modalHistoryFocus.get(document.activeElement)
      : undefined,
  };
  const modalOpener = request.historyFocus?.modalOpener;
  if (request.historyFocus && modalOpener) {
    request.modalOpener = modalOpener;
    // The dialog control saved on departure is about to disappear. Back returns to the dialog's own opener,
    // named explicitly, even if the page hides it before the dialog could return focus to it.
    Object.assign(request.historyFocus, {
      element: modalOpener,
      tag: modalOpener.tagName,
      href: modalOpener.getAttribute("href"),
      name: nameOf(modalOpener),
      outsidePage: true,
      modalOpener: undefined,
    });
  }
  return request;
}

export type PageFocus = SavedFocus | PageEntryFocus;

const nameOf = (element: Element) => {
  const label = element.getAttribute("aria-label");
  if (label !== null) return label.trim();
  // Descriptive tile facts can change during a read; aria-hidden text is not part of the control's name.
  const named = element.cloneNode(true) as Element;
  named
    .querySelectorAll('[aria-hidden="true"]')
    .forEach((child) => child.remove());
  return (named.textContent ?? "").trim();
};

/** What had focus, unless nothing in particular did. */
export function saveFocus(): SavedFocus | null {
  const element = document.activeElement;
  if (!element || element === document.body) return null;
  const saved: SavedFocus = {
    element,
    tag: element.tagName,
    href: element.getAttribute("href"),
    name: nameOf(element),
  };
  const modalOpener = modalOpenerOf(element);
  if (modalOpener) {
    saved.modalOpener = modalOpener;
    modalHistoryFocus.set(element, saved);
  }
  return saved;
}

function find(container: HTMLElement, saved: SavedFocus): HTMLElement | null {
  if (
    saved.element.isConnected &&
    (container.contains(saved.element) || saved.outsidePage)
  )
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

function entryHeading(container: HTMLElement): HTMLElement | "loading" | null {
  const heading = [...container.querySelectorAll<HTMLElement>("h1")].find(
    (element) => !element.closest("[hidden],[inert]")
  );
  if (!heading) return null;
  return heading.matches('[data-page-heading="loading"]') ? "loading" : heading;
}

/** Pending until the page's first visible H1 is ready (not marked `data-page-heading="loading"`); no timer.
 * Interaction, focus elsewhere, or effect cleanup by a new navigation end it. */
function focusPageEntry(
  container: HTMLElement,
  request: PageEntryFocus
): () => void {
  if (request.state !== "pending") return () => {};
  let target: HTMLElement | null = null;
  let detached = false;
  const detach = () => {
    if (detached) return;
    detached = true;
    if (entryFocusCleanup.get(request) === detach)
      entryFocusCleanup.delete(request);
    observer.disconnect();
    window.removeEventListener("pointerdown", cancel, true);
    window.removeEventListener("keydown", cancel, true);
    window.removeEventListener("wheel", cancel, true);
    window.removeEventListener("focusin", focused, true);
  };
  const cancel = () => {
    request.state = "cancelled";
    detach();
  };
  const focused = (event: FocusEvent) => {
    if (event.target !== target) cancel();
  };
  const attempt = () => {
    if (detached || request.state !== "pending") {
      detach();
      return;
    }
    const active = document.activeElement;
    // Focus on the opener of the modal dialog this navigation started in is the dialog's own return, not the
    // collector's choice. Nothing else is inferred: any other focus move cancels.
    if (
      active &&
      active !== document.body &&
      !(request.opener?.isConnected && active === request.opener) &&
      active !== request.modalOpener
    ) {
      cancel();
      return;
    }
    const heading = entryHeading(container);
    if (!heading || heading === "loading") return;
    target = heading;
    heading.tabIndex = -1;
    heading.classList.add("outline-none");
    heading.focus({ preventScroll: true });
    if (request.state === "pending" && document.activeElement === heading) {
      request.state = "completed";
      detach();
    } else target = null;
  };
  const observer = new MutationObserver(attempt);
  observer.observe(container, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["data-page-heading", "hidden", "inert"],
  });
  window.addEventListener("pointerdown", cancel, true);
  window.addEventListener("keydown", cancel, true);
  window.addEventListener("wheel", cancel, { capture: true, passive: true });
  window.addEventListener("focusin", focused, true);
  entryFocusCleanup.set(request, detach);
  attempt();
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
