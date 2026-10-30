import { useId } from "react";
import { PRIMARY, SECONDARY } from "./controls";
import { DISCOVER_PATH, followLink, SIGN_IN_PATH } from "./publicRoutes";

const FEATURES = [
  {
    title: "Every copy has a place",
    description:
      "Arrange your boxes, binders and decks as Locations and move copies between them. The count on screen is the count you'd find if you opened the box.",
  },
  {
    title: "Decks made of real cards",
    description:
      "A Deck holds actual copies, so a card sleeved in one deck is never counted twice. Its Deck List shows what you own, where it's stored, and what's missing. Format checks for Standard, Expanded and more guide you without ever stopping you editing or moving cards.",
  },
  {
    title: "See what you still need",
    description:
      "The Want List gathers the cards your decks are missing, with an estimated cost before shipping and taxes, ready to copy into a store's cart.",
  },
  {
    title: "Lend, borrow and trade with friends",
    description:
      "Friends see each other's collections and Trade Lists, never your Location or deck names. Record a loan, agree a trade with cash if you like, and confirm the swap when you meet.",
  },
  {
    title: "Bring your cards with you",
    description:
      "Import another tracker's export or paste a decklist. Every line is matched to a card for you to check before anything is saved.",
  },
  {
    title: "Share a deck",
    description:
      "Publish a deck as a link, or list it in Discover for other players to browse and copy.",
  },
];

/**
 * The two ways a collector starts: a decklist they want on the table, or the cards they already have. Each opens the
 * real import page; signed out, that address shows the sign-in card in its place, and signing in opens it.
 */
const GOALS = [
  {
    title: "Import a deck",
    description:
      "Paste a decklist from Pokémon TCG Live or Limitless and check every line. Its Deck List then shows what you own, where it's stored and what's missing.",
    // Decklist Import (#212), the page Decks' Import a list opens.
    href: "/decks/import",
  },
  {
    title: "Add my cards",
    description:
      "Upload another tracker's export or paste a list, choose where the cards go, and review them before anything is added.",
    // Collection Import (#226), collectionImport/route.ts.
    href: "/collection/import",
  },
];

/** A whole-card link: its name is the goal, and the line under it is its description. */
function GoalLink({
  title,
  description,
  href,
  onClick,
}: (typeof GOALS)[number] & {
  onClick: ReturnType<typeof followLink>;
}) {
  const id = useId();
  return (
    <a
      href={href}
      onClick={onClick}
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-description`}
      className="box-border flex h-full flex-col gap-2 rounded-panel border border-border-strong bg-surface p-5 text-text no-underline hover:border-accent"
    >
      <span
        id={`${id}-title`}
        className="flex items-center justify-between gap-3 text-heading font-semibold"
      >
        {title}
        <span aria-hidden="true" className="text-accent-strong">
          ›
        </span>
      </span>
      <span
        id={`${id}-description`}
        className="text-body leading-normal text-text-muted"
      >
        {description}
      </span>
    </a>
  );
}

export function LandingPage({
  onNavigate,
}: {
  onNavigate: (to: string) => void;
}) {
  const follow = followLink(onNavigate);
  return (
    <main className="mx-auto box-border flex w-full max-w-260 flex-1 flex-col gap-12 px-7 py-12 compact:px-5 phone:gap-8 phone:px-4 phone:py-8">
      <div className="flex max-w-180 flex-col items-start gap-5">
        <h1 className="m-0 text-display font-semibold">
          Know every card you own, and where it is.
        </h1>
        <p className="m-0 text-body leading-normal text-text-muted">
          PrizeCheck keeps count of your physical Pokémon cards: every copy of
          each printing and finish, and the box, binder or deck it's in. Build
          decks from the cards you have, see what's still missing, and lend or
          trade with friends without losing track.
        </p>
        <ul
          aria-label="Where to start"
          className="m-0 grid w-full list-none grid-cols-2 gap-4 p-0 phone:grid-cols-1"
        >
          {GOALS.map((goal) => (
            <li key={goal.href}>
              <GoalLink {...goal} onClick={follow} />
            </li>
          ))}
        </ul>
        <p className="m-0 text-meta text-text-muted">
          You&apos;ll sign in first, then carry on from there.
        </p>
        <div className="flex flex-wrap gap-3">
          <a href={SIGN_IN_PATH} onClick={follow} className={PRIMARY}>
            Sign in
          </a>
          <a href={DISCOVER_PATH} onClick={follow} className={SECONDARY}>
            Discover decks
          </a>
        </div>
      </div>
      <section
        aria-label="What you can do"
        className="grid grid-cols-3 gap-4 compact:grid-cols-2 phone:grid-cols-1"
      >
        {FEATURES.map(({ title, description }) => (
          <div
            key={title}
            className="rounded-panel border border-border bg-surface p-5"
          >
            <h2 className="m-0 text-heading font-semibold">{title}</h2>
            <p className="mb-0 mt-3 text-body leading-normal text-text-muted">
              {description}
            </p>
          </div>
        ))}
      </section>
      <div className="flex flex-col gap-2 text-text-muted">
        <p className="m-0 text-body">English Pokémon cards only.</p>
        <p className="m-0 text-caption">
          Not endorsed by Nintendo or The Pokémon Company.
        </p>
      </div>
    </main>
  );
}
