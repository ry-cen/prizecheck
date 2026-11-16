import {
  createContext,
  useContext,
  useEffect,
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

/** How long a toast with no action stays up before it leaves on its own. */
export const TOAST_LIFETIME_MS = 5_000;

export type ToastInput = {
  message: string;
  /** False when an inline live region already announces this feedback. The toast and its actions remain available. */
  announce?: boolean;
  /** Optional route lifetime for plain informational feedback: the toast leaves when the page is no longer this
   * pathname. Without one, a toast with no action leaves on the first pathname change after it is drawn. */
  route?: string;
  /** Keep a toast that has no action up until it is dismissed or replaced. For a failure or an outcome the
   * collector has to read and that the page shows nowhere else. Toasts with an action already stay. */
  sticky?: boolean;
  /** Runs when the toast leaves on its own (its time is up, or the page changed), not when it is dismissed,
   * replaced or taken down in code, so its owner can forget it. */
  onExpire?: () => void;
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
  /** Monotonic show version, including notifications not yet rendered or already dismissed. */
  getVersion: () => number;
  /** Shows the toast, replacing the one on screen, and returns its id. */
  show: (toast: ToastInput) => number;
  /** Changes the toast with this id in place, without moving focus. Does nothing once it was replaced. */
  update: (id: number, toast: ToastInput) => void;
  /** Takes the toast down. With an id, only while that toast is the one on screen. */
  dismiss: (id?: number) => void;
  /** Whether the toast with this id is still the one on screen (a newer one replaces it). */
  isShown: (id: number) => boolean;
  /** Focuses the first usable button of the toast with this id. False when it isn't on screen. */
  focus: (id: number) => boolean;
  /** Raises the toast this many px for one bottom bar, so it clears them all: it rises by the sum of every
   * source's lift. 0 takes that source's lift away. */
  setLift: (source: LiftSource, px: number) => void;
};

/** The bottom bars that raise the toast, lowest first: Collection's Actions strip, then the Borrow Request
 * drafts tray (#252), which sits above the strip. */
export type LiftSource = "selection" | "drafts";

type Lifts = Partial<Record<LiftSource, number>>;

const ToastContext = createContext<ToastApi | null>(null);
// Apart from ToastContext, so a lift that changes never changes the toast API that effects depend on.
const LiftContext = createContext<Lifts>({});
const ToastClearanceContext = createContext(0);

/** Measured toast height plus the bottom bars beneath it, while feedback is visible. */
export function useToastClearance(): number {
  return useContext(ToastClearanceContext);
}

const ShownToastContext = createContext<number | null>(null);

/** Subscribe inline toast controls to replacement and dismissal without changing the stable toast API. */
export function useShownToastId(): number | null {
  return useContext(ShownToastContext);
}

/** The app's one toast host. Call it from anything inside ToastProvider. */
export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error("useToast needs a ToastProvider");
  return api;
}

/** The px one bottom bar has raised the toast by (0 when none): the drafts tray sits that far above the strip. */
export function useLift(source: LiftSource): number {
  return useContext(LiftContext)[source] ?? 0;
}

/** Focus the shown page's heading (its main region when it has none), as the skip link does. */
function focusPage() {
  const main = document.getElementById("main-content");
  const target = main?.querySelector<HTMLElement>("h1") ?? main;
  if (!target) return;
  if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
  target.focus({ preventScroll: true });
}

const ACTION =
  "inline-flex h-control cursor-pointer items-center whitespace-nowrap rounded-control border-0 bg-transparent px-3 font-sans text-control hover:bg-surface-selected disabled:cursor-default disabled:font-normal disabled:text-text-muted aria-disabled:cursor-progress aria-disabled:opacity-60 phone:min-h-tap";

