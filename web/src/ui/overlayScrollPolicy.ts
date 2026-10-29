import { useSyncExternalStore } from "react";

/**
 * Where the app draws its own scroll bar (#399): any device with a mouse or trackpad as its main pointer, at
 * every window width, so a narrow desktop window never shows a browser bar either. There the browser's scroll
 * bar is hidden in base.css, whose @media rule must carry this same query text (overlayScrollPolicy.test.ts
 * checks it), and ScrollArea draws the replacement. Phones and tablets, whose bars are already overlays, keep
 * the browser's own scrolling and get no rail.
 */
export const OVERLAY_SCROLLBAR_QUERY = "(hover: hover) and (pointer: fine)";

function subscribe(notify: () => void): () => void {
  if (typeof matchMedia !== "function") return () => {};
  const query = matchMedia(OVERLAY_SCROLLBAR_QUERY);
  query.addEventListener("change", notify);
  return () => query.removeEventListener("change", notify);
}

function snapshot(): boolean {
  return (
    typeof matchMedia === "function" &&
    matchMedia(OVERLAY_SCROLLBAR_QUERY).matches
  );
}

/** True while the browser's scroll bars are hidden and the app draws its own. */
export function useOverlayScrollbars(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => false);
}
