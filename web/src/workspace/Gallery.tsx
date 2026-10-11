import React, {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { HoldingView } from "../holdings_generated";
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
  type GridLayout,
  type TileMetrics,
} from "./galleryModel";
import "./Gallery.css";

type Props = {
  data: GalleryData;
  display: DisplayPrefs;
  /** True in All owned: each tile shows its source Location's name. */
  caption: boolean;
  /** Full path such as "Shelf / Binder 2", or undefined when the tree doesn't know the Location. */
  locationPath: (id: string) => string | undefined;
  /** The Location's own name, or undefined when the tree doesn't know it. */
  locationName: (id: string) => string | undefined;
  emptyMessage: string;
  onRetry: () => void;
};

/** Rows mounted beyond the viewport, as a fraction of the viewport height, above and below. */
const OVERSCAN_VIEWPORTS = 1;

/** The card gallery: one tile per copy, virtualized against the window's scroll position.
 * Only rows near the viewport are mounted; positions come from the layout model. */
export function Gallery({
  data,
  display,
  caption,
  locationName,
  emptyMessage,
  onRetry,
}: Props) {
  const gridRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [metrics, setMetrics] = useState<TileMetrics | null>(null);
  const [rows, setRows] = useState({ first: 0, last: -1 });

  // The grid is always rendered, so its width and the CSS tile variables can be measured.
  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const measure = () => {
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

  // Mount only the rows within one viewport above and below the visible part of the grid.
  useLayoutEffect(() => {
    if (!layout) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const grid = gridRef.current;
      if (!grid) return;
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

  const cells: React.ReactNode[] = [];
  if (layout && !loading) {
    const end = Math.min(
      data.totals?.copies ?? 0,
      (rows.last + 1) * layout.columns
    );
    for (let index = rows.first * layout.columns; index < end; index++) {
      const rect = tileRect(layout, index);
      const tile =
        index < data.loadedCopies ? tileAt(data.holdings, index) : null;
      if (!tile) {
        cells.push(
          <div
            key={`pending-${index}`}
            className="ws-tile-placeholder"
            aria-hidden="true"
            style={{
              left: rect.x,
              top: rect.y,
              width: rect.width,
              height: layout.artHeight,
            }}
          />
        );
        continue;
      }
      const { holding } = tile.holding;
      cells.push(
        <Tile
          key={tileKey(holding.location_id, holding.edition_id, tile.ordinal)}
          holding={holding}
          ordinal={tile.ordinal}
          left={rect.x}
          top={rect.y}
          width={rect.width}
          names={display.names}
          caption={
            caption
              ? (locationName(holding.location_id) ?? holding.location_name)
              : null
          }
          path={holding.location_path}
        />
      );
    }
  }

  const empty = data.status === "ready" && (data.totals?.copies ?? 0) === 0;
  return (
    <section className="ws-gallery" aria-label="Cards" aria-busy={loading}>
      {data.error && (
        <div className="ws-gallery-error" role="alert">
          <p>{data.error}</p>
          <button type="button" onClick={onRetry}>
            Retry
          </button>
        </div>
      )}
      {empty && <p className="ws-gallery-empty">{emptyMessage}</p>}
      <div
        ref={gridRef}
        className="ws-gallery-grid"
        style={{
          height: layout && data.status !== "error" ? layout.height : 0,
        }}
      >
        {loading && layout && (
          <div
            className="ws-gallery-loading"
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
                    className="ws-tile-placeholder"
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
      </div>
    </section>
  );
}

type TileProps = {
  holding: HoldingView;
  ordinal: number;
  left: number;
  top: number;
  width: number;
  names: boolean;
  /** The source Location's name in All owned; null inside a Storage Leaf. */
  caption: string | null;
  path: string;
};

/** One copy. Ticket 105 adds selection (aria-pressed, the ring and check badge) and its handlers. */
const Tile = memo(function Tile({
  holding,
  ordinal,
  left,
  top,
  width,
  names,
  caption,
  path,
}: TileProps) {
  return (
    <button
      type="button"
      className="ws-tile"
      style={{ left, top, width }}
      aria-label={tileLabel(holding, ordinal, path)}
      title={tileTitle(holding, ordinal, path)}
    >
      <TileArt holding={holding} />
      {names && (
        <span className="ws-tile-names">
          <span className="ws-tile-name">{holding.printing_name}</span>
          <span className="ws-tile-set">
            {holding.set_name} · {holding.collector_number}
          </span>
        </span>
      )}
      {caption !== null && <span className="ws-tile-caption">{caption}</span>}
    </button>
  );
});

/** Card artwork, or the card's name on the artwork placeholder when there is no image or it fails. */
function TileArt({ holding }: { holding: HoldingView }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [holding.image_url]);
  return (
    <span className="ws-tile-art" aria-hidden="true">
      {holding.image_url && !failed ? (
        <img
          src={holding.image_url}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={() => setFailed(true)}
        />
      ) : (
        <span className="ws-tile-fallback">{holding.printing_name}</span>
      )}
    </span>
  );
}
