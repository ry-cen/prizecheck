import React, {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { EditionPrice } from "../EditionPrice";
import { Button } from "../ui/Button";
import { CopyTile } from "../ui/CopyTile";
import { variantLabel } from "../ui/variantLabel";
import {
  computeLayout,
  readTileMetrics,
  tileAt,
  tileKey,
  tileLabel,
  tileRect,
  tileTitle,
  type DisplayPrefs,
  type GalleryData,
  type GalleryHolding,
  type GridLayout,
  type TileMetrics,
  type TileRef,
} from "./galleryModel";
import { isTileSelected, marqueeSpans, type Selection } from "./selectionModel";
import type { MarqueeEvent, TileGesture } from "./useSelection";

// The tile's price line: the existing EditionPrice component's compact form, on one line cut with an ellipsis,
// in the tile's colours. EditionPrice.css reaches only the old pages (#166), so these are the only rules here.
const TILE_PRICE =
  "block [&_.edition-price]:block [&_.edition-price]:truncate [&_.edition-price]:text-text-subtle [&_.edition-price_strong]:font-semibold [&_.edition-price_strong]:text-text [&_.edition-price-line]:flex [&_.edition-price-line]:min-w-0 [&_.edition-price-line]:whitespace-nowrap [&_.edition-price-amount]:min-w-0 [&_.edition-price-amount]:truncate [&_.edition-price-label]:shrink-0 [&_.edition-price-label]:whitespace-pre [&_.edition-price-sr]:sr-only";

type Props = {
  data: GalleryData;
  display: DisplayPrefs;
  /** True in All owned: each tile shows its source Location's name. */
  caption: boolean;
  /** The Location's own name, or undefined when the tree doesn't know it. */
  locationName: (id: string) => string | undefined;
  emptyMessage: string;
  onRetry: () => void;
  /** Ticket 105: the selection, mobile Select mode and the gestures that change them (see useSelection). */
  selected: Selection;
  selectMode: boolean;
  onTile: (tile: TileRef, gesture: TileGesture) => void;
  onHover: (tile: TileRef | null) => void;
  onMarquee: (event: MarqueeEvent) => void;
  /** Ticket 107: a press on a tile that may become a drag (see useTileDrag). Must be stable. */
  onTilePointerDown?: (
    tile: TileRef,
    event: React.PointerEvent<HTMLElement>
  ) => void;
};

/** Rows mounted beyond the viewport, as a fraction of the viewport height, above and below. */
const OVERSCAN_VIEWPORTS = 1;

/** A card-shaped placeholder: before the first page, and for tiles whose page hasn't arrived. */
const PLACEHOLDER =
  "absolute rounded-card bg-[linear-gradient(135deg,var(--color-art-start),var(--color-art-end))]";

/** A marquee starts selecting once the pointer has moved this far, so a click on empty space only clears. */
const MARQUEE_THRESHOLD_PX = 4;
/** While a marquee is held this close to the viewport's top or bottom edge, the window scrolls. */
const AUTOSCROLL_EDGE_PX = 48;
const AUTOSCROLL_MAX_STEP_PX = 24;
/** Targets that never start a marquee: tiles and every control. */
const NO_MARQUEE = "button, a, input, select, textarea, label";

/** The card gallery: one tile per copy, virtualized against the window's scroll position.
 * Only rows near the viewport are mounted; positions come from the layout model. */
export function Gallery({
  data,
  display,
  caption,
  locationName,
  emptyMessage,
  onRetry,
  selected,
  selectMode,
  onTile,
  onHover,
  onMarquee,
  onTilePointerDown,
}: Props) {
  const sectionRef = useRef<HTMLElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [metrics, setMetrics] = useState<TileMetrics | null>(null);
  const [rows, setRows] = useState({ first: 0, last: -1 });

  // The grid is always rendered, so its width and the CSS tile variables can be measured.
  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const measure = () => {
      // A hidden page (the app shell keeps Collection mounted under `hidden` while another page shows)
      // measures 0 wide. Keep the last layout, so coming back shows the same grid at the same height.
      if (!grid.getClientRects().length) return;
      setWidth(grid.clientWidth);
      const next = readTileMetrics(grid);
      setMetrics((previous) =>
        previous && JSON.stringify(previous) === JSON.stringify(next)
          ? previous
          : next
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(grid);
    return () => observer.disconnect();
  }, []);

  const loading = data.status === "loading";
  // Ticket 121: the grid's height when it last showed a listing (0 after an error). While the next one
  // loads, the grid keeps at least that height, so the page doesn't shrink to one viewport of
  // placeholders and grow back; it changes once, when the new totals arrive.
  const settledHeight = useRef(0);
  const layout: GridLayout | null = useMemo(() => {
    if (!metrics || width <= 0) return null;
    const base = computeLayout(width, 0, display, caption, metrics);
    // Before the first page: enough placeholder rows to fill the viewport.
    const tiles = loading
      ? base.columns *
        Math.max(2, Math.ceil(window.innerHeight / base.rowHeight))
      : (data.totals?.copies ?? 0);
    return computeLayout(width, tiles, display, caption, metrics);
  }, [metrics, width, display, caption, loading, data.totals]);
  useEffect(() => {
    if (layout && !loading)
      settledHeight.current = data.status === "error" ? 0 : layout.height;
  }, [layout, loading, data.status]);
  const gridHeight =
    !layout || data.status === "error"
      ? 0
      : loading
        ? Math.max(layout.height, settledHeight.current)
        : layout.height;

  // Mount only the rows within one viewport above and below the visible part of the grid.
  useLayoutEffect(() => {
    if (!layout) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const grid = gridRef.current;
      // Hidden (see measure above): keep the mounted rows for when the page is shown again.
      if (!grid || !grid.getClientRects().length) return;
      const top = grid.getBoundingClientRect().top;
      const viewport = window.innerHeight;
      const overscan = viewport * OVERSCAN_VIEWPORTS;
      const first = Math.max(
        0,
        Math.floor((-top - overscan) / layout.rowHeight)
      );
      const last = Math.min(
        layout.rows - 1,
        Math.floor((-top + viewport + overscan) / layout.rowHeight)
      );
      setRows((previous) =>
        previous.first === first && previous.last === last
          ? previous
          : { first, last }
      );
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [layout]);

  // Marquee: hit-tested against the layout model, so it reaches rows that aren't mounted. The window
  // can scroll during the drag (wheel or edge auto-scroll); each scroll re-tests with the last pointer position.
  const [band, setBand] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  const marquee = useRef<{
    pointerId: number;
    additive: boolean;
    /** Start point in grid coordinates. */
    x: number;
    y: number;
    clientX: number;
    clientY: number;
    moved: boolean;
    frame: number;
    stop: () => void;
  } | null>(null);
  const live = useRef({ layout, loadedCopies: data.loadedCopies, onMarquee });
  live.current = { layout, loadedCopies: data.loadedCopies, onMarquee };

  function updateMarquee() {
    const active = marquee.current;
    const grid = gridRef.current;
    const section = sectionRef.current;
    const { layout: model, loadedCopies } = live.current;
    if (!active || !grid || !section || !model) return;
    const gridBox = grid.getBoundingClientRect();
    const area = section.getBoundingClientRect();
    // The band stays inside the gallery area, so it never makes the page wider or taller.
    const clientX = Math.min(Math.max(active.clientX, area.left), area.right);
    const clientY = Math.min(Math.max(active.clientY, area.top), area.bottom);
    const x = clientX - gridBox.left;
    const y = clientY - gridBox.top;
    if (
      !active.moved &&
      Math.hypot(x - active.x, y - active.y) < MARQUEE_THRESHOLD_PX
    )
      return;
    active.moved = true;
    const rect = {
      left: Math.min(active.x, x),
      top: Math.min(active.y, y),
      right: Math.max(active.x, x),
      bottom: Math.max(active.y, y),
    };
    setBand({
      left: rect.left,
      top: rect.top,
      width: rect.right - rect.left,
      height: rect.bottom - rect.top,
    });
    live.current.onMarquee({
      phase: "move",
      additive: active.additive,
      spans: marqueeSpans(model, rect, loadedCopies),
    });
  }

  function endMarquee() {
    const active = marquee.current;
    if (!active) return;
    marquee.current = null;
    active.stop();
    setBand(null);
    live.current.onMarquee({
      phase: "end",
      additive: active.additive,
      spans: [],
    });
  }

  function startMarquee(event: React.PointerEvent<HTMLElement>) {
    // Touch scrolls the page; only a mouse or pen draws a marquee.
    if (event.button !== 0 || event.pointerType === "touch") return;
    if ((event.target as Element).closest(NO_MARQUEE)) return;
    const grid = gridRef.current;
    if (!grid || !layout || marquee.current) return;
    const gridBox = grid.getBoundingClientRect();
    const additive = event.ctrlKey || event.metaKey;
    const section = event.currentTarget;
    const pointerId = event.pointerId;
    section.setPointerCapture(pointerId);
    event.preventDefault();
    const tick = () => {
      const active = marquee.current;
      if (!active) return;
      const fromTop = active.clientY;
      const fromBottom = window.innerHeight - active.clientY;
      const step =
        fromTop < AUTOSCROLL_EDGE_PX
          ? -Math.ceil(
              ((AUTOSCROLL_EDGE_PX - fromTop) / AUTOSCROLL_EDGE_PX) *
                AUTOSCROLL_MAX_STEP_PX
            )
          : fromBottom < AUTOSCROLL_EDGE_PX
            ? Math.ceil(
                ((AUTOSCROLL_EDGE_PX - fromBottom) / AUTOSCROLL_EDGE_PX) *
                  AUTOSCROLL_MAX_STEP_PX
              )
            : 0;
      if (step && active.moved) window.scrollBy(0, step);
      active.frame = requestAnimationFrame(tick);
    };
    const onScroll = () => updateMarquee();
    window.addEventListener("scroll", onScroll, { passive: true });
    const state = {
      pointerId,
      additive,
      x: event.clientX - gridBox.left,
      y: event.clientY - gridBox.top,
      clientX: event.clientX,
      clientY: event.clientY,
      moved: false,
      frame: 0,
      stop: () => {
        window.removeEventListener("scroll", onScroll);
        cancelAnimationFrame(state.frame);
        if (section.hasPointerCapture(pointerId))
          section.releasePointerCapture(pointerId);
      },
    };
    marquee.current = state;
    state.frame = requestAnimationFrame(tick);
    onMarquee({ phase: "start", additive, spans: [] });
  }

  // Stop a marquee (and its listeners) if the gallery unmounts mid-drag.
  useEffect(
    () => () => {
      marquee.current?.stop();
      marquee.current = null;
    },
    []
  );

  // The tile that has keyboard focus stays mounted even when scrolled out of the window, so focus
  // isn't lost and Space still reaches it. Tracked by display index and Holding key.
  const [focused, setFocused] = useState<{ index: number; key: string } | null>(
    null
  );
  const focusTile = useCallback(
    (index: number, key: string) => setFocused({ index, key }),
    []
  );
  const blurTile = useCallback(
    (index: number) =>
      setFocused((current) => (current?.index === index ? null : current)),
    []
  );
  const focusedTile =
    focused && layout && !loading && focused.index < data.loadedCopies
      ? tileAt(data.holdings, focused.index)
      : null;
  const focusRenderable =
    !!focused &&
    !!focusedTile &&
    focusedTile.holding.key === focused.key &&
    focused.index < (data.totals?.copies ?? 0);
  // A reload or view change can remove the focused copy; the browser doesn't blur an unmounted tile.
  useEffect(() => {
    if (focused && !focusRenderable) {
      setFocused(null);
      onHover(null);
    }
  }, [focused, focusRenderable, onHover]);

  const renderCell = (index: number, layout: GridLayout) => {
    const rect = tileRect(layout, index);
    const tile =
      index < data.loadedCopies ? tileAt(data.holdings, index) : null;
    if (!tile) {
      return (
        <div
          key={`pending-${index}`}
          className={PLACEHOLDER}
          aria-hidden="true"
          style={{
            left: rect.x,
            top: rect.y,
            width: rect.width,
            height: layout.artHeight,
          }}
        />
      );
    }
    const { holding } = tile.holding;
    return (
      <Tile
        key={tileKey(holding.location_id, holding.edition_id, tile.ordinal)}
        entry={tile.holding}
        ordinal={tile.ordinal}
        index={index}
        selected={isTileSelected(selected, tile.holding.key, tile.ordinal)}
        onTile={onTile}
        onHover={onHover}
        onPointerDown={onTilePointerDown}
        onFocusTile={focusTile}
        onBlurTile={blurTile}
        left={rect.x}
        top={rect.y}
        width={rect.width}
        names={display.names}
        prices={display.prices}
        caption={
          caption
            ? (locationName(holding.location_id) ?? holding.location_name)
            : null
        }
        path={holding.location_path}
        selectMode={selectMode}
      />
    );
  };

  const cells: React.ReactNode[] = [];
  if (layout && !loading) {
    const start = rows.first * layout.columns;
    const end = Math.min(
      data.totals?.copies ?? 0,
      (rows.last + 1) * layout.columns
    );
    const pinned = focusRenderable ? focused.index : -1;
    if (pinned >= 0 && pinned < start) cells.push(renderCell(pinned, layout));
    for (let index = start; index < end; index++)
      cells.push(renderCell(index, layout));
    if (pinned >= end) cells.push(renderCell(pinned, layout));
  }

  const empty = data.status === "ready" && (data.totals?.copies ?? 0) === 0;
  return (
    <section
      ref={sectionRef}
      className="mt-6 min-h-12 select-none"
      aria-label="Cards"
      aria-busy={loading}
      onPointerDown={startMarquee}
      onPointerMove={(event) => {
        const active = marquee.current;
        if (!active || event.pointerId !== active.pointerId) return;
        active.clientX = event.clientX;
        active.clientY = event.clientY;
        updateMarquee();
      }}
      onPointerUp={endMarquee}
      onPointerCancel={endMarquee}
      onLostPointerCapture={endMarquee}
    >
      {data.error && (
        <div
          className="flex flex-col items-center gap-3 px-3 py-10 text-center text-text-muted"
          role="alert"
        >
          <p className="m-0">{data.error}</p>
          <Button onClick={onRetry}>Retry</Button>
        </div>
      )}
      {empty && (
        <p className="m-0 px-3 py-10 text-center text-text-muted">
          {emptyMessage}
        </p>
      )}
      <div ref={gridRef} className="relative" style={{ height: gridHeight }}>
        {loading && layout && (
          <div
            className="absolute inset-0"
            role="status"
            aria-label="Loading cards"
          >
            {Array.from(
              { length: layout.rows * layout.columns },
              (_, index) => {
                const rect = tileRect(layout, index);
                return (
                  <div
                    key={index}
                    className={PLACEHOLDER}
                    aria-hidden="true"
                    style={{
                      left: rect.x,
                      top: rect.y,
                      width: rect.width,
                      height: layout.artHeight,
                    }}
                  />
                );
              }
            )}
          </div>
        )}
        {cells}
        {band && (
          <div
            className="pointer-events-none absolute z-1 box-border border border-solid border-accent bg-accent-wash"
            aria-hidden="true"
            style={band}
          />
        )}
      </div>
    </section>
  );
}

type TileProps = {
  entry: GalleryHolding;
  ordinal: number;
  /** Display index. */
  index: number;
  selected: boolean;
  onTile: (tile: TileRef, gesture: TileGesture) => void;
  onHover: (tile: TileRef | null) => void;
  onPointerDown?: (
    tile: TileRef,
    event: React.PointerEvent<HTMLElement>
  ) => void;
  /** Keyboard focus entered or left this tile (display index, Holding key). */
  onFocusTile: (index: number, key: string) => void;
  onBlurTile: (index: number) => void;
  left: number;
  top: number;
  width: number;
  names: boolean;
  /** Ticket 111: show the Card Edition's price under the tile. Only mounted tiles render it, so only they request it. */
  prices: boolean;
  /** The source Location's name in All owned; null inside a Storage Leaf. */
  caption: string | null;
  path: string;
  /** Ticket 105: mobile Select mode, where a tap toggles; the page still scrolls vertically and zooms. */
  selectMode: boolean;
};

/** One copy: the kit's CopyTile as a toggle button (#164). Selected tiles show a dark gap, an accent ring
 * and a check badge. */
const Tile = memo(function Tile({
  entry,
  ordinal,
  index,
  selected,
  onTile,
  onHover,
  onPointerDown,
  onFocusTile,
  onBlurTile,
  left,
  top,
  width,
  names,
  prices,
  caption,
  path,
  selectMode,
}: TileProps) {
  const { holding } = entry;
  const priceId = useId();
  const ref = (): TileRef => ({ holding: entry, ordinal, index });
  return (
    <CopyTile
      absolute
      data-gallery-tile=""
      className={
        selectMode
          ? "touch-manipulation [-webkit-touch-callout:none]"
          : undefined
      }
      style={{ left, top, width }}
      label={tileLabel(holding, ordinal, path)}
      title={tileTitle(holding, ordinal, path)}
      name={holding.printing_name}
      setName={holding.set_name}
      collectorNumber={holding.collector_number}
      variant={variantLabel(holding.descriptor)}
      imageUrl={holding.image_url}
      names={names}
      selected={selected}
      price={
        prices ? (
          <span className={TILE_PRICE}>
            <EditionPrice compact editionId={holding.edition_id} />
          </span>
        ) : undefined
      }
      priceId={priceId}
      caption={caption}
      aria-describedby={prices ? priceId : undefined}
      onClick={(event) =>
        onTile(ref(), {
          kind: "click",
          toggle: event.ctrlKey || event.metaKey,
          range: event.shiftKey,
        })
      }
      onKeyDown={(event) => {
        // Space toggles; stop the button's own Space click, which would select this tile only.
        if (event.key !== " ") return;
        event.preventDefault();
        if (!event.repeat) onTile(ref(), { kind: "space" });
      }}
      onKeyUp={(event) => {
        if (event.key === " ") event.preventDefault();
      }}
      onPointerDown={(event) => onPointerDown?.(ref(), event)}
      onPointerEnter={(event) => {
        if (event.pointerType === "mouse") onHover(ref());
      }}
      onPointerLeave={(event) => {
        if (event.pointerType === "mouse") onHover(null);
      }}
      onFocus={() => {
        onFocusTile(index, entry.key);
        onHover(ref());
      }}
      onBlur={() => {
        onBlurTile(index);
        onHover(null);
      }}
    />
  );
});
