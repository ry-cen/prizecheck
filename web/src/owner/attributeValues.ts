import type { AttributeEvidence, AttributeValues } from "../metadata_generated";

/** The reviewed card attributes, as the correction form holds them: one text value each. */
export type ReviewedKey = keyof AttributeValues & string;
export type Draft = Record<ReviewedKey, string>;
type Choice = readonly [value: string, label: string];

export type AttributeRow =
  | {
      key: Exclude<ReviewedKey, "types">;
      label: string;
      kind: "choice";
      choices: readonly Choice[];
    }
  | { key: Exclude<ReviewedKey, "types">; label: string; kind: "flag" }
  | { key: "types"; label: string; kind: "types" };

export const POKEMON_TYPES = [
  "Grass",
  "Fire",
  "Water",
  "Lightning",
  "Psychic",
  "Fighting",
  "Darkness",
  "Metal",
  "Fairy",
  "Dragon",
  "Colorless",
] as const;
type PokemonType = (typeof POKEMON_TYPES)[number];

const LETTERS = Array.from({ length: 26 }, (_, index) => {
  const letter = String.fromCharCode(65 + index);
  return [letter, letter] as const;
});

/** Every reviewed attribute, in the order the review card lists them (spec "Review cards", Attributes). Evolves
 * from is shown after ACE SPEC but is not here: it is derived only and never corrected. */
export const ATTRIBUTE_ROWS: readonly AttributeRow[] = [
  {
    key: "card_kind",
    label: "Card kind",
    kind: "choice",
    choices: [
      ["pokemon", "Pokémon"],
      ["trainer", "Trainer"],
      ["energy", "Energy"],
    ],
  },
  {
    key: "trainer_type",
    label: "Trainer Type",
    kind: "choice",
    choices: [
      ["supporter", "Supporter"],
      ["item", "Item"],
      ["tool", "Pokémon Tool"],
      ["stadium", "Stadium"],
    ],
  },
  {
    key: "regulation_mark",
    label: "Regulation mark",
    kind: "choice",
    choices: LETTERS,
  },
  { key: "rule_box", label: "Rule Box", kind: "flag" },
  { key: "ace_spec", label: "ACE SPEC", kind: "flag" },
  { key: "basic_energy", label: "Basic Energy", kind: "flag" },
  { key: "basic_pokemon", label: "Basic Pokémon", kind: "flag" },
  { key: "types", label: "Types", kind: "types" },
  { key: "radiant", label: "Radiant", kind: "flag" },
  { key: "prism_star", label: "Prism Star", kind: "flag" },
];

/** Where Evolves from sits among the rows: after ACE SPEC. */
export const EVOLVES_FROM_AFTER: ReviewedKey = "ace_spec";

/** One attribute value as the review card shows it. Null is "Unknown"; an empty types list is "None". */
export function showValue(row: AttributeRow, value: unknown): string {
  if (value === null || value === undefined) return "Unknown";
  if (row.kind === "flag") return value ? "Yes" : "No";
  if (row.kind === "types")
    return Array.isArray(value) && value.length ? value.join(" · ") : "None";
  return row.choices.find(([key]) => key === value)?.[1] ?? String(value);
}

/** A collector's proposal, for example "Trainer Type: Item, Rule Box: No". */
export function proposalText(proposed: Record<string, unknown>): string {
  const parts = ATTRIBUTE_ROWS.filter((row) => row.key in proposed).map(
    (row) => `${row.label}: ${showValue(row, proposed[row.key])}`
  );
  return parts.length ? parts.join(", ") : "nothing";
}

/** The form's values for a correction: the stored correction, so Correct restates it whole. */
export function draftFrom(correction: AttributeValues | null): Draft {
  const draft = {} as Draft;
  for (const row of ATTRIBUTE_ROWS) {
    const value = correction?.[row.key];
    if (value === null || value === undefined) draft[row.key] = "";
    else if (row.kind === "flag") draft[row.key] = value ? "true" : "false";
    else if (row.kind === "types")
      draft[row.key] = (value as string[]).length
        ? (value as string[]).join(", ")
        : "none";
    else draft[row.key] = String(value);
  }
  return draft;
}

