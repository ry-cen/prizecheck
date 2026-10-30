import React, {
  useImperativeHandle,
  useRef,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import { useOverlayScrollbars } from "./overlayScrollPolicy";
import { useOverlayScrollbar, type Orientation } from "./useOverlayScrollbar";

// The rail takes no pointer events, so it never steals a click from the content under it; only the thumb does.
// The thumb is invisible while the region is idle (like a macOS overlay bar): 60% while a mouse is over the
// region, full while it scrolls, is dragged, or is itself hovered.
const RAIL =
  "pointer-events-none select-none data-[hover]:[&>div]:opacity-60 data-[active]:[&>div]:opacity-100 data-[dragging]:[&>div]:opacity-100 [&>div:hover]:opacity-100";
const THUMB =
  "pointer-events-auto absolute touch-none forced-color-adjust-none rounded-round bg-scroll-thumb opacity-0 transition-opacity duration-(--motion-duration)";

/** The rail and its thumb: aria-hidden and unfocusable, because the scrolling region keeps the keyboard. */
function Rail({
  railRef,
  thumbRef,
  orientation,
  className,
  kind,
}: {
  kind: "region" | "page";
  railRef: React.RefObject<HTMLDivElement | null>;
  thumbRef: React.RefObject<HTMLDivElement | null>;
  orientation: Orientation;
  className: string;
}) {
  return (
    <div
      ref={railRef}
      data-overlay-scrollbar={kind}
      hidden
      aria-hidden="true"
      className={`${RAIL} ${className}`}
    >
      <div
        ref={thumbRef}
        className={`${THUMB} ${
          orientation === "y"
            ? "inset-x-(--scroll-thumb-gap) top-0"
            : "inset-y-(--scroll-thumb-gap) left-0"
        }`}
      />
    </div>
  );
}

type Props = {
  children: ReactNode;
  /** Classes for the outer box that holds the viewport and the rail. Give it the size the region needs
   * (`min-h-0 flex-1` in a flex column, a max-height); sticky positioning goes on an element around it. */
  className?: string;
  /** Classes for the scrolling element itself: padding, gap, `overscroll-contain`. */
  viewportClassName?: string;
  /** The scrolling element, for code that reads or sets its scroll position, or uses it as an observer's root. */
  viewportRef?: React.Ref<HTMLDivElement>;
  /** Props for the scrolling element (role, aria-label, tabIndex, test ids). */
  viewportProps?: HTMLAttributes<HTMLDivElement> & { "data-testid"?: string };
  /** False renders a plain block: no overflow, no overscroll containment, no rail. For a panel that sometimes
   * scrolls the page instead of itself (a library below the phone breakpoint); the caller leaves out
   * `overscroll-contain` then, or a swipe over it would stop at the panel. True by default. */
  scroll?: boolean;
  /** The axis the overlay bar follows; "y" by default. */
  orientation?: Orientation;
  /** Let the content scroll on both axes (`overflow-auto`) while the bar follows `orientation`: a dialog body
   * that a wide child can overflow. The browser's bar for the other axis is hidden like the first. */
  bothAxes?: boolean;
};

/**
 * A scrolling region with the app's overlay scroll bar (#399), the one way to scroll inside a panel. The
 * browser's own bar is hidden on desktop (base.css), so it never takes width; this draws a thumb over the
 * region's edge instead (a sideways region keeps a rail-high strip under it, so the thumb never covers its content), only while the content overflows, and takes no layout space.
 *
 * Structure: an outer box (`relative`, a flex column for "y") holds the viewport, which has the overflow, and
 * the rail, a sibling of the viewport so it stays put while the content scrolls. The viewport still scrolls
 * natively. On phones and touch devices the rail is not rendered and the browser's scrolling is unchanged.
 */
export function ScrollArea({
  children,
  className = "",
  viewportClassName = "",
  viewportRef,
  viewportProps,
  scroll = true,
  orientation = "y",
  bothAxes = false,
}: Props) {
  const viewport = useRef<HTMLDivElement>(null);
  const rail = useRef<HTMLDivElement>(null);
  const thumb = useRef<HTMLDivElement>(null);
  const overlay = useOverlayScrollbars();
  useImperativeHandle(
    viewportRef,
    () => viewport.current as HTMLDivElement,
    []
  );
  useOverlayScrollbar({
    target: viewport,
    orientation,
    rail,
    thumb,
    enabled: overlay && scroll,
  });
  const vertical = orientation === "y";
  // min-h-0 lets a flex column shrink the region to its cap; a caller that sets its own minimum height wins.
  const minHeight = /(^|\s)min-h-/.test(className) ? "" : "min-h-0";
  return (
    <div
      className={`relative ${minHeight} min-w-0 ${vertical ? "flex flex-col" : overlay && scroll ? "pb-(--scroll-rail-size)" : ""} ${className}`}
    >
      <div
        {...viewportProps}
        ref={viewport}
        className={`relative min-h-0 min-w-0 ${
          !scroll
            ? ""
            : bothAxes
              ? `${vertical ? "flex-1 " : ""}overflow-auto`
              : vertical
                ? "flex-1 overflow-y-auto"
                : "overflow-x-auto"
        } ${viewportClassName}`}
      >
        {children}
      </div>
      {overlay && scroll && (
        <Rail
          kind="region"
          railRef={rail}
          thumbRef={thumb}
          orientation={orientation}
          className={
            vertical
              ? "absolute inset-y-0 right-0 w-(--scroll-rail-size)"
              : "absolute inset-x-0 bottom-0 h-(--scroll-rail-size)"
          }
        />
      )}
    </div>
  );
}

/**
 * The page's own overlay scroll bar, mounted once at the app's root (main.tsx). The page keeps scrolling
 * in document.scrollingElement; this rail is fixed to the window's right edge, and is hidden while a modal
 * dialog locks the page's scroll. Inside the app shell (the Shell sets data-app-shell on <html>) it starts below the
 * sticky header and, on a phone, ends above the bottom tab bar; signed-out screens have neither.
 */
export function DocumentScrollbar() {
  const rail = useRef<HTMLDivElement>(null);
  const thumb = useRef<HTMLDivElement>(null);
  const overlay = useOverlayScrollbars();
  useOverlayScrollbar({
    target: "document",
    orientation: "y",
    rail,
    thumb,
    enabled: overlay,
  });
  if (!overlay) return null;
  return (
    <Rail
      kind="page"
      railRef={rail}
      thumbRef={thumb}
      orientation="y"
      className="fixed top-0 right-0 bottom-0 z-(--layer-sticky) w-(--scroll-rail-size) in-data-[app-shell]:top-(--layout-sticky-top) in-data-[public-shell]:top-[var(--public-header-height,var(--spacing-header))] in-data-[app-shell]:phone:bottom-tabbar"
    />
  );
}

/**
 * An overlay scroll bar for an element that scrolls itself and is not a ScrollArea: a textarea, a <pre>. Render
 * it as a sibling of the element, inside a `relative` box that is the element's size (it sits on the right
 * edge, over the content). The element keeps its own overflow and its native scrolling.
 */
export function OverlayScrollbarFor({
  target,
  clearGrip = false,
}: {
  target: React.RefObject<HTMLElement | null>;
  /** The element is `resize-y`: the rail stops short of the resize grip in its bottom corner. */
  clearGrip?: boolean;
}) {
  const rail = useRef<HTMLDivElement>(null);
  const thumb = useRef<HTMLDivElement>(null);
  const overlay = useOverlayScrollbars();
  useOverlayScrollbar({
    target,
    orientation: "y",
    rail,
    thumb,
    enabled: overlay,
  });
  if (!overlay) return null;
  return (
    <Rail
      kind="region"
      railRef={rail}
      thumbRef={thumb}
      orientation="y"
      className={`absolute top-0 right-0 w-(--scroll-rail-size) ${clearGrip ? "bottom-3" : "bottom-0"}`}
    />
  );
}
