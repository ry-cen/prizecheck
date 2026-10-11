import React from "react";
import type { ToastState } from "./useInventoryActions";
import "./InventoryActions.css";

type Props = {
  toast: ToastState | null;
  busy: boolean;
  onUndo: () => void;
  onDismiss: () => void;
  onClose: () => void;
  toastRef: React.RefObject<HTMLDivElement | null>;
};

/** The success and Undo toast, in the bottom dock above the selection bar. The status line stays
 * mounted (empty while idle) so screen readers announce each new message. Undo applies the newest
 * record; one the API refused shows as unavailable and can be dismissed to reach an older one. */
export function UndoToast({
  toast,
  busy,
  onUndo,
  onDismiss,
  onClose,
  toastRef,
}: Props) {
  const entry = toast?.entry ?? null;
  return (
    <div ref={toastRef} className={`ws-toast${toast ? "" : " ws-toast-idle"}`}>
      <p className="ws-toast-text" role="status">
        {toast?.message ?? ""}
      </p>
      {toast && (
        <span className="ws-toast-actions">
          {entry &&
            (toast.unavailable ? (
              <>
                <button type="button" disabled>
                  Undo unavailable
                </button>
                <button
                  type="button"
                  onClick={onDismiss}
                  aria-disabled={busy || undefined}
                >
                  Dismiss Undo
                </button>
              </>
            ) : (
              <button
                type="button"
                className="ws-toast-undo"
                onClick={onUndo}
                aria-disabled={busy || undefined}
              >
                Undo
              </button>
            ))}
          <button
            type="button"
            className="ws-toast-close"
            aria-label="Close notice"
            onClick={onClose}
          >
            <span aria-hidden="true">✕</span>
          </button>
        </span>
      )}
    </div>
  );
}
