import { useLayoutEffect, useRef, type ReactNode } from "react";
import { ScrollArea } from "./ScrollArea";
import "./list-detail.css";

/** Presentation only: callers own selection, reads and navigation. */
export function ListDetailLayout({
  selected,
  queue,
  detail,
}: {
  selected: boolean;
  queue: ReactNode;
  detail: ReactNode;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const scrollTop = useRef(0);
  useLayoutEffect(() => {
    const restore = () => {
      if (viewport.current?.offsetParent) {
        viewport.current.scrollTop = scrollTop.current;
      }
    };
    restore();
    window.addEventListener("resize", restore);
    return () => window.removeEventListener("resize", restore);
  }, [selected]);
  return (
    <main className="list-detail" data-selected={selected}>
      <div className="list-detail-queue">
        <ScrollArea
          viewportRef={viewport}
          className="list-detail-scroll"
          viewportClassName="list-detail-viewport"
          viewportProps={{
            onScroll: () => {
              if (viewport.current?.offsetParent)
                scrollTop.current = viewport.current.scrollTop;
            },
          }}
        >
          {queue}
        </ScrollArea>
      </div>
      <div className="list-detail-content">{detail}</div>
    </main>
  );
}
