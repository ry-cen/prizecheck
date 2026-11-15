import type { CollectionPage } from "../../collection_generated";

// Uses the existing Collection response contract. Synthetic data only; no art/network requests.
export const collectionFixture: CollectionPage = {
  entries: [
    {
      edition_id: "fixture-edition",
      quantity: "2",
      printing_id: "fixture-printing",
      printing_name: "Pikachu",
      set_id: "fixture-set",
      set_name: "Demo set",
      collector_number: "001",
      descriptor: {},
      image_url: null,
    },
  ],
  owner_revision: 1,
  catalog_revision: 1,
  next_cursor: null,
};
