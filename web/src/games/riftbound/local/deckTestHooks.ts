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
