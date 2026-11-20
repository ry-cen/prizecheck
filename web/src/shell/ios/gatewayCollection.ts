import { getCollection } from "../../collection_generated";
import { HoldingError } from "../../holdings_generated";
import type { CollectionRead, CollectionSource } from "./collectionSource";

export type SessionRead = "signed-in" | "signed-out" | "unavailable";

/**
 * The Collection read boundary for the real gateway. Not imported by the packaged entry:
 * a packaged WKWebView has neither Safari's cookie jar nor the web origin.
 */
export function gatewayCollectionSource(
  deps: {
    getCollection?: typeof getCollection;
    fetch?: typeof fetch;
  } = {}
): CollectionSource & { readSession(): Promise<SessionRead> } {
  return {
    sample: false,
    async read(cursor) {
      try {
        const page = await (deps.getCollection ?? getCollection)({}, cursor);
        if (!page || !Array.isArray(page.entries)) {
          return { kind: "unavailable" } satisfies CollectionRead;
        }
        return { kind: "page", page } satisfies CollectionRead;
      } catch (error) {
        return error instanceof HoldingError && error.status === 401
          ? { kind: "signed-out" }
          : { kind: "unavailable" };
      }
    },
    async readSession() {
      try {
        const response = await (deps.fetch ?? fetch)("/auth/session", {
          credentials: "same-origin",
        });
        if (!response.ok) return "unavailable";
        const body = await response.json();
        if (body?.signedIn === true) return "signed-in";
        if (body?.signedIn === false) return "signed-out";
        return "unavailable";
      } catch {
        return "unavailable";
      }
    },
  };
}
