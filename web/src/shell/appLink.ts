import type React from "react";

/** Intercept only navigation that stays in this page; let the browser handle other activations. */
export function isPlainClick(
  event: React.MouseEvent<HTMLAnchorElement>
): boolean {
  return (
    !event.defaultPrevented &&
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey &&
    (!event.currentTarget.target || event.currentTarget.target === "_self")
  );
}