/** The Types field: blank is not corrected, "none" is no types, otherwise types in printed order separated by
 * commas, each once. Undefined when the text is none of these. */
export function parseTypes(text: string): PokemonType[] | null | undefined {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.toLowerCase() === "none") return [];
  const types: PokemonType[] = [];
  for (const part of trimmed.split(",")) {
    const found = POKEMON_TYPES.find(
      (type) => type.toLowerCase() === part.trim().toLowerCase()
    );
    if (!found || types.includes(found)) return undefined;
    types.push(found);
  }
  return types;
}

/** The correction the form states: only the attributes it sets. `valid` is false while the Types text can't be read. */
export function correctionFrom(draft: Draft): {
  correction: AttributeValues;
  count: number;
  valid: boolean;
} {
  const correction: Record<string, unknown> = {};
  let valid = true;
  for (const row of ATTRIBUTE_ROWS) {
    const text = draft[row.key];
    if (row.kind === "types") {
      const types = parseTypes(text);
      if (types === undefined) valid = false;
      else if (types !== null) correction.types = types;
    } else if (text) {
      correction[row.key] = row.kind === "flag" ? text === "true" : text;
    }
  }
  return {
    correction: correction as AttributeValues,
    count: Object.keys(correction).length,
    valid,
  };
}

/** Whether a Printing still belongs in the queue (the server's rule): it has an open report, or it is a manual
 * Printing with no correction yet. */
export const stillQueued = (evidence: AttributeEvidence) =>
  evidence.reports.length > 0 ||
  (evidence.source === "manual" && evidence.correction === null);

/** Why the Printing is in the queue. */
export const queueKind = (evidence: AttributeEvidence) =>
  evidence.reports.length ? "Collector report" : "Manual Printing";

/** How long ago the Printing needed review: "12 min", "5 h" or "3 d". */
export function age(openedAt: string, now: number): string {
  const minutes = Math.max(
    0,
    Math.floor((now - new Date(openedAt).getTime()) / 60000)
  );
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours} h` : `${Math.floor(hours / 24)} d`;
}

const messages: Record<string, string> = {
  ATTRIBUTE_EVIDENCE_CHANGED:
    "The evidence changed since this card opened. Close it and review it again.",
  INVALID_APPROVAL_CODE:
    "That code is invalid, used or expired. Send a new code.",
  FRESH_CODE_REQUIRED: "Enter the fresh six-digit code first.",
  CATALOG_BUSY:
    "The catalog is busy with another change. Try again in a moment.",
  INCONSISTENT_ATTRIBUTES:
    "Those values can't all be true of one card. Check the card kind against the other corrections.",
  EMPTY_CORRECTION: "Choose at least one correction.",
  NO_CORRECTION: "This Printing has no correction to remove.",
  INVALID_REPORT:
    "A linked report is no longer open. Close this card and review it again.",
  REASON_REQUIRED: "A reason is required.",
  ALREADY_REVIEWED: "That report has already been reviewed.",
  REPORT_NOT_FOUND: "That report no longer exists.",
  PRINTING_NOT_FOUND: "That Printing no longer exists.",
};

/** What went wrong with a decision, in words. A 422 without a known code is a field the server refused. */
export function decisionError(failure: unknown): string {
  const code = failure instanceof Error ? failure.message : "";
  if (messages[code]) return messages[code];
  return (failure as { status?: number })?.status === 422
    ? "Check the evidence URL and the corrections, then try again."
    : "The request failed. Please retry.";
}

export const codeError = (failure: unknown) =>
  (failure as { status?: number })?.status === 429
    ? "Code rate limit reached. Try again in a minute."
    : "Unable to send the code. Please retry.";

/** Reporter-supplied: only http(s) is ever a link. */
export const safeLink = (value: string | null) =>
  value && /^https?:\/\//i.test(value) ? value : undefined;
