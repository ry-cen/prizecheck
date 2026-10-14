/** The wording for a Card Edition whose physical variant isn't known (CONTEXT.md). */
export const UNSPECIFIED_VARIANT = "Unspecified Variant";

/** Catalog finish values and how a collector names them. */
const FINISHES: Record<string, string> = {
  normal: "Normal",
  holo: "Holo",
  reverse: "Reverse Holo",
};

/** Descriptor keys in the order they are read out; any other key follows, alphabetically. The database
 * returns a descriptor's keys in its own order, so the order is fixed here. */
const KEY_ORDER = [
  "finish",
  "type",
  "subtype",
  "foil",
  "foilPattern",
  "stamp",
  "stamps",
  "size",
];

/** "first-edition", "pokeball" or "foilPattern" as "First Edition", "Pokeball", "Foil Pattern". */
function words(value: string): string {
  return value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}

function text(value: unknown): string {
  if (Array.isArray(value)) return value.map(text).join(", ");
  if (typeof value === "string") return words(value);
  if (value !== null && typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * A Card Edition's Variant Descriptor as one short phrase, for tiles, accessible names and the inspector
 * (spec "Styling and the kit": Variant Descriptor placement). A reviewed `label` is used as written; the
 * unspecified Edition, an empty descriptor or no descriptor reads "Unspecified Variant". Otherwise each
 * physical key is read out in a fixed order: the finish by its collector name (reverse is "Reverse Holo"),
 * other values in words, a standard size left out, and an unknown key as "Key: value".
 *
 * Examples: {finish: "reverse"} -> "Reverse Holo"; {type: "holo", size: "standard"} -> "Holo";
 * {type: "normal", stamps: ["first-edition"]} -> "Normal, First Edition".
 */
export function variantLabel(
  descriptor: Record<string, unknown> | null | undefined
): string {
  if (!descriptor || typeof descriptor !== "object") return UNSPECIFIED_VARIANT;
  if (descriptor.kind === "unspecified") return UNSPECIFIED_VARIANT;
  if (typeof descriptor.label === "string" && descriptor.label.trim())
    return descriptor.label.trim();
  const keys = Object.keys(descriptor).sort((a, b) => {
    const left = KEY_ORDER.indexOf(a);
    const right = KEY_ORDER.indexOf(b);
    if (left === -1 && right === -1) return a.localeCompare(b);
    if (left === -1) return 1;
    if (right === -1) return -1;
    return left - right;
  });
  const parts: string[] = [];
  for (const key of keys) {
    const value = descriptor[key];
    if (value === null || value === undefined || value === "") continue;
    if (Array.isArray(value) && !value.length) continue;
    if (key === "size" && value === "standard") continue;
    if ((key === "finish" || key === "type") && typeof value === "string")
      parts.push(FINISHES[value] ?? words(value));
    else if (KEY_ORDER.includes(key)) parts.push(text(value));
    else parts.push(`${words(key)}: ${text(value)}`);
  }
  return parts.join(", ") || UNSPECIFIED_VARIANT;
}
