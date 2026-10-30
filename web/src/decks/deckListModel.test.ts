import { expect, test } from "vitest";
import { POKEMON_DECK_GROUPING } from "../games/pokemon/deckGroups";
import { deckLine, groupLines } from "./deckListModel";
import type { DeckListLine } from "../decks_generated";

function line(
  name: string,
  quantity: string,
  card_kind: DeckListLine["card_kind"]
) {
  return deckLine(
    {
      edition_id: name,
      identity_id: name,
      name,
      quantity,
      in_deck: "0",
      set_name: "Set",
      collector_number: "1",
      descriptor: {},
      card_kind,
      trainer_type: null,
      evolves_from: "Charmander",
      evolution_root: "Charmander",
      evolution_stage: 1,
    } as DeckListLine,
    undefined
  );
}

test("Pokémon share a fixed group ordered by copies then name, regardless of evolution", () => {
  const groups = groupLines(
    [
      line("Charizard", "1", "pokemon"),
      line("Pikachu", "2", "pokemon"),
      line("Charmander", "2", "pokemon"),
      line("Energy", "10", "energy"),
    ],
    POKEMON_DECK_GROUPING
  );
  expect(groups.map(({ title }) => title)).toEqual(["Pokémon", "Energy"]);
  expect(groups[0].lines.map(({ line }) => line.name)).toEqual([
    "Charmander",
    "Pikachu",
    "Charizard",
  ]);
  expect(groups[0].copies).toBe(5n);
});
