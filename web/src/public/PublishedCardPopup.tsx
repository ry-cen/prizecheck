import type { ReactNode, RefObject } from "react";
import type { DeckLine } from "../decks/deckListModel";
import { formatLabel, statusOf } from "../decks/targetFormat";
import type { PublishedFormatCheck } from "../format_checks_generated";
import { CardArt, CardPopup } from "../ui/CardPopup";
import { Pill } from "../ui/Pill";
import {
  cardPrice,
  lineLegality,
  PRICE_UNAVAILABLE,
  type Prices,
} from "./publishedDeckModel";

type Props = {
  /** The deck's lines in the panel's order; the popup steps through them. */
  lines: readonly DeckLine[];
  /** Each line's large picture address by line key (the page is anonymous: no art route). */
  largeArt: ReadonlyMap<string, string | null>;
  /** The line shown, or null while closed. */
  index: number | null;
  onIndex: (index: number) => void;
  onClose: () => void;
  returnFocus: RefObject<HTMLElement | null>;
  prices: Prices;
  /** The snapshot's Target Format and its result, or null while it is checked (or couldn't be). */
  targetFormat: string;
  result: PublishedFormatCheck | null;
  /** The result couldn't be read. */
  resultFailed: boolean;
};

/** A label and its value, one row of the details column. */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-caption font-medium text-text-subtle">{label}</dt>
      <dd className="m-0 text-body wrap-anywhere">{children}</dd>
    </div>
  );
}

/**
 * The read-only card popup on a Published Deck (#183): the art, the Edition (set, number and Variant), one card's
 * price and its standing in the snapshot's Target Format with the reasons of any card-level issue, and "‹ N / M ›"
 * with ← → stepping through the deck's lines. No ±1, Swap or Gather: nothing here changes anything.
 */
export function PublishedCardPopup({
  lines,
  largeArt,
  index,
  onIndex,
  onClose,
  returnFocus,
  prices,
  targetFormat,
  result,
  resultFailed,
}: Props) {
  const line = index === null ? null : (lines[index] ?? null);
  const shown = index ?? 0;
  const format = formatLabel(targetFormat);
  const price = line ? cardPrice(prices, line.line.edition_id) : null;
  const legality =
    line && result ? lineLegality(result, line.line.edition_id) : null;
  const status = legality ? statusOf(legality.status) : null;
  return (
    <CardPopup
      open={line !== null}
      onClose={onClose}
      title={line?.line.name ?? ""}
      position={{ index: shown, total: lines.length }}
      canPrevious={shown > 0}
      canNext={shown < lines.length - 1}
      onPrevious={() => onIndex(Math.max(0, shown - 1))}
      onNext={() => onIndex(Math.min(lines.length - 1, shown + 1))}
      cardKey={line?.line.edition_id ?? ""}
      announcement={
        line ? `Card ${shown + 1} of ${lines.length}: ${line.line.name}` : ""
      }
      returnFocus={returnFocus}
      art={
        line && (
          <CardArt
            url={line.line.image_url}
            largeUrl={largeArt.get(line.line.edition_id) ?? null}
            name={line.line.name}
          />
        )
      }
    >
      {line && (
        <dl className="m-0 flex flex-col gap-3">
          <Row label="Edition">
            {line.line.set_name} ({line.line.set_id}) · #
            {line.line.collector_number}
            <span className="block text-meta text-text-muted">
              {line.variant}
            </span>
          </Row>
          <Row label="In this deck">
            {line.quantity.toString()}{" "}
            {line.quantity === 1n ? "copy" : "copies"}
          </Row>
          <Row label="Price">
            <span className="tabular-nums">
              {price === null
                ? "Checking price…"
                : price === "No price"
                  ? "No price yet"
                  : price === PRICE_UNAVAILABLE
                    ? PRICE_UNAVAILABLE
                    : `${price} each`}
            </span>
          </Row>
          <Row label={format}>
            {legality && status ? (
              <span className="flex flex-col gap-1">
                <span>
                  <Pill tone={status.tone}>
                    <span aria-hidden="true">{status.mark}&nbsp;</span>
                    {status.text}
                  </Pill>
                </span>
                {legality.reasons.map((reason) => (
                  <span key={reason} className="text-meta text-text-muted">
                    {reason}
                  </span>
                ))}
              </span>
            ) : resultFailed ? (
              <span className="text-text-muted">
                The {format} result couldn't be checked.
              </span>
            ) : (
              <span className="text-text-muted">Checking {format}…</span>
            )}
          </Row>
        </dl>
      )}
    </CardPopup>
  );
}
