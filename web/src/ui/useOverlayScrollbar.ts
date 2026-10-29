import { useEffect, type RefObject } from "react";
import {
  scrollPosForDrag,
  thumbGeometry,
  type ScrollMetrics,
} from "./scrollGeometry";

export type Orientation = "y" | "x";

/** How long the thumb stays bright after the last scroll. */
const ACTIVE_MS = 900;

type Options = {
  /** The scrolling element, or "document" for the page (document.scrollingElement). */
  target: RefObject<HTMLElement | null> | "document";
  orientation: Orientation;
  /** The rail (the track) and the thumb inside it. Both are drawn by the caller; this hook only sizes and moves them. */
  rail: RefObject<HTMLElement | null>;
  thumb: RefObject<HTMLElement | null>;
  /** False leaves everything untouched (the phone policy, or a rail that is not rendered). */
  enabled: boolean;
};

function modalOpen(): boolean {
  try {
    if (document.querySelector("dialog:modal")) return true;
  } catch {
    if (document.querySelector("dialog[open]")) return true;
  }
  return getComputedStyle(document.body).overflow === "hidden";
}

/**
 * Keeps an app-drawn scroll bar in step with a scroll container (#399): sizes and places the thumb from
 * the container's scroll size, visible size and position, lets a drag on the thumb
 * scroll it, and shows the rail only while the container can scroll. The container keeps scrolling
 * natively (wheel, touch, keyboard, find-in-page); the rail is an extra, aria-hidden handle.
 *
 * It measures in one animation frame per burst of scrolls, resizes (the container and its children) and
 * DOM changes under the container, and writes the thumb's style directly, so scrolling re-renders nothing.
 */
