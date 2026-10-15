import type { WantListCounting } from "../settings_generated";

/**
 * The Want List counting setting's two choices (decklist import spec "Counting setting"), in the order Settings lists
 * them, with the line that explains each. The Want List names the counting it uses with the same label.
 */
export const COUNTING_OPTIONS: readonly {
  value: WantListCounting;
  label: string;
  explainer: string;
}[] = [
  {
    value: "all_at_once",
    label: "Every Deck built at once",
    explainer:
      "Each spare copy counts toward one Deck only, oldest Deck first.",
  },
  {
    value: "one_at_a_time",
    label: "One Deck at a time",
    explainer:
      "Every copy you own counts for every Deck, even copies sleeved in another Deck.",
  },
];

/** "Every Deck built at once" or "One Deck at a time". */
export function countingLabel(value: WantListCounting): string {
  return COUNTING_OPTIONS.find((option) => option.value === value)!.label;
}
