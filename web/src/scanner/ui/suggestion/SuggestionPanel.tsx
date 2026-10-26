import { Button } from "../../../ui/Button";
import { CardArt } from "../CardArt";
import { NONE_OF_THESE, SUGGESTION_HEADING } from "../copy";
import type { SuggestionView } from "./controller";

/**
 * The Scan Suggestion: a card above the tray peek with each candidate's picture, name, set and number (so reprints
 * can be told apart), and None of these. No scores, no prices. A tap on a candidate adds it.
 */
export function SuggestionPanel({
  view,
  onPick,
  onNone,
  firstRef,
}: {
  view: SuggestionView;
  onPick: (printingId: string) => void;
  onNone: () => void;
  firstRef: React.Ref<HTMLButtonElement>;
}) {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center p-3">
      <div
        role="group"
        aria-label={SUGGESTION_HEADING}
        data-testid="scan-suggestion"
        className="pointer-events-auto box-border flex max-h-full w-full max-w-md flex-col gap-2 overflow-y-auto rounded-panel border border-border-strong bg-surface p-3 shadow-lg"
      >
        <h2 className="m-0 text-body font-semibold text-text">
          {SUGGESTION_HEADING}
        </h2>
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
          {view.candidates.map((card, index) => (
            <li key={card.printingId}>
              <button
                ref={index === 0 ? firstRef : undefined}
                type="button"
                onClick={() => onPick(card.printingId)}
                className="box-border flex min-h-control w-full cursor-pointer items-center gap-3 rounded-control border border-border-strong bg-surface-raised p-2 text-left font-sans text-control text-text hover:border-control-outline phone:min-h-tap"
              >
                <CardArt src={card.image} />
                <span className="flex min-w-0 flex-col">
                  <span className="font-semibold">{card.name}</span>
                  <span className="text-meta text-text-muted">
                    {card.setLine}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
        <Button variant="quiet" onClick={onNone}>
          {NONE_OF_THESE}
        </Button>
      </div>
    </div>
  );
}
