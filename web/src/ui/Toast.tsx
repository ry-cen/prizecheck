import {
  createContext,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { X } from "lucide-react";
import { Icon } from "./Icon";

export type ToastInput = {
  message: string;
  /** One action on the thing the message names, for example Undo. */
  action?: { label: string; onAction: () => void };
};

type ToastApi = {
  /** Shows the toast, replacing the one on screen. */
  show: (toast: ToastInput) => void;
  dismiss: () => void;
};

const ToastContext = createContext<ToastApi | null>(null);

/** The app's one toast host. Call it from anything inside ToastProvider. */
export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error("useToast needs a ToastProvider");
  return api;
}

/**
 * One toast host for the app (ADR 0012): one toast at a time, and a new one replaces it, so its action
 * (Undo) always belongs to the message beside it. A toast stays until it is replaced, dismissed or its
 * action is used. It sits at the bottom centre, above the phone tab bar. The live region stays mounted
 * while empty so each new message is announced; it has no status role, so pages' own status lines stay
 * the only ones.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<(ToastInput & { id: number }) | null>(
    null
  );
  const next = useRef(0);
  const api = useMemo<ToastApi>(
    () => ({
      show: (input) => setToast({ ...input, id: ++next.current }),
      dismiss: () => setToast(null),
    }),
    []
  );
  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-6 z-(--layer-toast) flex justify-center px-4 phone:bottom-[calc(var(--layout-tabbar-height)+var(--space-2))] phone:px-2"
      >
        {toast && (
          <div
            key={toast.id}
            className="pointer-events-auto flex min-h-control max-w-full items-center gap-2 rounded-panel border border-border-strong bg-surface-raised py-1 pl-4 pr-1 text-control text-text"
          >
            <p className="m-0 min-w-0">{toast.message}</p>
            {toast.action && (
              <button
                type="button"
                className="inline-flex h-control cursor-pointer items-center rounded-control border-0 bg-transparent px-3 text-control font-semibold text-accent-strong hover:bg-surface-selected phone:min-h-tap"
                onClick={() => {
                  const action = toast.action!;
                  setToast(null);
                  action.onAction();
                }}
              >
                {toast.action.label}
              </button>
            )}
            <button
              type="button"
              aria-label="Dismiss"
              className="inline-flex size-control cursor-pointer items-center justify-center rounded-control border-0 bg-transparent p-0 text-text-muted hover:bg-surface-selected hover:text-text phone:size-tap"
              onClick={() => setToast(null)}
            >
              <Icon icon={X} />
            </button>
          </div>
        )}
      </div>
    </ToastContext.Provider>
  );
}
