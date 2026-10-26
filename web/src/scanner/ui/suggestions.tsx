// The Scan Suggestion (#319), as the scanner screen sees it. A `suggest` lock is an image-only match that needs the
// collector's yes: the screen hands it to `onSuggest`, tells `onAbsent` when the card leaves the guide, renders
// `SuggestionSlot` in the camera area and greys the shutter while `useSuggestionOpen()` is true. The logic is in
// suggestion/controller.ts; the card is in suggestion/SuggestionPanel.tsx.
import { useEffect, useRef, useSyncExternalStore, type RefObject } from "react";
import { SHUTTER } from "./copy";
import {
  createSuggestions,
  type SuggestionHost,
  type SuggestLock,
} from "./suggestion/controller";
import { SuggestionPanel } from "./suggestion/SuggestionPanel";

export type { SuggestionHost, SuggestLock };

/** One suggestion at a time lives on the scanner page, so one controller serves it. */
const suggestions = createSuggestions();

export function onSuggest(lock: SuggestLock, host: SuggestionHost): void {
  void suggestions.onSuggest(lock, host);
}

export function onAbsent(lockId: number): void {
  suggestions.absent(lockId);
}

/** True while a suggestion shows: the shutter is disabled then. */
export function useSuggestionOpen(): boolean {
  return (
    useSyncExternalStore(suggestions.subscribe, suggestions.getView) !== null
  );
}

/**
 * The suggestion card inside the camera area. Focus moves to its first candidate when it opens and back to the shutter
 * when it closes (unless search or another dialog took focus meanwhile).
 */
export function SuggestionSlot({
  returnTo,
}: {
  returnTo: RefObject<HTMLElement | null>;
}) {
  const view = useSyncExternalStore(suggestions.subscribe, suggestions.getView);
  const first = useRef<HTMLButtonElement>(null);
  const was = useRef(false);
  const open = view !== null;
  useEffect(() => {
    if (open && !was.current) first.current?.focus();
    if (!open && was.current) {
      const now = document.activeElement;
      if (!now || now === document.body)
        (
          returnTo.current ??
          document.querySelector<HTMLElement>(`[aria-label="${SHUTTER}"]`)
        )?.focus({ preventScroll: true });
    }
    was.current = open;
  }, [open, returnTo]);
  if (!view) return null;
  return (
    <SuggestionPanel
      key={view.lockId}
      view={view}
      firstRef={first}
      onPick={(id) => void suggestions.pick(id)}
      onNone={() => suggestions.none()}
    />
  );
}
