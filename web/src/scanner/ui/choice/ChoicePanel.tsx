import { Button } from "../../../ui/Button";
import { ChoiceChips } from "../../../ui/Chip";
import { ScrollArea } from "../../../ui/ScrollArea";
import { CardArt } from "../CardArt";
import {
  CHOICE_FINISH_HEADING,
  CHOICE_VERSION_HEADING,
  NONE_OF_THESE,
  SUGGESTION_HEADING,
} from "../copy";
import type { ChoiceView, Version } from "./controller";

const HEADING = {
  suggest: SUGGESTION_HEADING,
  version: CHOICE_VERSION_HEADING,
  finish: CHOICE_FINISH_HEADING,
} as const;

function Details({ version, finish }: { version: Version; finish?: string }) {
  return (
    <>
      <CardArt src={version.image} />
      <span className="flex min-w-0 flex-col">
        <span className="font-semibold">{version.name}</span>
        <span className="text-meta text-text-muted">
          {version.setLine}
          {finish ? ` · ${finish}` : ""}
        </span>
      </span>
    </>
  );
}

/**
 * The Scan Choice: a card above the tray peek with each version's picture, name, set and number (so reprints can be
 * told apart), and None of these. A version with one finish is a button that adds it (its finish shown after the set
 * and number); a version with several shows finish chips with none selected, and a tap on a chip adds that finish.
 * No scores, no prices.
 */
export function ChoicePanel({
  view,
  onPick,
  onNone,
  listRef,
}: {
  view: ChoiceView;
  onPick: (printingId: string, editionId: string) => void;
  onNone: () => void;
  listRef: React.Ref<HTMLUListElement>;
}) {
  const heading = HEADING[view.kind];
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center p-3">
      <div
        role="group"
        aria-label={heading}
        data-testid="scan-suggestion"
        className="pointer-events-auto box-border flex max-h-full w-full max-w-md flex-col rounded-panel border border-border-strong bg-surface shadow-lg"
      >
        <ScrollArea
          className="flex-1"
          viewportClassName="flex flex-col gap-2 p-3"
        >
          <h2 className="m-0 text-body font-semibold text-text">{heading}</h2>
          <ul ref={listRef} className="m-0 flex list-none flex-col gap-1.5 p-0">
            {view.versions.map((version) => (
              <li key={version.printingId}>
                {version.editions.length === 1 ? (
                  <button
                    type="button"
                    onClick={() =>
                      onPick(version.printingId, version.editions[0].id)
                    }
                    className="box-border flex min-h-control w-full cursor-pointer items-center gap-3 rounded-control border border-border-strong bg-surface-raised p-2 text-left font-sans text-control text-text hover:border-control-outline phone:min-h-tap"
                  >
                    <Details
                      version={version}
                      finish={version.editions[0].label}
                    />
                  </button>
                ) : (
                  <div className="box-border flex w-full flex-col gap-1.5 rounded-control border border-border-strong bg-surface-raised p-2 text-control text-text">
                    <div className="flex items-center gap-3">
                      <Details version={version} />
                    </div>
                    <ChoiceChips
                      label={`Finish of ${version.name}, ${version.setLine}`}
                      options={version.editions.map((e) => ({
                        value: e.id,
                        label: e.label,
                      }))}
                      value={null}
                      onChange={(edition) =>
                        onPick(version.printingId, edition)
                      }
                    />
                  </div>
                )}
              </li>
            ))}
          </ul>
          <Button variant="quiet" onClick={onNone}>
            {NONE_OF_THESE}
          </Button>
        </ScrollArea>
      </div>
    </div>
  );
}
