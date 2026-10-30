/** The initials of a collector's Display Name: the first letter of its first two words, in upper case. */
export function initials(name: string): string {
  const letters = name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => Array.from(word)[0] ?? "");
  return letters.join("").toLocaleUpperCase() || "?";
}

const SIZES = {
  sm: "size-7 text-caption",
  md: "size-10 text-meta",
} as const;

/**
 * A collector's initials in a round Raised Felt disc, beside their name on Loan and Trade rows. Decoration only: the
 * name sits next to it, so it is hidden from screen readers.
 */
export function Avatar({
  name,
  size = "md",
}: {
  name: string;
  size?: keyof typeof SIZES;
}) {
  return (
    <span
      aria-hidden="true"
      className={`inline-flex shrink-0 select-none items-center justify-center rounded-round border border-border-strong bg-surface-raised font-semibold text-text-muted ${SIZES[size]}`}
    >
      {initials(name)}
    </span>
  );
}
