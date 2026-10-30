import type {
  DeckFormatChecks,
  FormatCheck,
  FormatIssue,
} from "../format_checks_generated";
import {
  POKEMON_FORMATS,
  STANDING_TONES,
  STANDING_WORDS,
  type PokemonFormat,
} from "../games/pokemon/formats";
import type { PillTone } from "../ui/Pill";

/**
 * The Deck's Target Format (#178, ADR 0011): the one Format its advisory check runs against, Standard unless the
 * collector chooses another, and whose `legal` result publishing needs.
 */
export type TargetFormat = PokemonFormat;

export const TARGET_FORMATS: readonly { value: TargetFormat; label: string }[] =
  POKEMON_FORMATS.map(({ value, long }) => ({ value, label: long }));

export function formatLabel(format: string): string {
  return (
    TARGET_FORMATS.find((entry) => entry.value === format)?.label ?? format
  );
}

/** The result for `format` in a format-checks body, picked by name: never by position. */
export function resultFor(
  checks: DeckFormatChecks | null | undefined,
  format: string
): FormatCheck | null {
  return checks?.results.find((result) => result.format === format) ?? null;
}

const STATUS: Record<
  FormatCheck["status"],
  { mark: string; text: string; tone: PillTone }
> = {
  legal: { mark: "✓", text: STANDING_WORDS.legal, tone: STANDING_TONES.legal },
  not_legal: {
    mark: "✕",
    text: STANDING_WORDS.not_legal,
    tone: STANDING_TONES.not_legal,
  },
  unknown: {
    mark: "?",
    text: STANDING_WORDS.unknown,
    tone: STANDING_TONES.unknown,
  },
};

/** "✓" and "Legal", "✕" and "Not legal", or "?" and "Unknown", with the Pill tone that repeats it. */
export function statusOf(status: FormatCheck["status"]) {
  return STATUS[status];
}

/** "1 issue", "3 issues". */
export function issueCount(result: FormatCheck): string {
  const count = result.issues.length;
  return `${count} ${count === 1 ? "issue" : "issues"}`;
}

/**
 * The Deck List lines (Edition ids) that a card-level issue names. Deck-level issues also list lines (a deck
 * with no Basic Pokémon lists every line), but they are about the deck, so they highlight nothing.
 */
export function flaggedLines(result: FormatCheck | null): Set<string> {
  const lines = new Set<string>();
  for (const issue of result?.issues ?? [])
    if (issue.kind === "card") for (const line of issue.lines) lines.add(line);
  return lines;
}

export function deckIssues(result: FormatCheck): FormatIssue[] {
  return result.issues.filter((issue) => issue.kind === "deck");
}

export function cardIssues(result: FormatCheck): FormatIssue[] {
  return result.issues.filter((issue) => issue.kind === "card");
}

/** "Oct 14, 2026" for an ISO date (YYYY-MM-DD), read as that calendar day wherever the browser is. */
export function dayText(isoDate: string): string {
  return new Date(`${isoDate}T00:00:00Z`).toLocaleDateString("en-US", {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}
