import React, {
  Suspense,
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
  type ReactNode,
} from "react";
import { Button } from "../ui/Button";
import { PageHeader } from "./PageHeader";

/** How long a loading page shows nothing before its card-shaped placeholders appear. */
const PAGE_PLACEHOLDER_DELAY_MS = 300;

export type PageStandIn = "loading" | "failed";

/**
 * The shell provides this around each page, to hear when the page area shows a stand-in (its code still loading,
 * past the placeholder delay, or failed to load) instead of the page. Collection draws its own phone header, so the
 * shell draws its own while Collection shows a stand-in. Outside the shell (the public layout, the `other` slot),
 * the value is `null` and nothing is reported.
 */
export const PageStandInContext = createContext<
  ((standIn: PageStandIn, shown: boolean) => void) | null
>(null);

type BoundaryProps = { resetKey: string; children: ReactNode };
type BoundaryState = { failed: boolean; resetKey: string };

class PageBoundary extends React.Component<BoundaryProps, BoundaryState> {
  static contextType = PageStandInContext;
  declare context: React.ContextType<typeof PageStandInContext>;

  state = { failed: false, resetKey: this.props.resetKey };

  static getDerivedStateFromProps(
    props: { resetKey: string },
    state: { resetKey: string }
  ) {
    return props.resetKey !== state.resetKey
      ? { failed: false, resetKey: props.resetKey }
      : null;
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  // Reports state only and logs nothing, because React already logs caught errors.
  componentDidCatch() {
    this.context?.("failed", true);
  }

  componentDidUpdate(_props: BoundaryProps, previous: BoundaryState) {
    if (previous.failed && !this.state.failed) this.context?.("failed", false);
  }

  componentWillUnmount() {
    if (this.state.failed) this.context?.("failed", false);
  }

  render() {
    return this.state.failed ? <PageLoadFailed /> : this.props.children;
  }
}

function PageLoadFailed() {
  return (
    <main className="mx-auto box-border flex w-full min-w-0 max-w-3xl flex-col gap-4 px-7 py-7 phone:px-4 phone:py-5">
      <PageHeader title="This page didn't load" />
      <p role="alert" className="m-0 text-body text-text-muted">
        Reload to try again. If that doesn't work, check your connection.
      </p>
      <div>
        <Button variant="primary" onClick={() => window.location.reload()}>
          Reload
        </Button>
      </div>
    </main>
  );
}

/**
 * Card-shaped tiles while a page's code loads. They appear only after a delay, so a quick load shows nothing and
 * nothing flashes, as in LoadingScreen. They carry no role, label or text: a screen reader hears the page itself
 * once it arrives. Once late, it tells the shell, so Collection's loading view sits under the shell's phone header
 * like every other page.
 */
function PagePlaceholder() {
  const report = useContext(PageStandInContext);
  const [late, setLate] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(
      () => setLate(true),
      PAGE_PLACEHOLDER_DELAY_MS
    );
    return () => window.clearTimeout(timer);
  }, []);
  // A layout effect: the shell's header and the page arrive in the same paint, so two headers never show at once.
  useLayoutEffect(() => {
    if (!late || !report) return;
    report("loading", true);
    return () => report("loading", false);
  }, [late, report]);
  return (
    <div
      aria-hidden="true"
      className="mx-auto box-border flex w-full min-w-0 max-w-7xl flex-col gap-4 px-7 py-7 phone:px-4 phone:py-5"
    >
      {late && (
        <div className="flex flex-wrap gap-3">
          {[0, 1, 2, 3, 4, 5].map((tile) => (
            <div
              key={tile}
              className="block w-32 aspect-(--tile-aspect) rounded-card bg-[linear-gradient(135deg,var(--color-art-start),var(--color-art-end))]"
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The per-page boundary. While a page's code loads it shows card-shaped placeholders, and when the code fails to
 * load it shows a reload prompt. `resetKey` clears a failure when the collector moves elsewhere, and is a prop,
 * never a `key`, so kept-mounted pages keep their state.
 */
export function PageFrame({
  resetKey,
  children,
}: {
  resetKey: string;
  children: ReactNode;
}) {
  return (
    <PageBoundary resetKey={resetKey}>
      <Suspense fallback={<PagePlaceholder />}>{children}</Suspense>
    </PageBoundary>
  );
}
