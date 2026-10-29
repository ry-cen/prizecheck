/**
 * The overlay scroll bar's arithmetic (#399), with no DOM in it. A region scrolls `scrollSize - clientSize`
 * pixels; the track is as long as the rail; the thumb is the visible share of the content, at least `minThumb`
 * long, and travels `trackSize - thumbSize` pixels while the content travels the whole scroll range. All sizes
 * are along one axis, in CSS pixels.
 */

/** The shortest thumb, so it stays easy to grab on a very long page. */
export const MIN_THUMB = 28;
/** Browsers round scroll sizes; a region that overflows by less than this is not scrollable. */
export const SCROLL_EPSILON = 1;

export type ScrollMetrics = {
  /** scrollHeight (or scrollWidth): the content's full length. */
  scrollSize: number;
  /** clientHeight (or clientWidth): the visible length. */
  clientSize: number;
  /** scrollTop (or scrollLeft): how far the content is scrolled. */
  scrollPos: number;
  /** The rail's length: the room the thumb can travel in. */
  trackSize: number;
};

export type ThumbGeometry = {
  /** False when there is nothing to scroll or no room to draw: the rail is hidden. */
  scrollable: boolean;
  /** The thumb's length. */
  size: number;
  /** The thumb's distance from the start of the track. */
  offset: number;
};

const NONE: ThumbGeometry = { scrollable: false, size: 0, offset: 0 };

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function finite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

/** The farthest the content can scroll. */
export function maxScroll({ scrollSize, clientSize }: ScrollMetrics): number {
  return Math.max(0, scrollSize - clientSize);
}

/** The thumb's size and place for a scroll position. A position outside the range (an elastic overscroll) is clamped. */
export function thumbGeometry(
  m: ScrollMetrics,
  minThumb: number = MIN_THUMB
): ThumbGeometry {
  if (!finite(m.clientSize) || !finite(m.trackSize) || !finite(m.scrollSize))
    return NONE;
  const range = maxScroll(m);
  if (range <= SCROLL_EPSILON) return NONE;
  const size = clamp(
    (m.trackSize * m.clientSize) / m.scrollSize,
    Math.min(minThumb, m.trackSize),
    m.trackSize
  );
  const travel = m.trackSize - size;
  const offset = travel * (clamp(m.scrollPos, 0, range) / range);
  return { scrollable: true, size, offset };
}

/** The scroll position after dragging the thumb `delta` pixels from a drag that began at `startScrollPos`. */
export function scrollPosForDrag(
  m: ScrollMetrics,
  startScrollPos: number,
  delta: number,
  minThumb: number = MIN_THUMB
): number {
  const g = thumbGeometry(m, minThumb);
  const range = maxScroll(m);
  if (!g.scrollable) return clamp(startScrollPos, 0, range);
  const travel = m.trackSize - g.size;
  if (travel <= 0) return clamp(startScrollPos, 0, range);
  return clamp(startScrollPos + (delta * range) / travel, 0, range);
}
