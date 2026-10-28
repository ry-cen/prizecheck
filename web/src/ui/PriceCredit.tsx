/**
 * The one line that credits the price source: "Prices from TCGCSV", linking tcgcsv.com. It is the only collector-visible
 * mention of a price source, by the owner's explicit exception to AGENTS.md's no-provenance rule (ADR 0019, "Footer
 * credit"; docs/planning/tcgcsv-prices/design.md §8). It carries no date or time. The signed-in shell and the public
 * layout each render it once; the scanner page, its own entry, does not. Keep this component free of imports, so the
 * bundle boundary check sees no new edge.
 */
export function PriceCredit({ className = "" }: { className?: string }) {
  return (
    <footer
      className={`box-border px-7 py-4 text-center text-caption text-text-subtle compact:px-5 phone:px-3 phone:py-0 ${className}`}
    >
      Prices from{" "}
      <a
        href="https://tcgcsv.com"
        rel="noopener"
        className="text-text-subtle underline phone:inline-flex phone:min-h-tap phone:items-center"
      >
        TCGCSV
      </a>
    </footer>
  );
}
