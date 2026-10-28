import { useState } from "react";

// Pictures that failed to load in this page. A card is locked, counted and shown again in new components (the tray
// peek is keyed by count, the tray mounts its rows when it opens), so the memory lives here, not in a component: a
// missing picture asks the route once per page and every later mount draws the placeholder straight away. A transient
// failure therefore keeps the placeholder until the page is reloaded.
const failed = new Set<string>();

/** A card's small picture. The art is same-origin, from /api/art, so it needs no CORS under the scanner's cross-origin
 * isolation. When it fails (the route answers 404 for a card with no picture, 503 while it cannot fetch one) the plain placeholder shows and the
 * picture is not requested again. */
export function CardArt({
  src,
  size = "md",
}: {
  src: string | null;
  size?: "sm" | "md";
}) {
  const [, rerender] = useState(0);
  const box = size === "sm" ? "w-9" : "w-12";
  return src && !failed.has(src) ? (
    <img
      src={src}
      alt=""
      loading="lazy"
      onError={() => {
        failed.add(src);
        rerender((n) => n + 1);
      }}
      className={`${box} aspect-(--tile-aspect) shrink-0 rounded-card bg-surface-raised object-cover`}
    />
  ) : (
    <span
      aria-hidden="true"
      className={`${box} aspect-(--tile-aspect) shrink-0 rounded-card bg-linear-to-br from-art-start to-art-end`}
    />
  );
}
