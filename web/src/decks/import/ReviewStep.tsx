import { useId, type Ref } from "react";
import type { ImportReview, ReviewLine } from "../../decks_generated";
import { PageHeader } from "../../shell/PageHeader";
import { Button } from "../../ui/Button";
import { Chip } from "../../ui/Chip";
import { Segmented } from "../../ui/Segmented";
import { countingLabel } from "../../settings/wantListCounting";
import { formatLabel, type TargetFormat } from "../targetFormat";
import {
  filterCount,
  FILTERS,
  fixRefused,
  keeps,
  plural,
  sectionsOf,
  toGetText,
  type Filter,
  type Pick,
} from "./importModel";
import { OWNED_OPTIONS, type OwnedCards } from "./ownedCards";
import { ReviewLineRow } from "./ReviewLineRow";
import type { ImportReviewState } from "./useImportReview";

export type OpenPanel = { line: number; kind: "fix" | "edition" } | null;

type Props = {
  review: ImportReview;
  state: ImportReviewState;
  name: string;
  targetFormat: TargetFormat;
  owned: OwnedCards;
  onOwned: (owned: OwnedCards) => void;
  filter: Filter;
  onFilter: (filter: Filter) => void;
  open: OpenPanel;
  onToggle: (line: number, kind: "fix" | "edition") => void;
  onPick: (line: number, pick: Pick) => void;
  onDrop: (line: number) => void;
  onRestore: (line: number) => void;
  onEdition: (line: number, editionId: string) => void;
  actionRef: (line: number) => Ref<HTMLButtonElement>;
  headingRef: Ref<HTMLHeadingElement>;
  createButtonRef: Ref<HTMLButtonElement>;
  saving: boolean;
  saveMessage: string;
  onBack: () => void;
  onCreate: () => void;
};

/**
 * Import a decklist, step two (#212): "Check the list". The summary sits beside the list on a desktop and above it on a
 * phone: the cards, the cards you own and the cards to get with their stored cost (#214), the owned-cards setting with
 * its explainer (switching it posts the review again, so every line recounts), and the destination. The list shows
 * Pokémon, Trainer, Energy and No section in paste order behind four filter chips; the sticky save bar says how many
 * lines still need the collector and holds Create Deck.
 */
