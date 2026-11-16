import type {
  CollectionEntry,
  CollectionPage,
} from "../../collection_generated";

// Uses the existing Collection response contract. Synthetic data only; no art/network requests.
function sample(id: string, name: string, number: string): CollectionEntry {
  return {
    edition_id: `fixture-edition-${id}`,
    quantity: "2",
    printing_id: `fixture-printing-${id}`,
    printing_name: name,
    set_id: "fixture-set",
    set_name: "Demo set",
    collector_number: number,
    descriptor: {},
    image_url: null,
  };
}

export const FIXTURE_SECOND_CURSOR = "fixture-page-2";

export const collectionFixturePages: CollectionPage[] = [
  {
    entries: [
      sample("pikachu", "Pikachu", "001"),
      sample("eevee", "Eevee", "002"),
      sample("snorlax", "Snorlax", "003"),
    ],
    owner_revision: 1,
    catalog_revision: 1,
    next_cursor: FIXTURE_SECOND_CURSOR,
  },
  {
    entries: [
      sample("mew", "Mew", "004"),
      sample("jigglypuff", "Jigglypuff", "005"),
    ],
    owner_revision: 1,
    catalog_revision: 1,
    next_cursor: null,
  },
];

export const collectionFixture: CollectionPage = collectionFixturePages[0];
