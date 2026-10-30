import type { DeckListLine } from "../../decks_generated";
import type { DeckGrouping } from "../../decks/deckListModel";

/** The Pokémon card-type groups of a Deck List (#176), as the deck builder and the Published Deck (#183) show them. */
export type PokemonGroupKind =
  | "pokemon"
  | "supporter"
  | "item"
  | "tool"
  | "stadium"
  | "trainer"
  | "energy"
  | "unknown";

const GROUPS: readonly { kind: PokemonGroupKind; title: string }[] = [
  { kind: "pokemon", title: "Pokémon" },
  { kind: "supporter", title: "Supporters" },
  { kind: "item", title: "Items" },
  { kind: "tool", title: "Tools" },
  { kind: "stadium", title: "Stadiums" },
  { kind: "trainer", title: "Other Trainers" },
  { kind: "energy", title: "Energy" },
  { kind: "unknown", title: "Card type unknown" },
];

function kindOf(line: DeckListLine): PokemonGroupKind {
  switch (line.card_kind) {
    case "pokemon":
      return "pokemon";
    case "trainer":
      return line.trainer_type ?? "trainer";
    case "energy":
      return "energy";
    default:
      return "unknown";
  }
}

/** Fixed card-type groups: Pokémon, each Trainer Type, other Trainers, Energy, then cards of unknown type. */
export const POKEMON_DECK_GROUPING: DeckGrouping = { groups: GROUPS, kindOf };

/** "Pokémon · evolves from Charmeleon", "Trainer · Supporter", "Energy" or "Card type unknown". */
export function kindText(line: DeckListLine): string {
  switch (line.card_kind) {
    case "pokemon":
      return line.evolves_from
        ? `Pokémon · evolves from ${line.evolves_from}`
        : "Pokémon";
    case "trainer":
      return line.trainer_type
        ? `Trainer · ${line.trainer_type[0].toUpperCase()}${line.trainer_type.slice(1)}`
        : "Trainer";
    case "energy":
      return "Energy";
    default:
      return "Card type unknown";
  }
}
