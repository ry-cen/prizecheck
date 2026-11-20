import type { CollectionPage } from "../../collection_generated";
import { collectionFixturePages } from "./collectionFixture";
import type { FixtureSession } from "./fixtureSession";

export type CollectionRead =
  | { kind: "page"; page: CollectionPage }
  | { kind: "signed-out" } // no session, or the session ended (gateway 401)
  | { kind: "unavailable" }; // network failure, other non-OK status, malformed body, unknown cursor

export interface CollectionSource {
  /** True for sample data; the UI keeps saying so. */
  readonly sample: boolean;
  read(cursor?: string): Promise<CollectionRead>;
}

/** Sample pages: page 1 carries the cursor to page 2, the last page ends the list. */
export function fixtureCollectionSource(
  session: FixtureSession,
  pages: CollectionPage[] = collectionFixturePages
): CollectionSource {
  return {
    sample: true,
    async read(cursor) {
      await Promise.resolve();
      if (!session.signedIn()) return { kind: "signed-out" };
      if (!cursor) return { kind: "page", page: pages[0] };
      const index = pages.findIndex(
        (page, at) => at > 0 && pages[at - 1].next_cursor === cursor
      );
      return index > 0
        ? { kind: "page", page: pages[index] }
        : { kind: "unavailable" };
    },
  };
}
