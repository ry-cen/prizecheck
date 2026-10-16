import type { MouseEvent } from "react";

/** The signed-out addresses outside the app's pages (#163). The app's own pages are in shell/routes.ts. */
export const SIGN_IN_PATH = "/sign-in";
export const DISCOVER_PATH = "/discover";

/** A public page: readable signed out under the public header, and inside the shell when signed in. An Invite Link
 * (social network #246) is /invite/<token>. */
export type PublicPage =
  | { kind: "discover" }
  | { kind: "published"; token: string }
  | { kind: "invite"; token: string };

export function publicPageAt(path: string): PublicPage | null {
  if (path === DISCOVER_PATH) return { kind: "discover" };
  const published = /^\/published\/([^/]+)$/.exec(path);
  if (published) return { kind: "published", token: published[1] };
  const invite = /^\/invite\/([^/]+)$/.exec(path);
  return invite ? { kind: "invite", token: invite[1] } : null;
}

/** The phone header's title for a public page inside the shell. */
export function publicPageLabel(page: PublicPage): string {
  if (page.kind === "invite") return "Invite";
  return page.kind === "discover" ? "Discover decks" : "Published Deck";
}

/** A click handler for a link to another address in this app: a plain click opens it without a page load, while a
 * modified or middle click keeps the browser's own behaviour (a new tab or window). */
export function followLink(navigate: (to: string) => void) {
  return (event: MouseEvent<HTMLAnchorElement>) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    event.preventDefault();
    navigate(event.currentTarget.getAttribute("href")!);
    window.scrollTo(0, 0);
  };
}
