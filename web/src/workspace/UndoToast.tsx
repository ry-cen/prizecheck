import { useEffect, useRef } from "react";
import { useToast, useShownToastId, type ToastInput } from "../ui/Toast";
import type { ToastState } from "./useInventoryActions";

type Options = {
  toast: ToastState | null;
  busy: boolean;
  /** False while another page is shown, or a sheet or drawer covers Collection: the toast leaves with
   * Collection and comes back with it, still offering its Undo. */
  shown: boolean;
  /** The host id of Collection's notice while it is drawn, for useInventoryActions' notice turn. */
  hostNotice: { current: number | null };
  onSuperseded: (stateId: number) => void;
  onUndo: () => void;
  onDismiss: () => void;
  onClose: () => void;
};

/**
 * Collection's success and Undo toast (ticket 107) on the kit's one toast host (#165). useInventoryActions
 * owns the toast's state; this shows it, changes it in place while it stays the same toast (Undo arriving,
 * busy, expiry), and takes it down. Undo applies the newest record; one the API refused shows as
 * "Undo unavailable" with "Dismiss Undo" to reach an older one. Dismiss closes the notice. A toast from
 * elsewhere in the app replaces it, and the next action here replaces that. Returns `focus`, which moves
 * focus to the toast's first usable button (for the skip link) and says whether it could.
 */
export function useUndoToast({
  toast,
  busy,
  shown,
  hostNotice,
  onSuperseded,
  onUndo,
  onDismiss,
  onClose,
}: Options) {
  const kit = useToast();
  const shownId = useShownToastId();
  const live = useRef({ onUndo, onDismiss, onClose, onSuperseded });
  live.current = { onUndo, onDismiss, onClose, onSuperseded };
  // The kit toast that shows `toast`, and which state it shows.
  const current = useRef<{ kitId: number; stateId: number } | null>(null);
  // The newest state whose request for focus was honoured: a toast shown again (back on Collection)
  // doesn't take focus a second time.
  const focused = useRef(0);
  const published = useRef(0);

  useEffect(() => {
    if (!toast || !shown) {
      if (current.current) kit.dismiss(current.current.kitId);
      current.current = null;
      hostNotice.current = null;
      return;
    }
    const entry = toast.entry;
    const input: ToastInput = {
      message: toast.message,
      action: !entry
        ? undefined
        : toast.unavailable
          ? { label: "Undo unavailable", onAction: () => {}, disabled: true }
          : {
              label: "Undo",
              onAction: () => live.current.onUndo(),
              busy,
              keepOpen: true,
            },
      secondaryAction:
        entry && toast.unavailable
          ? {
              label: "Dismiss Undo",
              onAction: () => live.current.onDismiss(),
              busy,
              keepOpen: true,
            }
          : undefined,
      onDismiss: () => live.current.onClose(),
      focus: !!toast.focus && toast.id > focused.current,
    };
    if (toast.focus) focused.current = Math.max(focused.current, toast.id);
    if (current.current?.stateId === toast.id)
      kit.update(current.current.kitId, input);
    else {
      if (toast.since !== undefined && toast.id > published.current) {
        const now = kit.getVersion();
        if (now !== toast.since && now !== hostNotice.current) {
          published.current = toast.id;
          current.current = { kitId: 0, stateId: toast.id };
          live.current.onSuperseded(toast.id);
          return;
        }
      }
      current.current = { kitId: kit.show(input), stateId: toast.id };
      hostNotice.current = current.current.kitId;
      published.current = Math.max(published.current, toast.id);
    }
  }, [toast, busy, shown, kit]);

  // Signing out unmounts Collection: its toast goes with it.
  useEffect(
    () => () => {
      if (current.current) kit.dismiss(current.current.kitId);
      current.current = null;
      hostNotice.current = null;
    },
    [kit]
  );

  return {
    shown: shownId !== null && shownId === current.current?.kitId,
    focus: () => !!current.current && kit.focus(current.current.kitId),
  };
}
