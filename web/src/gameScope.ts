/** Which game a piece of browser state belongs to. Pokémon is the original game: its keys, locks,
 * channel names and event details keep the exact strings they have always had. */
export type GameId = "pokemon" | "riftbound";

export const GAME_IDS: readonly GameId[] = ["pokemon", "riftbound"];

/** The key prefix for a game other than Pokémon: `prizecheck:<game>:<feature>:`. Pokémon never uses
 * it, so state already stored for Pokémon keeps being read where it was written. */
export function scopedPrefix(game: GameId, feature: string): string {
  return `prizecheck:${game}:${feature}:`;
}
