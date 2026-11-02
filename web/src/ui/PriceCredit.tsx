/**
 * The one line that credits the price source: "Prices from TCGCSV", linking tcgcsv.com. It is the only collector-visible
 * mention of a price source, by the owner's explicit exception to AGENTS.md's no-provenance rule (ADR 0019, "Footer
 * credit"; #467, owner decision 2026-10-31). It carries no date or time and appears only in the Settings footer.
 * TCGCSV FAQ (https://tcgcsv.com/faq) and usage docs (https://tcgcsv.com/docs), checked 2026-11-02:
 * no mandatory credit. ADR 0019 records the dated verification.
 * Keep this component free of imports, so the bundle boundary check sees no new edge.
 */
export function PriceCredit({ className = "" }: { className?: string }) {
  return (
    <footer
      className={`box-border px-7 py-4 text-center text-caption text-text-subtle compact:px-5 phone:px-3 phone:py-0 ${className}`}
    >
      <p>
        Prices from{" "}
        <a
          href="https://tcgcsv.com"
          rel="noopener"
          className="text-text-subtle underline phone:inline-flex phone:min-h-tap phone:items-center"
        >
          TCGCSV
        </a>
      </p>
    </footer>
  );
}
