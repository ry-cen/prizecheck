// GET /auth/session. The provider name and picture and the collector's email appear here, for the signed-in collector
// only; no public response (Published Decks, Discover) reads them.

type CurrentSession = {
  user: {
    id: string;
    name?: string | null;
    image?: string | null;
    email?: string | null;
  };
} | null;

/** True for an https URL on one of the configured providers' image hosts (or a subdomain of one). */
function providerImage(image: unknown, imageHosts: string[]): string | null {
  if (typeof image !== "string") return null;
  try {
    const url = new URL(image);
    if (url.protocol !== "https:") return null;
    const host = url.hostname;
    return imageHosts.some((h) => host === h || host.endsWith("." + h))
      ? image
      : null;
  } catch {
    return null;
  }
}

export function sessionBody(current: CurrentSession, imageHosts: string[]) {
  if (!current) return { signedIn: false, userId: null };
  return {
    signedIn: true,
    userId: current.user.id,
    name: current.user.name || null,
    // Pictures load straight from a configured provider's https image host.
    image: providerImage(current.user.image, imageHosts),
    email: current.user.email || null,
  };
}
