import { useState } from "react";

/** Which game a piece of browser state belongs to. Pokémon is the original game: its keys, locks,
 * channel names and event details keep the exact strings they have always had. */
export type GameId = "pokemon" | "riftbound";

export const GAME_IDS: readonly GameId[] = ["pokemon", "riftbound"];

/** The key prefix for a game other than Pokémon: `prizecheck:<game>:<feature>:`. Pokémon never uses
 * it, so state already stored for Pokémon keeps being read where it was written. */
export function scopedPrefix(game: GameId, feature: string): string {
  return `prizecheck:${game}:${feature}:`;
}

/** A game-aware hook serves one game for its whole life. A caller that shows another game must key the
 * component that calls the hook by game (`key={game}`), so the switch mounts a fresh instance. Any render
 * that passes a different game throws here, before the hook reads or writes any state, ref or storage. */
export function useFixedGame(game: GameId, hook: string): GameId {
  const [fixed] = useState(game);
  if (game !== fixed)
    throw new Error(
      `${hook} was mounted for ${fixed} and rendered for ${game}: key the component that calls it by game.`
    );
  return fixed;
}
