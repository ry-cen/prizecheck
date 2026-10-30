import { expect, test } from "vitest";
import type { DeckDetail, DeckListLine } from "../decks_generated";
import { publishedGroups } from "../public/publishedDeckModel";
import { kindText, POKEMON_DECK_GROUPING } from "../games/pokemon/deckGroups";
import { deckLine, deckListModel, groupLines } from "./deckListModel";

// The Deck List's card-type groups and each line's type words, as the deck builder, the Published Deck and the copy
// sheet show them.

function listLine(
  name: string,
  quantity: string,
  card_kind: DeckListLine["card_kind"],
  trainer_type: DeckListLine["trainer_type"] = null,
  evolves_from: string | null = null
): DeckListLine {
  return {
    edition_id: name,
    quantity,
    in_deck: quantity,
    name,
    set_id: "set",
    set_name: "Set",
    collector_number: "1",
    descriptor: {},
    image_url: null,
    card_kind,
    trainer_type,
    evolves_from,
    identity_id: name,
    identity_name: name,
    evolution_root: null,
    evolution_stage: null,
  };
}

const EVERY_KIND = [
  listLine("Unknown Card", "1", null),
  listLine("Basic Fire Energy", "8", "energy"),
  listLine("Odd Trainer", "1", "trainer"),
  listLine("Artazon", "2", "trainer", "stadium"),
  listLine("Choice Belt", "1", "trainer", "tool"),
  listLine("Ultra Ball", "4", "trainer", "item"),
  listLine("Iono", "3", "trainer", "supporter"),
  listLine("Charmander", "4", "pokemon"),
];

test("every card type has its own group, in the fixed order, with its heading and copies", () => {
  const groups = groupLines(
    EVERY_KIND.map((line) => deckLine(line, undefined)),
    POKEMON_DECK_GROUPING
  );
  expect(
    groups.map(({ key, kind, title, copies }) => ({ key, kind, title, copies }))
  ).toEqual([
    { key: "pokemon", kind: "pokemon", title: "Pokémon", copies: 4n },
    { key: "supporter", kind: "supporter", title: "Supporters", copies: 3n },
    { key: "item", kind: "item", title: "Items", copies: 4n },
    { key: "tool", kind: "tool", title: "Tools", copies: 1n },
    { key: "stadium", kind: "stadium", title: "Stadiums", copies: 2n },
    { key: "trainer", kind: "trainer", title: "Other Trainers", copies: 1n },
    { key: "energy", kind: "energy", title: "Energy", copies: 8n },
    {
      key: "unknown",
      kind: "unknown",
      title: "Card type unknown",
      copies: 1n,
    },
  ]);
});

test("a group sorts its lines by copies, then name; empty groups are left out", () => {
  const groups = groupLines(
    [
      listLine("Rare Candy", "1", "trainer", "item"),
      listLine("Ultra Ball", "4", "trainer", "item"),
      listLine("Nest Ball", "4", "trainer", "item"),
    ].map((line) => deckLine(line, undefined)),
    POKEMON_DECK_GROUPING
  );
  expect(groups.map(({ title }) => title)).toEqual(["Items"]);
  expect(groups[0].lines.map(({ line }) => line.name)).toEqual([
    "Nest Ball",
    "Ultra Ball",
    "Rare Candy",
  ]);
});

test("a line's card type in words", () => {
  expect(kindText(listLine("Charmander", "1", "pokemon"))).toBe("Pokémon");
  expect(
    kindText(listLine("Charmeleon", "1", "pokemon", null, "Charmander"))
  ).toBe("Pokémon · evolves from Charmander");
  expect(kindText(listLine("Iono", "1", "trainer", "supporter"))).toBe(
    "Trainer · Supporter"
  );
  expect(kindText(listLine("Ultra Ball", "1", "trainer", "item"))).toBe(
    "Trainer · Item"
  );
  expect(kindText(listLine("Choice Belt", "1", "trainer", "tool"))).toBe(
    "Trainer · Tool"
  );
  expect(kindText(listLine("Artazon", "1", "trainer", "stadium"))).toBe(
    "Trainer · Stadium"
  );
  expect(kindText(listLine("Odd Trainer", "1", "trainer"))).toBe("Trainer");
  expect(kindText(listLine("Fire", "1", "energy"))).toBe("Energy");
  expect(kindText(listLine("Unknown Card", "1", null))).toBe(
    "Card type unknown"
  );
});

test("a Deck read groups its lines and totals their copies", () => {
  const detail = {
    deck_list: { lines: EVERY_KIND },
    ownership: [],
    loans: [],
  } as unknown as DeckDetail;
  const model = deckListModel(detail, POKEMON_DECK_GROUPING);
  expect(model.total).toBe("24");
  expect(model.groups.map(({ title }) => title)).toEqual([
    "Pokémon",
    "Supporters",
    "Items",
    "Tools",
    "Stadiums",
    "Other Trainers",
    "Energy",
    "Card type unknown",
  ]);
});

test("a Published Deck groups like the builder, or as one Cards group when no card types were frozen", () => {
  const typed = publishedGroups(
    EVERY_KIND.map((line) => deckLine(line, undefined))
  );
  expect(typed.map(({ title }) => title)).toEqual([
    "Pokémon",
    "Supporters",
    "Items",
    "Tools",
    "Stadiums",
    "Other Trainers",
    "Energy",
    "Card type unknown",
  ]);
  const legacy = publishedGroups(
    [listLine("A", "2", null), listLine("B", "3", null)].map((line) =>
      deckLine(line, undefined)
    )
  );
  expect(
    legacy.map(({ key, title, copies }) => ({ key, title, copies }))
  ).toEqual([{ key: "cards", title: "Cards", copies: 5n }]);
});

test("the generic grouping takes its groups, order and headings from the grouping passed in", () => {
  const groups = groupLines(
    EVERY_KIND.map((line) => deckLine(line, undefined)),
    {
      groups: [
        { kind: "b", title: "Second letter" },
        { kind: "a", title: "First letter" },
      ],
      kindOf: (line) => (line.name < "C" ? "a" : "b"),
    }
  );
  expect(
    groups.map(({ key, title, lines }) => ({
      key,
      title,
      names: lines.map(({ line }) => line.name),
    }))
  ).toEqual([
    {
      key: "b",
      title: "Second letter",
      names: [
        "Charmander",
        "Ultra Ball",
        "Iono",
        "Choice Belt",
        "Odd Trainer",
        "Unknown Card",
      ],
    },
    {
      key: "a",
      title: "First letter",
      names: ["Basic Fire Energy", "Artazon"],
    },
  ]);
});
