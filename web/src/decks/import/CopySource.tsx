import { Button } from "../../ui/Button";
import { copyGone } from "./copyModel";
import { plural, sectionsOf } from "./importModel";
import type { ImportReviewState } from "./useImportReview";

type Props = {
  state: ImportReviewState;
  /** The Published Deck was republished during the copy, so the collector's choices were cleared. */
  updated: boolean;
};

/**
 * Copy to my Decks (#216), the paste screen's left column in place of the text box: the Published Deck's cards as the
 * review read them, by section, each as "2 Nest Ball SVI 181", with the live count. A revoked Published Deck says it
 * can't be copied, with no Retry.
 */
export function CopySource({ state, updated }: Props) {
  const review = state.review;
  const source = review?.publication;
  return (
    <>
      {updated && (
        <p className="m-0 text-body text-warning">
          This Published Deck was updated after you opened it. This is its new
          list.
        </p>
      )}
      {review && source && (
        <>
          <p className="m-0 text-body">
            From <strong className="font-semibold">{source.title}</strong>
          </p>
          {sectionsOf(review.lines).map((section) => (
            <div key={section.key} className="flex flex-col gap-1">
              <h2 className="m-0 text-heading font-semibold">
                {section.label} · {section.cards}
              </h2>
              <ul
                aria-label={section.label}
                className="m-0 flex list-none flex-col gap-0.5 p-0 text-body"
              >
                {section.lines.map((line) => (
                  <li key={line.line} className="wrap-anywhere">
                    {line.text}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </>
      )}
      <p
        role="status"
        className="m-0 flex flex-wrap items-center gap-2 text-meta text-text-muted"
      >
        {state.error ? (
          <>
            {state.error}
            {!copyGone(state.code) && (
              <Button onClick={state.retry}>Retry</Button>
            )}
          </>
        ) : !review ? (
          "Reading the Published Deck…"
        ) : (
          `${plural(review.totals.card_lines, "card line")} · ${plural(Number(review.totals.cards), "card")}`
        )}
      </p>
    </>
  );
}