/**
 * One toast host for the app (ADR 0012): one toast at a time, and a new one replaces it, so its action
 * (Undo) always belongs to the message beside it. A toast with an action stays until it is replaced, dismissed or
 * its action is used (unless the action keeps it open). One with no action (and not `sticky`) is a confirmation: it
 * leaves after TOAST_LIFETIME_MS, and when the pathname changes. It sits at the bottom centre, above the phone tab bar
 * and above every bottom bar that has set a lift (setLift: the Actions strip and the drafts tray, added up). The host is a "Notifications" region that stays mounted
 * while empty, so each new message is announced; it has no status role, so pages' own status lines stay
 * the only ones. A toast that replaces one holding focus takes the focus over, so it never falls to the
 * page.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  // `rev` is new on every show and update (one counter): the expiry timer and the page the toast started from begin again.
  const [toast, setToast] = useState<
    (ToastInput & { id: number; rev: number }) | null
  >(null);
  const [lifts, setLifts] = useState<Lifts>({});
  // Shell renders this provider on navigation. Only callers that explicitly opt in lose their feedback on leaving.
  const path = window.location.pathname;
  const visible =
    toast && (!toast.route || toast.route === path) ? toast : null;
  const lift = Object.values(lifts).reduce((sum, px) => sum + (px ?? 0), 0);
  const [height, setHeight] = useState(0);
  const next = useRef(0);
  const host = useRef<HTMLElement>(null);
  const shownId = useRef<number | null>(null);
  shownId.current = visible?.id ?? null;
  const latest = useRef(toast);
  latest.current = toast;
  const revision = useRef(0);
  // The pathname the toast is judged against: the one it was first drawn on, so a toast shown just before its own
  // navigation (Deleted, Removed, Added) survives it.
  const baseline = useRef<{ rev: number; path: string } | null>(null);
  const expires =
    !!toast && !toast.action && !toast.secondaryAction && !toast.sticky;
  const api = useMemo<ToastApi>(() => {
    const firstButton = () =>
      host.current?.querySelector<HTMLButtonElement>("button:not(:disabled)");
    return {
      getVersion: () => next.current,
      show: (input) => {
        const id = ++next.current;
        const focus =
          !!input.focus || !!host.current?.contains(document.activeElement);
        setToast({ ...input, focus, id, rev: ++revision.current });
        return id;
      },
      update: (id, input) =>
        setToast((current) =>
          current?.id === id
            ? { ...input, focus: current.focus, id, rev: ++revision.current }
            : current
        ),
      dismiss: (id) =>
        setToast((current) =>
          id === undefined || current?.id === id ? null : current
        ),
      isShown: (id) => shownId.current === id,
      focus: (id) => {
        if (shownId.current !== id) return false;
        const button = firstButton();
        button?.focus();
        return !!button;
      },
      setLift: (source, px) =>
        setLifts((current) =>
          (current[source] ?? 0) === px ? current : { ...current, [source]: px }
        ),
    };
  }, []);

  useLayoutEffect(() => {
    if (toast?.route && toast.route !== path) setToast(null);
  }, [toast, path]);

  // A toast with no action leaves when the pathname changes (not for a query or hash change). A toast with a route
  // follows that route instead, and one with an action stays.
  useLayoutEffect(() => {
    if (!toast) {
      baseline.current = null;
      return;
    }
    if (baseline.current?.rev !== toast.rev) {
      baseline.current = { rev: toast.rev, path };
      return;
    }
    if (expires && !toast.route && baseline.current.path !== path) {
      setToast(null);
      toast.onExpire?.();
    }
  }, [toast, path, expires]);

  // ...and after a while. Focus inside the toast (Dismiss, after `focus`) would fall to the page, so it goes to the
  // page heading first, as the skip link does.
  useEffect(() => {
    if (!toast || !expires) return;
    const { id, rev } = toast;
    const timer = window.setTimeout(() => {
      const current = latest.current;
      if (current?.id !== id || current.rev !== rev) return;
      if (host.current?.contains(document.activeElement)) focusPage();
      setToast(null);
      current.onExpire?.();
    }, TOAST_LIFETIME_MS);
    return () => window.clearTimeout(timer);
  }, [toast?.id, toast?.rev, expires]);

  // A new toast that asked for focus (or replaced one that had it) takes it as soon as it is drawn.
  useLayoutEffect(() => {
    if (visible?.focus)
      host.current
        ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
        ?.focus();
  }, [visible?.id]);

  useLayoutEffect(() => {
    const element = host.current;
    if (!visible || !element) {
      setHeight(0);
      return;
    }
    const measure = () => setHeight(element.getBoundingClientRect().height);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [visible?.id]);

  const press = (action: ToastAction) => {
    if (action.disabled || action.busy) return;
    if (!action.keepOpen) setToast(null);
    action.onAction();
  };

  return (
    <ToastContext.Provider value={api}>
      <LiftContext.Provider value={lifts}>
        <ShownToastContext.Provider value={visible?.id ?? null}>
          <ToastClearanceContext.Provider value={visible ? height + lift : 0}>
            {children}
          </ToastClearanceContext.Provider>
        </ShownToastContext.Provider>
      </LiftContext.Provider>
      <section
        ref={host}
        id="app-toasts"
        aria-label="Notifications"
        aria-live={visible?.announce === false ? "off" : "polite"}
        style={{ "--toast-lift": `${lift}px` } as CSSProperties}
        className="pointer-events-none fixed inset-x-0 bottom-[calc(var(--space-6)+var(--toast-lift))] z-(--layer-toast) flex justify-center px-4 font-sans phone:bottom-[calc(var(--layout-tabbar-height)+var(--space-2)+var(--toast-lift))] phone:px-2"
      >
        {visible && toast && (
          <div
            key={toast.id}
            className="pointer-events-auto box-border flex min-h-control max-w-140 items-center gap-2 rounded-panel border border-border-strong bg-surface-raised py-1 pl-4 pr-1 text-control text-text phone:w-full phone:max-w-full phone:flex-wrap phone:pl-3"
          >
            <p className="m-0 min-w-0 grow tabular-nums phone:basis-40">
              {toast.message}
            </p>
            <span className="ml-auto flex shrink-0 items-center gap-1">
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
