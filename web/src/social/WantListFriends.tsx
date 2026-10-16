import { useId, type ReactNode } from "react";
import { editionText } from "../decks/wantListModel";
import type { FriendCopy } from "../social_generated";
import { Pill } from "../ui/Pill";
import type { CombinedRow } from "../want_list_generated";
import { CardImage } from "./FriendCollectionPage";
import { chipText, lendableText, otherEditionText } from "./friendCards";

/**
 * A Want List line's Friend chips (#251, the Friends' cards verdict): "Friends:" and one chip per Friend and Edition
 * that matches the line, "Misty W. · 2 spare · 1 in a Deck", spare copies first (the order the API gives). A copy of
 * another Edition says which. Nothing when no Friend has one.
 *
 * The chips only say who can lend until Borrow Requests (#252), which passes `chip` to draw each one as the control
 * that asks for a copy.
 */
export function FriendChips({
  name,
  wanted,
  copies,
  chip,
}: {
  /** The card's name, for the list's accessible name. */
  name: string;
  /** The line's Edition. */
  wanted: string;
  copies: FriendCopy[] | undefined;
  chip?: (copy: FriendCopy, text: string) => ReactNode;
}) {
  if (!copies || copies.length === 0) return null;
  return (
    <div className="col-span-full flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      <span className="text-meta text-text-muted">Friends:</span>
      <ul
        aria-label={`Friends who can lend ${name}`}
        className="m-0 flex min-w-0 list-none flex-wrap gap-1 p-0"
      >
        {copies.map((copy) => {
          const text = chipText(copy, wanted);
          return (
            <li
              key={`${copy.collector_id}:${copy.edition_id}`}
              className="min-w-0 max-w-full"
            >
              {chip ? chip(copy, text) : <Pill>{text}</Pill>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * The Want List's Get from Friends view (#251, variant D): one panel per card the page needs that a Friend can lend,
 * with its image left of the heading, the card and its Edition, "You need 4 · <Decks>", and one row per Friend
 * (Display Name, Handle, spare and in-a-Deck counts, and the Edition when it differs), spare copies first. The cards
 * no Friend can lend are summed up in one line under the panels. The need and the Decks are the Want List's combined
 * total for the scope on the page, so they follow the counting setting and the Deck chips.
 *
 * Asking arrives with Borrow Requests (#252): it passes `action` for each Friend's row.
 */
export function GetFromFriends({
  rows,
  byCard,
  deckName,
  action,
}: {
  rows: CombinedRow[];
  byCard: Map<string, FriendCopy[]>;
  deckName: (id: string) => string;
  action?: (row: CombinedRow, copy: FriendCopy) => ReactNode;
}) {
  if (rows.length === 0)
    return (
      <p className="m-0 text-body text-text-muted">
        Every Deck can be built from your Collection.
      </p>
    );
  const lendable = rows.filter(
    (row) => (byCard.get(row.edition_id) ?? []).length > 0
  );
  const missing = rows.length - lendable.length;
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <p className="m-0 text-body text-text-muted">
        Cards you need that Friends can lend.
      </p>
      {lendable.map((row) => (
        <CardPanel
          key={row.edition_id}
          row={row}
          copies={byCard.get(row.edition_id)!}
          deckName={deckName}
          action={action}
        />
      ))}
      {missing > 0 && (
        <p className="m-0 text-body text-text-muted">
          {missing === 1
            ? "1 card you need isn't available from any Friend."
            : `${missing} cards you need aren't available from any Friend.`}
        </p>
      )}
    </div>
  );
}

function CardPanel({
  row,
  copies,
  deckName,
  action,
}: {
  row: CombinedRow;
  copies: FriendCopy[];
  deckName: (id: string) => string;
  action?: (row: CombinedRow, copy: FriendCopy) => ReactNode;
}) {
  const headingId = useId();
  const decks = row.decks.map((deck) => deckName(deck.deck_id)).join(" · ");
  return (
    <section
      aria-labelledby={headingId}
      className="rounded-panel border border-border bg-surface"
    >
      <div className="grid grid-cols-[2.5rem_minmax(0,1fr)] items-center gap-3 px-4 py-3">
        <CardImage url={row.image_url} />
        <div className="min-w-0">
          <h3
            id={headingId}
            className="m-0 text-body font-semibold wrap-anywhere"
          >
            {row.name}
          </h3>
          <p className="m-0 text-meta text-text-muted wrap-anywhere">
            {editionText(row)}
          </p>
          <p className="m-0 text-meta text-text-muted wrap-anywhere">
            You need {row.need} · {decks}
          </p>
        </div>
      </div>
      <ul
        aria-label={`Friends who can lend ${row.name}`}
        className="m-0 list-none border-t border-border p-0"
      >
        {copies.map((copy) => {
          const other = otherEditionText(copy, row.edition_id);
          return (
            <li
              key={`${copy.collector_id}:${copy.edition_id}`}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-4 py-2 last:border-b-0"
            >
              <span className="min-w-0 flex-1 wrap-anywhere">
                <span className="text-body font-medium">
                  {copy.display_name}
                </span>{" "}
                <span className="text-meta text-text-subtle">
                  @{copy.handle}
                </span>
              </span>
              <span className="flex flex-wrap gap-1">
                <Pill>{lendableText(copy)}</Pill>
                {other && <Pill>{other}</Pill>}
              </span>
              {action?.(row, copy)}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