export function useOverlayScrollbar({
  target,
  orientation,
  rail: railRef,
  thumb: thumbRef,
  enabled,
}: Options): void {
  useEffect(() => {
    const rail = railRef.current;
    const thumb = thumbRef.current;
    if (!enabled || !rail || !thumb) return;
    const isDocument = target === "document";
    const vertical = orientation === "y";
    const scroller = (): HTMLElement | null =>
      isDocument
        ? ((document.scrollingElement as HTMLElement | null) ??
          document.documentElement)
        : target.current;
    const first = scroller();
    if (!first) return;
    // The page's scroll events fire on the document, an element's on itself.
    const eventTarget: EventTarget = isDocument ? window : first;

    const metrics = (): ScrollMetrics | null => {
      const el = scroller();
      if (!el) return null;
      return vertical
        ? {
            scrollSize: el.scrollHeight,
            clientSize: el.clientHeight,
            scrollPos: el.scrollTop,
            trackSize: rail.clientHeight,
          }
        : {
            scrollSize: el.scrollWidth,
            clientSize: el.clientWidth,
            scrollPos: el.scrollLeft,
            trackSize: rail.clientWidth,
          };
    };
    const setScroll = (pos: number) => {
      const el = scroller();
      if (!el) return;
      if (vertical) el.scrollTop = pos;
      else el.scrollLeft = pos;
    };

    let frame = 0;
    const update = () => {
      frame = 0;
      // Behind a modal dialog (it locks the page's scroll) the page's rail is not drawn.
      const behindModal = isDocument && modalOpen();
      // The rail must be shown to be measured: its length is the track.
      if (rail.hidden) rail.hidden = false;
      const m = behindModal ? null : metrics();
      const g = m ? thumbGeometry(m) : null;
      if (!g || !g.scrollable) {
        rail.hidden = true;
        return;
      }
      if (vertical) {
        thumb.style.height = `${g.size}px`;
        thumb.style.transform = `translateY(${g.offset}px)`;
      } else {
        thumb.style.width = `${g.size}px`;
        thumb.style.transform = `translateX(${g.offset}px)`;
      }
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };

    let activeTimer: ReturnType<typeof setTimeout> | undefined;
    const onScroll = () => {
      rail.dataset.active = "";
      clearTimeout(activeTimer);
      activeTimer = setTimeout(() => {
        delete rail.dataset.active;
      }, ACTIVE_MS);
      schedule();
    };
    eventTarget.addEventListener("scroll", onScroll, { passive: true });
    // A textarea's value is not DOM content: its typing and pasting are the signal.
    first.addEventListener("input", schedule);

    // A mouse over the region fades the thumb in, like a macOS overlay bar; the page's rail shows while it scrolls.
    const onEnter = (event: PointerEvent) => {
      if (event.pointerType !== "mouse") return;
      rail.dataset.hover = "";
      // Measure as the thumb fades in, in case the content changed without a signal (a hidden tab, a late font).
      schedule();
    };
    const onLeave = () => {
      delete rail.dataset.hover;
    };
    if (!isDocument) {
      first.addEventListener("pointerenter", onEnter);
      first.addEventListener("pointerleave", onLeave);
    }

    // Resizes of the container and of what it holds (the content's height changes without any scroll)...
    const resize = new ResizeObserver(schedule);
    const watched = new Set<Element>();
    const watchContent = () => {
      const wanted = new Set<Element>();
      if (isDocument) {
        wanted.add(document.documentElement);
        wanted.add(document.body);
        for (const child of Array.from(document.body.children))
          wanted.add(child);
      } else {
        const el = scroller();
        if (el) {
          wanted.add(el);
          for (const child of Array.from(el.children)) wanted.add(child);
        }
      }
      // Children that left (or were removed with their parent) are released, so a long-lived page holds none.
      for (const element of Array.from(watched)) {
        if (!wanted.has(element) || !element.isConnected) {
          resize.unobserve(element);
          watched.delete(element);
        }
      }
      for (const element of wanted) {
        if (!watched.has(element)) {
          watched.add(element);
          resize.observe(element);
        }
      }
    };
    watchContent();
    // ...and added or removed content, which can also open or close a dialog (the page's rail hides then).
    const content = new MutationObserver((records) => {
      // The rails' own thumb style changes are not content changes.
      if (
        records.every(
          (record) =>
            record.target instanceof Element &&
            record.target.closest("[data-overlay-scrollbar]")
        )
      )
        return;
      watchContent();
      schedule();
    });
    const root = isDocument ? document.body : first;
    content.observe(root, {
      childList: true,
      subtree: true,
      // Typing in a text box that grows its text changes the scroll size without any child changing.
      characterData: true,
      // A dialog opening or closing.
      attributes: isDocument,
      attributeFilter: isDocument ? ["open"] : undefined,
    });
    // The scroll lock is body's own style (not its descendants').
    const lock = new MutationObserver(schedule);
    if (isDocument)
      lock.observe(document.body, {
        attributes: true,
        attributeFilter: ["style"],
      });
    window.addEventListener("resize", schedule);
    schedule();

    // Dragging the thumb. The rail itself takes no pointer events, so it never steals a click from the content.
    let drag: { id: number; startPointer: number; startScroll: number } | null =
      null;
    const pointerOf = (event: PointerEvent) =>
      vertical ? event.clientY : event.clientX;
    const onDown = (event: PointerEvent) => {
      if (event.button !== 0 || !event.isPrimary) return;
      const m = metrics();
      if (!m) return;
      drag = {
        id: event.pointerId,
        startPointer: pointerOf(event),
        startScroll: m.scrollPos,
      };
      thumb.setPointerCapture(event.pointerId);
      rail.dataset.dragging = "";
      event.preventDefault();
    };
    const onMove = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.id) return;
      const m = metrics();
      if (!m) return;
      setScroll(
        scrollPosForDrag(
          m,
          drag.startScroll,
          pointerOf(event) - drag.startPointer
        )
      );
    };
    const onEnd = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.id) return;
      if (thumb.hasPointerCapture(event.pointerId))
        thumb.releasePointerCapture(event.pointerId);
      drag = null;
      delete rail.dataset.dragging;
    };
    // A lost capture (the element was removed, the window lost focus) ends the drag like a release.
    const onLost = () => {
      drag = null;
      delete rail.dataset.dragging;
    };
    thumb.addEventListener("pointerdown", onDown);
    thumb.addEventListener("pointermove", onMove);
    thumb.addEventListener("pointerup", onEnd);
    thumb.addEventListener("pointercancel", onEnd);
    thumb.addEventListener("lostpointercapture", onLost);

    return () => {
      if (frame) cancelAnimationFrame(frame);
      clearTimeout(activeTimer);
      eventTarget.removeEventListener("scroll", onScroll);
      first.removeEventListener("input", schedule);
      if (!isDocument) {
        first.removeEventListener("pointerenter", onEnter);
        first.removeEventListener("pointerleave", onLeave);
      }
      window.removeEventListener("resize", schedule);
      resize.disconnect();
      watched.clear();
      content.disconnect();
      lock.disconnect();
      thumb.removeEventListener("pointerdown", onDown);
      thumb.removeEventListener("pointermove", onMove);
      thumb.removeEventListener("pointerup", onEnd);
      thumb.removeEventListener("pointercancel", onEnd);
      thumb.removeEventListener("lostpointercapture", onLost);
      delete rail.dataset.active;
      delete rail.dataset.dragging;
      delete rail.dataset.hover;
    };
  }, [target, orientation, railRef, thumbRef, enabled]);
}
