import { expect, test } from "vitest";
import { POKEMON_DECK_GROUPING } from "../games/pokemon/deckGroups";
import {
  deckLine,
  groupLines,
  deckListModel,
  extendOrder,
} from "./deckListModel";
import type { DeckListLine, DeckDetail } from "../decks_generated";

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

const names = (groups: ReturnType<typeof groupLines>) =>
  groups[0].lines.map((l) => l.line.name);
test("groupLines keeps a given order: a line whose copies rose stays where it was", () => {
  expect(
    names(
      groupLines(
        [line("A", "3", "pokemon"), line("B", "4", "pokemon")],
        POKEMON_DECK_GROUPING,
        new Map([
          ["A", 0],
          ["B", 1],
        ])
      )
    )
  ).toEqual(["A", "B"]);
});
test("groupLines puts lines missing from the order after the ordered ones, by copies then name", () => {
  expect(
    names(
      groupLines(
        [
          line("B", "4", "pokemon"),
          line("A", "1", "pokemon"),
          line("C", "4", "pokemon"),
        ],
        POKEMON_DECK_GROUPING,
        new Map([["A", 0]])
      )
    )
  ).toEqual(["A", "B", "C"]);
});
test("deckListModel without an order sorts as before", () => {
  const detail = {
    deck_list: {
      lines: [line("A", "2", "pokemon").line, line("B", "3", "pokemon").line],
    },
    ownership: [],
  } as unknown as DeckDetail;
  const model = deckListModel(detail, POKEMON_DECK_GROUPING);
  expect(names(model.groups)).toEqual(["B", "A"]);
  const order = extendOrder(null, model);
  expect(extendOrder(order, model)).toEqual(order);
  expect(extendOrder(order, model)).not.toBe(order);
});
