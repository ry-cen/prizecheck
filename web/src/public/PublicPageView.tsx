import { useEffect, useState } from "react";
import { DiscoverPage } from "../discover/DiscoverPage";
import { DeadEnd } from "./DeadEnd";
import { InvitePage } from "./InvitePage";
import { PublishedDeckPage } from "./PublishedDeckPage";
import type { PublicPage } from "./publicRoutes";

type Props = {
  page: PublicPage;
  signedIn: boolean;
  onNavigate: (to: string) => void;
};

/**
 * Discover or a Published Deck, the same under the public header and inside the shell, both on the kit (#182, #183).
 * An unknown or revoked token shows the kit's unavailable card instead of the Published Deck.
 */
export function PublicPageView({ page, signedIn, onNavigate }: Props) {
  if (page.kind === "discover") return <DiscoverPage onNavigate={onNavigate} />;
  if (page.kind === "invite")
    return (
      <InvitePage
        key={page.token}
        token={page.token}
        signedIn={signedIn}
        onNavigate={onNavigate}
      />
    );
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
    <PublishedDeckPage
      token={token}
      signedIn={signedIn}
      onNavigate={onNavigate}
      onUnavailable={() => setUnavailable(true)}
    />
  );
}
