import React, { useLayoutEffect, useRef } from "react";
import { MOBILE_QUERY, useMediaQuery } from "./media";
import { X } from "lucide-react";
import { Button } from "../ui/Button";
import { STALE_MESSAGE } from "./useStaleCollection";

type Props = {
  /** Kept Collection pages remain mounted while another page is shown. */
  active: boolean;
  /** A newer owner revision was seen than the tiles or the tree came from. */
  stale: boolean;
  /** After Reload: why the selection was cleared, or "". */
  note: string;
  /** A Move, Removal or Undo is running; Reload waits for it. */
  busy: boolean;
  onReload: () => void;
  onDismissNote: () => void;
};

/** The slim stale-collection banner above the gallery (ticket 113). Its status line stays mounted,
 * empty while idle, so screen readers announce the banner and the note when they appear. */
export function StaleBanner({
  active,
  stale,
  note,
  busy,
  onReload,
  onDismissNote,
}: Props) {
  const text = stale ? STALE_MESSAGE : note;
  const banner = useRef<HTMLDivElement>(null);
  const phone = useMediaQuery(MOBILE_QUERY);
  useLayoutEffect(() => {
    const element = banner.current;
    if (!active || !phone || !text || !element) return;
    const root = document.documentElement;
    // The document scroller cannot inherit a variable from this descendant. Publish only while this
    // Collection is shown on a phone, including note text and changes in wrapping or text size.
    const measure = () =>
      root.style.setProperty(
        "--collection-stale-height",
        `${element.getBoundingClientRect().height}px`
      );
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
      root.style.removeProperty("--collection-stale-height");
    };
  }, [active, phone, text]);
  return (
    // A slim strip that stays in view, below the shell's sticky header, while the gallery scrolls. Idle, it
    // draws no box and its status line is visually hidden, but still announced when filled. The message is
    // text, never colour alone.
    <div
      ref={banner}
      data-collection-stale-banner=""
      className={
        text
          ? "sticky top-(--layout-sticky-top) z-(--layer-sticky) mt-3 box-border flex items-center gap-3 rounded-panel border border-accent-border bg-surface-raised py-1 pr-1 pl-4 phone:pl-3"
          : "flex items-center gap-3"
      }
    >
      <p className="m-0 flex-auto text-meta empty:sr-only" role="status">
        {text}
      </p>
      {stale ? (
        <Button
          className="shrink-0"
          onClick={onReload}
          aria-disabled={busy || undefined}
        >
          Reload
        </Button>
      ) : note ? (
        <Button
          variant="quiet"
          icon={X}
          label="Dismiss note"
          className="shrink-0"
          onClick={onDismissNote}
        />
      ) : null}
    </div>
  );
}
