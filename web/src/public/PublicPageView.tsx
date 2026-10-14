import { useEffect, useState } from "react";
import { DiscoverPage } from "../discover/DiscoverPage";
import { PublishedDeck } from "../PublishedDeck";
import { DeadEnd } from "./DeadEnd";
import type { PublicPage } from "./publicRoutes";

type Props = {
  page: PublicPage;
  signedIn: boolean;
  onNavigate: (to: string) => void;
};

/**
 * Discover or a Published Deck, the same under the public header and inside the shell. Discover is on the kit
 * (#182). A Published Deck is still the old light page (restyled in #183), so it sits in .legacy on a light
 * surface; an unknown or revoked token shows the kit's unavailable card instead, outside .legacy.
 */
export function PublicPageView({ page, signedIn, onNavigate }: Props) {
  if (page.kind === "discover") return <DiscoverPage onNavigate={onNavigate} />;
  return (
    <PublishedPage
      key={page.token}
      token={page.token}
      signedIn={signedIn}
      onNavigate={onNavigate}
    />
  );
}

function PublishedPage({
  token,
  signedIn,
  onNavigate,
}: {
  token: string;
  signedIn: boolean;
  onNavigate: (to: string) => void;
}) {
  const [unavailable, setUnavailable] = useState(false);
  // The unavailable card keeps the old not-found page's robots answer, so search engines never index it.
  useEffect(() => {
    if (!unavailable) return;
    const robots = document.createElement("meta");
    robots.name = "robots";
    robots.content = "noindex, nofollow";
    document.head.append(robots);
    return () => robots.remove();
  }, [unavailable]);
  if (unavailable)
    return (
      <DeadEnd kind="unavailable" signedIn={signedIn} onNavigate={onNavigate} />
    );
  return (
    <div className="legacy legacy-light flex-1">
      <PublishedDeck token={token} onUnavailable={() => setUnavailable(true)} />
    </div>
  );
}