export function ReviewStep({
  review,
  state,
  name,
  targetFormat,
  owned,
  onOwned,
  filter,
  onFilter,
  open,
  onToggle,
  onPick,
  onDrop,
  onRestore,
  onEdition,
  actionRef,
  headingRef,
  createButtonRef,
  saving,
  saveMessage,
  onBack,
  onCreate,
}: Props) {
  const idBase = useId();
  const statusId = `${idBase}-status`;
  const { totals } = review;
  const sections = sectionsOf(review.lines)
    .map((section) => ({
      ...section,
      shown: section.lines.filter((line: ReviewLine) => keeps(filter, line)),
    }))
    .filter((section) => section.shown.length > 0);
  const blocked = !state.current || totals.to_resolve > 0 || saving;
  const explainer = OWNED_OPTIONS.find(
    (option) => option.value === owned
  )!.explainer;
  const message = saveMessage || state.error;
  return (
    <main className="mx-auto box-border flex max-w-7xl flex-col gap-6 px-7 py-6 pb-24 phone:px-4 phone:py-4 phone:pb-28">
      <div className="flex flex-col gap-2">
        <PageHeader title="Check the list" headingRef={headingRef} />
        <p className="m-0 text-body text-text-muted">
          Every line has to be matched or dropped before you can save.
        </p>
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)_18rem] items-start gap-6 phone:grid-cols-1">
        <aside
          aria-label="Import summary"
          className="col-start-2 row-start-1 sticky top-[calc(var(--space-4)+var(--layout-sticky-top))] flex flex-col gap-3 rounded-panel border border-border bg-surface p-4 phone:static phone:col-start-1 phone:row-start-1"
        >
          <div>
            <p className="m-0 text-meta text-text-muted">Cards</p>
            <p className="m-0 text-heading font-semibold tabular-nums">
              {totals.cards}
              {totals.cards !== "60" && (
                <span className="text-meta font-normal text-text-muted">
                  {" "}
                  (not 60)
                </span>
              )}
            </p>
          </div>
          <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-body">
            <dt className="text-text-muted">You own</dt>
            <dd className="m-0 tabular-nums">
              {plural(Number(totals.owned), "card")}
            </dd>
            <dt className="text-text-muted">To get</dt>
            <dd className="m-0 tabular-nums">{toGetText(totals)}</dd>
          </dl>
          <div className="flex flex-col gap-1">
            <p className="m-0 text-meta text-text-muted">Owned cards</p>
            <Segmented
              mode="choice"
              label="Owned cards"
              options={OWNED_OPTIONS}
              value={owned}
              onChange={onOwned}
            />
            <p className="m-0 text-meta text-text-muted">{explainer}</p>
            <p className="m-0 text-meta text-text-muted">
              Copies are counted as your Want List counts them:{" "}
              {countingLabel(review.want_list_counting)}.
            </p>
          </div>
          <p className="m-0 text-body">
            New Deck <strong className="font-semibold">{name}</strong> · Target
            Format{" "}
            <strong className="font-semibold">
              {formatLabel(targetFormat)}
            </strong>
          </p>
        </aside>
        <div className="col-start-1 row-start-1 flex min-w-0 flex-col gap-4 phone:row-start-2">
          <div
            role="group"
            aria-label="Show lines"
            className="flex flex-wrap gap-1"
          >
            {FILTERS.map(({ value, label }) => (
              <Chip
                key={value}
                selected={filter === value}
                onChange={() => onFilter(value)}
              >
                {`${label} ${filterCount(value, review)}`}
              </Chip>
            ))}
          </div>
          {sections.map((section) => (
            <section
              key={section.key}
              aria-labelledby={`${idBase}-${section.key}`}
              className="flex flex-col gap-1"
            >
              <h2
                id={`${idBase}-${section.key}`}
                className="m-0 text-heading font-semibold"
              >
                {section.label} · {section.cards}
              </h2>
              <ul
                aria-label={section.label}
                className="m-0 flex list-none flex-col p-0"
              >
                {section.shown.map((line) => (
                  <ReviewLineRow
                    key={line.line}
                    line={line}
                    open={open?.line === line.line ? open.kind : null}
                    onToggle={(kind) => onToggle(line.line, kind)}
                    onPick={(pick) => onPick(line.line, pick)}
                    onDrop={() => onDrop(line.line)}
                    onRestore={() => onRestore(line.line)}
                    onEdition={(editionId) => onEdition(line.line, editionId)}
                    actionRef={actionRef(line.line)}
                  />
                ))}
              </ul>
            </section>
          ))}
          {sections.length === 0 && (
            <p className="m-0 text-body text-text-muted">
              {filter === "needs" ? "No lines need you." : "Nothing here."}
            </p>
          )}
          {review.ignored.length > 0 && (
            <details>
              <summary className="flex min-h-control cursor-pointer items-center text-meta text-text-muted phone:min-h-tap">
                {plural(review.ignored.length, "line")} ignored: not cards
              </summary>
              <ul className="m-0 flex list-none flex-col gap-1 p-0 text-meta text-text-muted">
                {review.ignored.map((ignored) => (
                  <li key={ignored.line} className="wrap-anywhere">
                    {ignored.text}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      </div>
      <section
        aria-label="Save"
        className="sticky bottom-0 z-(--layer-sticky) mt-4 flex flex-wrap items-center gap-2 border-t border-border bg-bg py-3 phone:bottom-tabbar"
      >
        <p id={statusId} role="status" className="m-0 grow text-body">
          {totals.to_resolve > 0 ? (
            <>
              <strong className="text-warning">
                {plural(totals.to_resolve, "line")} to resolve
              </strong>{" "}
              before you can save
            </>
          ) : (
            `Ready · ${plural(Number(totals.cards), "card")} · ${plural(review.deck_list.length, "Deck List line")}`
          )}
        </p>
        {message && (
          <p role="status" className="m-0 basis-full text-body text-warning">
            {message}
            {state.error && !fixRefused(state.code) && (
              <>
                {" "}
                <Button onClick={state.retry}>Retry</Button>
              </>
            )}
          </p>
        )}
        <Button onClick={onBack}>Back to paste</Button>
        <Button
          ref={createButtonRef}
          variant="primary"
          aria-describedby={statusId}
          aria-disabled={blocked || undefined}
          onClick={onCreate}
        >
          Create Deck
        </Button>
      </section>
    </main>
  );
}
