import { useLayoutEffect, useRef, type ReactNode } from "react";
import { Wordmark } from "../shell/Shell";
import { PriceCredit } from "../ui/PriceCredit";
import { PRIMARY, QUIET } from "./controls";
import { DISCOVER_PATH, followLink, SIGN_IN_PATH } from "./publicRoutes";

type Props = {
  /** The page being shown, when it has a link in the header. The sign-in screen leaves Sign in out. */
  current?: "discover" | "sign-in";
  onNavigate: (to: string) => void;
  /** The page, which draws its own <main>. */
  children: ReactNode;
};

/**
 * The signed-out frame (spec "The shell", "Signed-out pages"): the slim public header (the wordmark, Discover
 * decks and Sign in) over a dark page. The header is one 64 px row; when its items don't fit (text enlarged on a
 * phone) the links wrap onto a second row rather than push the page sideways. Published Deck, Discover, sign-in,
 * unavailable and not found share it.
 */
export function PublicLayout({ current, onNavigate, children }: Props) {
  const follow = followLink(onNavigate);
  const header = useRef<HTMLElement>(null);
  // The page's overlay scroll bar (DocumentScrollbar) starts below this sticky header, and a control scrolled into
  // view by focus stops below it, at the header's height now: one row is the 64 px header, and enlarged text wraps
  // the links onto a second row. Both go when the signed-out frame does.
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.publicShell = "";
    const measure = () =>
      root.style.setProperty(
        "--public-header-height",
        `${header.current!.offsetHeight}px`
      );
    measure();
    root.style.setProperty("scroll-padding-top", "var(--public-header-height)");
    const observer = new ResizeObserver(measure);
    observer.observe(header.current!);
    return () => {
      observer.disconnect();
      delete root.dataset.publicShell;
      root.style.removeProperty("--public-header-height");
      root.style.removeProperty("scroll-padding-top");
    };
  }, []);
  return (
    <div className="flex min-h-dvh flex-col bg-bg font-sans text-text scheme-dark">
      <header
        ref={header}
        className="sticky top-0 z-(--layer-sticky) box-border flex min-h-header shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b border-border bg-bg px-7 py-2 compact:px-5 phone:gap-x-2 phone:px-3"
      >
        <Wordmark />
        <nav
          aria-label="Public pages"
          className="ml-auto flex max-w-full flex-wrap items-center gap-2 phone:[&>a]:px-2"
        >
          <a
            href={DISCOVER_PATH}
            aria-current={current === "discover" ? "page" : undefined}
            onClick={follow}
            className={QUIET}
          >
            {/* Under 360 px the wordmark, both links and the margins don't fit in one row: the link shows Discover
             * and keeps Discover decks as its name, so the header stays one row at the usual text size. */}
            <span>
              Discover<span className="max-[22.5rem]:sr-only"> decks</span>
            </span>
          </a>
          {current !== "sign-in" && (
            <a href={SIGN_IN_PATH} onClick={follow} className={PRIMARY}>
              Sign in
            </a>
          )}
        </nav>
      </header>
      {children}
      <PriceCredit className="shrink-0" />
    </div>
  );
}
