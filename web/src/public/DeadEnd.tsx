import { CARD, CENTRED_MAIN, PRIMARY, SECONDARY } from "./controls";
import { DISCOVER_PATH, followLink, SIGN_IN_PATH } from "./publicRoutes";

const COPY = {
  "not-found": {
    mark: "?",
    title: "Page not found",
    body: "The link may be mistyped, or the page has moved.",
  },
  unavailable: {
    mark: "⊘",
    title: "This deck isn't published anymore",
    body: "Its owner stopped sharing it, or the link changed. Published decks are snapshots, so an old link can stop working.",
  },
  // An Invite Link its collector replaced, or one that never existed (#246).
  invite: {
    mark: "⊘",
    title: "This link no longer works",
    body: "Ask whoever sent it for a new one.",
  },
} as const;

type Props = {
  kind: keyof typeof COPY;
  /** Signed in, the card sits inside the shell and offers no Sign in. */
  signedIn: boolean;
  onNavigate: (to: string) => void;
};

/**
 * Where an old link ends (spec "Unavailable" and "not found"): a centred card with somewhere to go next, Discover
 * decks first, then Sign in.
 */
export function DeadEnd({ kind, signedIn, onNavigate }: Props) {
  const follow = followLink(onNavigate);
  const copy = COPY[kind];
  return (
    <main className={CENTRED_MAIN}>
      <section
        aria-labelledby="dead-end-heading"
        className={`${CARD} items-center text-center`}
      >
        <span
          aria-hidden="true"
          className="grid size-12 place-items-center rounded-round border border-border-strong text-heading text-text-muted"
        >
          {copy.mark}
        </span>
        <h1 id="dead-end-heading" className="m-0 text-display font-semibold">
          {copy.title}
        </h1>
        <p className="m-0 text-body text-text-muted">{copy.body}</p>
        <div className="flex flex-wrap justify-center gap-2">
          <a href={DISCOVER_PATH} onClick={follow} className={PRIMARY}>
            Discover decks
          </a>
          {!signedIn && (
            <a href={SIGN_IN_PATH} onClick={follow} className={SECONDARY}>
              Sign in
            </a>
          )}
        </div>
      </section>
    </main>
  );
}
