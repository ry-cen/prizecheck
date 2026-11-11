import type { EditionStandings } from "../catalog_browse_generated";
import { Pill } from "../ui/Pill";
import { FORMATS, STANDING_TONES, STANDING_WORDS } from "./catalogText";

/** Card facts can leave several Formats unknown. Explain that once, without internal reasons. */
export function FormatStandings({
  standing,
  labelledBy,
}: {
  standing: EditionStandings;
  labelledBy: string;
}) {
  const known = FORMATS.filter(
    ({ value }) => standing[value].status !== "unknown"
  );
  const unknown = FORMATS.filter(
    ({ value }) => standing[value].status === "unknown"
  );
  return (
    <>
      {known.length > 0 && (
        <ul
          aria-labelledby={labelledBy}
          className="m-0 flex list-none flex-wrap gap-1.5 p-0"
        >
          {known.map(({ value, label }) => {
            const { status } = standing[value];
            return (
              <li key={value}>
                <Pill tone={STANDING_TONES[status]}>
                  {label}: {STANDING_WORDS[status]}
                </Pill>
              </li>
            );
          })}
        </ul>
      )}
      {unknown.length > 0 && (
        <p className="m-0 text-meta text-text-muted">
          {new Intl.ListFormat("en", { type: "conjunction" }).format(
            unknown.map(({ label }) => label)
          )}{" "}
          legality unknown
        </p>
      )}
    </>
  );
}
