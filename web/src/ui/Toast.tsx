import {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { X } from "lucide-react";
import { Icon } from "./Icon";

export type ToastAction = {
  label: string;
  onAction: () => void;
  /** Shown but can't be used (a disabled button), for example "Undo unavailable". */
  disabled?: boolean;
  /** The page is still working on an earlier press: the button keeps its focus but ignores presses. */
  busy?: boolean;
  /** Keep the toast up after a press. The caller replaces or dismisses it once its work settles (Undo). */
  keepOpen?: boolean;
};

export type ToastInput = {
  message: string;
  /** One action on the thing the message names, for example Undo. */
  action?: ToastAction;
  /** A second, quieter action after it, for example Dismiss Undo. */
  secondaryAction?: ToastAction;
  /** Runs after the collector presses Dismiss; not when the toast is replaced or dismissed in code. */
  onDismiss?: () => void;
  /** Move focus to the toast's first usable button when it appears. */
  focus?: boolean;
};

type ToastApi = {
  /** Shows the toast, replacing the one on screen, and returns its id. */
  show: (toast: ToastInput) => number;
  /** Changes the toast with this id in place, without moving focus. Does nothing once it was replaced. */
  update: (id: number, toast: ToastInput) => void;
  /** Takes the toast down. With an id, only while that toast is the one on screen. */
  dismiss: (id?: number) => void;
  /** Focuses the first usable button of the toast with this id. False when it isn't on screen. */
  focus: (id: number) => boolean;
  /** Raises the toast this many px above its usual place, so it clears a page's own bottom bar
   * (Collection's Actions strip). 0 puts it back. */
  setLift: (px: number) => void;
};

const ToastContext = createContext<ToastApi | null>(null);

/** The app's one toast host. Call it from anything inside ToastProvider. */
export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error("useToast needs a ToastProvider");
  return api;
}

const ACTION =
  "inline-flex h-control cursor-pointer items-center whitespace-nowrap rounded-control border-0 bg-transparent px-3 font-sans text-control hover:bg-surface-selected disabled:cursor-default disabled:font-normal disabled:text-text-muted aria-disabled:cursor-progress aria-disabled:opacity-60 phone:min-h-tap";

/**
 * One toast host for the app (ADR 0012): one toast at a time, and a new one replaces it, so its action
 * (Undo) always belongs to the message beside it. A toast stays until it is replaced, dismissed or its
 * action is used (unless the action keeps it open). It sits at the bottom centre, above the phone tab bar
 * and above a page's own bottom bar (setLift). The host is a "Notifications" region that stays mounted
 * while empty, so each new message is announced; it has no status role, so pages' own status lines stay
 * the only ones. A toast that replaces one holding focus takes the focus over, so it never falls to the
 * page.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<(ToastInput & { id: number }) | null>(
    null
  );
  const [lift, setLift] = useState(0);
  const next = useRef(0);
  const host = useRef<HTMLElement>(null);
  const shownId = useRef<number | null>(null);
  shownId.current = toast?.id ?? null;
  const api = useMemo<ToastApi>(() => {
    const firstButton = () =>
      host.current?.querySelector<HTMLButtonElement>("button:not(:disabled)");
    return {
      show: (input) => {
        const id = ++next.current;
        const focus =
          !!input.focus || !!host.current?.contains(document.activeElement);
        setToast({ ...input, focus, id });
        return id;
      },
      update: (id, input) =>
        setToast((current) =>
          current?.id === id ? { ...input, focus: current.focus, id } : current
        ),
      dismiss: (id) =>
        setToast((current) =>
          id === undefined || current?.id === id ? null : current
        ),
      focus: (id) => {
        if (shownId.current !== id) return false;
        const button = firstButton();
        button?.focus();
        return !!button;
      },
      setLift,
    };
  }, []);

  // A new toast that asked for focus (or replaced one that had it) takes it as soon as it is drawn.
  useLayoutEffect(() => {
    if (toast?.focus)
      host.current
        ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
        ?.focus();
  }, [toast?.id]);

  const press = (action: ToastAction) => {
    if (action.disabled || action.busy) return;
    if (!action.keepOpen) setToast(null);
    action.onAction();
  };

  return (
    <ToastContext.Provider value={api}>
      {children}
      <section
        ref={host}
        aria-label="Notifications"
        aria-live="polite"
        style={{ "--toast-lift": `${lift}px` } as CSSProperties}
        className="pointer-events-none fixed inset-x-0 bottom-[calc(var(--space-6)+var(--toast-lift))] z-(--layer-toast) flex justify-center px-4 font-sans phone:bottom-[calc(var(--layout-tabbar-height)+var(--space-2)+var(--toast-lift))] phone:px-2"
      >
        {toast && (
          <div
            key={toast.id}
            className="pointer-events-auto box-border flex min-h-control max-w-140 flex-wrap items-center gap-2 rounded-panel border border-border-strong bg-surface-raised py-1 pl-4 pr-1 text-control text-text phone:w-full phone:max-w-full phone:pl-3"
          >
            <p className="m-0 min-w-0 grow basis-40 tabular-nums">
              {toast.message}
            </p>
            <span className="flex shrink-0 items-center gap-1">
              {toast.action && (
                <button
                  type="button"
                  disabled={toast.action.disabled}
                  aria-disabled={toast.action.busy || undefined}
                  className={`${ACTION} font-semibold text-accent-strong`}
                  onClick={() => press(toast.action!)}
                >
                  {toast.action.label}
                </button>
              )}
              {toast.secondaryAction && (
                <button
                  type="button"
                  disabled={toast.secondaryAction.disabled}
                  aria-disabled={toast.secondaryAction.busy || undefined}
                  className={`${ACTION} text-text`}
                  onClick={() => press(toast.secondaryAction!)}
                >
                  {toast.secondaryAction.label}
                </button>
              )}
              <button
                type="button"
                aria-label="Dismiss"
                className="inline-flex size-control cursor-pointer items-center justify-center rounded-control border-0 bg-transparent p-0 text-text-muted hover:bg-surface-selected hover:text-text phone:size-tap"
                onClick={() => {
                  const { onDismiss } = toast;
                  setToast(null);
                  onDismiss?.();
                }}
              >
                <Icon icon={X} />
              </button>
            </span>
          </div>
        )}
      </section>
    </ToastContext.Provider>
  );
}
