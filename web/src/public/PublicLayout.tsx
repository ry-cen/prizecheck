import type { ReactNode } from "react";
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
 * decks and Sign in) over a dark page. Published Deck, Discover, sign-in, unavailable and not found share it.
 */
export function PublicLayout({ current, onNavigate, children }: Props) {
  const follow = followLink(onNavigate);
  return (
    <div className="flex min-h-dvh flex-col bg-bg font-sans text-text scheme-dark">
      <header className="sticky top-0 z-(--layer-sticky) box-border flex h-header shrink-0 items-center gap-4 border-b border-border bg-bg px-7 compact:px-5 phone:gap-2 phone:px-3">
        <Wordmark />
        <nav
          aria-label="Public pages"
          className="ml-auto flex items-center gap-2"
        >
          <a
            href={DISCOVER_PATH}
            aria-current={current === "discover" ? "page" : undefined}
            onClick={follow}
            className={QUIET}
          >
            Discover decks
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
