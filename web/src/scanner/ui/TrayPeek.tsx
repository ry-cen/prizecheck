import { useEffect, useState, type Ref } from "react";
import { Button } from "../../ui/Button";
import { CardArt } from "./CardArt";
import { cardsText, EMPTY_PEEK, REVIEW, TRAY } from "./copy";
import type { RowView } from "./rowView";

/** The sheet's height closed: about 136 px, with the handle, the header and one row. */
export const PEEK_HEIGHT_PX = 136;

/** A swipe of this many px or more on the handle moves the sheet. */
const SWIPE_PX = 40;

/** Pointer handlers for a vertical swipe: `onUp` for a swipe up, `onDown` for one down. */
export function swipeHandlers(onUp?: () => void, onDown?: () => void) {
  let startY: number | null = null;
  return {
    onPointerDown: (event: React.PointerEvent) => {
      startY = event.clientY;
    },
    onPointerUp: (event: React.PointerEvent) => {
      if (startY === null) return;
      const dy = event.clientY - startY;
      startY = null;
      if (dy <= -SWIPE_PX) onUp?.();
      else if (dy >= SWIPE_PX) onDown?.();
    },
    onPointerCancel: () => {
      startY = null;
    },
  };
}

/** The row slides in from below the first moment it is drawn (a transition, so reduced motion ends it at once). */
function RiseIn({ children }: { children: React.ReactNode }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <div
      className={`transition-[transform,opacity] duration-(--motion-duration) ease-(--motion-ease) ${shown ? "translate-y-0 opacity-100" : "translate-y-3 opacity-0"}`}
    >
      {children}
    </div>
  );
}

/** The tray closed: handle, "Tray", the total, Review and the last-touched row. There is no confirm here. */
export function TrayPeek({
  total,
  last,
  reviewRef,
  onReview,
}: {
  total: number;
  last: { key: string; view: RowView; count: number } | null;
  reviewRef: Ref<HTMLButtonElement>;
  onReview: () => void;
}) {
  return (
    <section
      aria-label={TRAY}
      style={{ height: PEEK_HEIGHT_PX }}
      className="box-border flex shrink-0 flex-col gap-2 rounded-t-dialog border-x border-t border-border-strong bg-surface px-4 pb-2 pt-1"
    >
      <div
        {...swipeHandlers(onReview)}
        className="flex touch-none flex-col items-center gap-1"
      >
        <span
          aria-hidden="true"
          className="h-1 w-10 rounded-round bg-border-strong"
        />
        <div className="flex w-full items-center gap-3">
          <h2 className="m-0 text-body font-semibold text-text">{TRAY}</h2>
          <span className="grow text-body tabular-nums text-text-muted">
            {total > 0 ? cardsText(total) : "Empty"}
          </span>
          <Button ref={reviewRef} onClick={onReview}>
            {REVIEW}
          </Button>
        </div>
      </div>
      {last ? (
        <RiseIn key={last.key}>
          <button
            type="button"
            onClick={onReview}
            className="box-border flex min-h-control w-full cursor-pointer items-center gap-3 rounded-control border-0 bg-transparent p-0 text-left font-sans text-text phone:min-h-tap"
          >
            <CardArt src={last.view.image} size="sm" />
            <span className="flex min-w-0 grow flex-col">
              <span className="truncate text-control font-semibold">
                {last.view.name}
              </span>
              <span className="truncate text-meta text-text-muted">
                {last.view.setLine}
                {last.view.finish ? ` · ${last.view.finish}` : ""}
              </span>
            </span>
            <span className="text-body font-semibold tabular-nums">
              ×{last.count}
            </span>
          </button>
        </RiseIn>
      ) : (
        <p className="m-0 text-meta text-text-muted">{EMPTY_PEEK}</p>
      )}
    </section>
  );
}
