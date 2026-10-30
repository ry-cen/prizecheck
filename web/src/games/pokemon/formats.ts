import type { PillTone } from "../../ui/Pill";

/**
 * The Pokémon Formats (ADR 0011) and a card's standing in one, in words. The one place the web app names them: the
 * Catalog, deck builder, Discover and owner screens pass these in (ADR 0023, docs/planning/shared-core/frontend-composition.md).
 */

export type PokemonFormat = "standard" | "expanded" | "glc";

/** Every Format, in the order chips, pickers and legality lists show them. `short` names it on a chip, a pill or a
 * deck card ("GLC"); `long` names it in a picker or a sentence ("Gym Leader Challenge"). */
export const POKEMON_FORMATS: readonly {
  value: PokemonFormat;
  short: string;
  long: string;
}[] = [
  { value: "standard", short: "Standard", long: "Standard" },
  { value: "expanded", short: "Expanded", long: "Expanded" },
  { value: "glc", short: "GLC", long: "Gym Leader Challenge" },
];

export const FORMAT_SHORT_NAMES = Object.fromEntries(
  POKEMON_FORMATS.map(({ value, short }) => [value, short])
) as Record<PokemonFormat, string>;

export const FORMAT_LONG_NAMES = Object.fromEntries(
  POKEMON_FORMATS.map(({ value, long }) => [value, long])
) as Record<PokemonFormat, string>;

/** A legality Pill's words: the Format, then its standing. */
export const STANDING_WORDS = {
  legal: "Legal",
  not_legal: "Not legal",
  unknown: "Unknown",
} as const;

export type Standing = keyof typeof STANDING_WORDS;

/** The Pill tone that repeats a standing. */
export const STANDING_TONES: Record<Standing, PillTone> = {
  legal: "ok",
  not_legal: "bad",
  unknown: "unverified",
};
