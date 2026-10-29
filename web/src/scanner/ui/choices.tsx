// The Scan Choice (#319), as the scanner screen sees it. Every lock goes to `onLock`: it is added directly, or a prompt
// asks for the version and finish (a `suggest` lock, a look-alike, or a card with several finishes). The screen tells
// `onAbsent` when the card leaves the guide, renders `ChoiceSlot` in the camera area and greys the shutter while
// `useChoiceOpen()` is true. The logic is in choice/controller.ts; the card is in choice/ChoicePanel.tsx.
import { useEffect, useRef, useSyncExternalStore, type RefObject } from "react";
import { SHUTTER } from "./copy";
import {
  createChoices,
  type ChoiceHost,
  type ChoiceLock,
} from "./choice/controller";
import { ChoicePanel } from "./choice/ChoicePanel";

export type { ChoiceHost, ChoiceLock };

/** One choice at a time lives on the scanner page, so one controller serves it. */
const choices = createChoices();

export function onLock(lock: ChoiceLock, host: ChoiceHost): void {
  void choices.onLock(lock, host);
}

/** Ends the pending lock and closes any prompt: the scanner session it belonged to is over. */
export function resetChoices(): void {
  choices.reset();
}

export function onAbsent(lockId: number): void {
  choices.absent(lockId);
}

/** True while a prompt shows: the shutter is disabled then. */
export function useChoiceOpen(): boolean {
  return useSyncExternalStore(choices.subscribe, choices.getView) !== null;
}

/**
 * The prompt inside the camera area. Focus moves to its first version button or finish chip when it opens and back to the shutter
 * when it closes (unless search or another dialog took focus meanwhile).
 */
export function ChoiceSlot({
  returnTo,
}: {
  returnTo: RefObject<HTMLElement | null>;
}) {
  const view = useSyncExternalStore(choices.subscribe, choices.getView);
  const first = useRef<HTMLUListElement>(null);
  const was = useRef(false);
  const open = view !== null;
  useEffect(() => {
    if (open && !was.current) first.current?.querySelector("button")?.focus();
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
    <ChoicePanel
      key={view.lockId}
      view={view}
      listRef={first}
      onPick={(id, edition) => void choices.pick(view.lockId, id, edition)}
      onNone={() => choices.none(view.lockId)}
    />
  );
}
