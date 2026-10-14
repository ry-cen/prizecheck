import { useId, type RefObject } from "react";
import type {
  BrowseEdition,
  EditionStandings,
} from "../catalog_browse_generated";
import { ART_NOTE, FORMATS, STANDING_WORDS } from "../catalog/catalogText";
import { EditionPrice } from "../EditionPrice";
import { CardArt, CardPopup } from "../ui/CardPopup";
import { Pill, type PillTone } from "../ui/Pill";
import { variantLabel } from "../ui/variantLabel";
import { DeckListStepper, EditFeedbackLine } from "./DeckListStepper";
import type { EditFeedback } from "./useDeckListEdits";

const TONES: Record<keyof typeof STANDING_WORDS, PillTone> = {
  legal: "ok",
  not_legal: "bad",
  unknown: "unverified",
};
const HEADING = "m-0 text-meta font-semibold text-text-muted";
const META = "m-0 text-meta text-text-muted";

type Props = {
  /** The library row shown, or null while closed. */
  row: BrowseEdition | null;
  onClose: () => void;
  /** "‹ N / M ›" among the library's results (index from 0), or null. */
  position: { index: number; total: number } | null;
  canPrevious: boolean;
  canNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
  /** Copies of this Edition on the Deck List, edits on their way included. */
  quantity: bigint;
  /** −1 or +1 on the Deck List. */
  onChange: (delta: bigint) => void;
  feedback: EditFeedback | null;
  /** Feedback with this id or lower came before the popup opened. */
  since: number;
  returnFocus: RefObject<HTMLElement | null>;
};

/** "2 free of 3 owned (1 in this Deck)", or "Not owned". */
export function ownedWords(row: BrowseEdition): string {
  if (row.owned <= 0) return "Not owned";
  const free = row.free ?? row.owned;
  const inDeck = row.in_deck ?? 0;
  return `${free} free of ${row.owned} owned${inDeck > 0 ? ` (${inDeck} in this Deck)` : ""}`;
}

/**
 * The deck builder library's card popup (#177, spec "Deck builder": a tap opens CardPopup with −1 / N on Deck List /
 * +1 and ‹ › stepping). It shows the card from its library row (the browse route with deck_id), with no read of its
 * own: the art, set, number and Variant, the regulation mark, copies free of owned, the price and a legality Pill per
 * Format with the reason for an unknown one. The stepper adds to or takes from the Deck List and never moves a card.
 */
export function LibraryCardPopup({
  row,
  onClose,
  position,
  canPrevious,
  canNext,
  onPrevious,
  onNext,
  quantity,
  onChange,
  feedback,
  since,
  returnFocus,
}: Props) {
  const name = row?.name ?? "";
  return (
    <CardPopup
      open={row !== null}
      onClose={onClose}
      title={name}
      position={position}
      canPrevious={canPrevious}
      canNext={canNext}
      onPrevious={onPrevious}
      onNext={onNext}
      cardKey={row?.edition_id ?? ""}
      announcement={
        position && row
          ? `Card ${(position.index + 1).toLocaleString()} of ${position.total.toLocaleString()}: ${name}`
          : ""
      }
      returnFocus={returnFocus}
      art={<CardArt url={row?.image_url ?? null} name={name} />}
      artNote={ART_NOTE}
    >
      {row && (
        <>
          <div className="flex flex-col gap-1">
            <p className="m-0">
              {row.set_name} ({row.set_code}) · #{row.collector_number} ·{" "}
              {variantLabel(row.descriptor)}
            </p>
            <p className={META}>
              {row.regulation_mark
                ? `Regulation mark ${row.regulation_mark}`
                : "No regulation mark recorded"}
            </p>
            <p className="m-0 tabular-nums">{ownedWords(row)}</p>
            <p className={META}>
              <EditionPrice key={row.edition_id} editionId={row.edition_id} />
            </p>
          </div>
          <Legality standing={row.standing} />
          <div className="flex flex-col gap-1.5">
            <h3 className={HEADING}>Deck List</h3>
            <DeckListStepper quantity={quantity} onChange={onChange} />
            <EditFeedbackLine feedback={feedback} since={since} />
          </div>
        </>
      )}
    </CardPopup>
  );
}

/** One Pill per Format, and the reasons behind an unknown standing. */
function Legality({ standing }: { standing: EditionStandings }) {
  const headingId = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <h3 id={headingId} className={HEADING}>
        Legality
      </h3>
      <ul
        aria-labelledby={headingId}
        className="m-0 flex list-none flex-wrap gap-1.5 p-0"
      >
        {FORMATS.map((format) => {
          const { status } = standing[format.value];
          return (
            <li key={format.value}>
              <Pill tone={TONES[status]}>
                {format.label}: {STANDING_WORDS[status]}
              </Pill>
            </li>
          );
        })}
      </ul>
      {FORMATS.filter(
        (format) => standing[format.value].status === "unknown"
      ).map((format) => (
        <p key={format.value} className={META}>
          {format.label} legality unknown:{" "}
          {standing[format.value].reasons.join(" ") ||
            "no reason was recorded."}
        </p>
      ))}
    </div>
  );
}
