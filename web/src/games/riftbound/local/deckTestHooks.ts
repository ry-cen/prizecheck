import { collectionFixtureStore } from "./collectionFixtures";
import { deckListHeaders } from "./deckListFixtures";
/** Test-only concurrent list change; no transport, storage or cross-owner lookup. */
export function changeFixtureDeckLine(
  owner: "a" | "b",
  deck: string,
  edition: string,
  quantity: number
) {
  const header = deckListHeaders(collectionFixtureStore(owner)).get(deck)!;
  const line = header.lines.find((line) => line.edition.id === edition)!;
  line.quantity = quantity;
  header.revision++;
}
/**
 * Test-only lost response: the next rename applies on the fixture server, then
 * fails as if the response never arrived. An optional gate holds the failure
 * back, so a test can deliver a newer version first. No transport or storage.
 */
export function loseNextRenameResponse(
  api: { renameDeck: (...args: never[]) => Promise<unknown> },
  gate?: Promise<void>
) {
  const rename = api.renameDeck.bind(api) as (
    ...args: unknown[]
  ) => Promise<unknown>;
  let lost = true;
  api.renameDeck = (async (...args: unknown[]) => {
    const result = await rename(...args);
    if (lost) {
      lost = false;
      await gate;
      throw new Error("Response lost");
    }
    return result;
  }) as never;
}
/** Test-only: the root Location named Unsorted can no longer hold cards, so deleting a Deck with cards is refused (core `deck_deletion.py:59`). */
export function occupyUnsortedName(owner: "a" | "b") {
  const unsorted = collectionFixtureStore(owner).locations.find(
    (n) => n.parent_id === null && n.name === "Unsorted"
  )!;
  unsorted.kind = "storage_container";
}
