import { useId, type ReactNode } from "react";
import { editionText } from "../decks/wantListModel";
import type { FriendCopy } from "../social_generated";
import { Pill } from "../ui/Pill";
import type { CombinedRow } from "../want_list_generated";
import { CopyArt } from "../ui/CopyTile";
import { chipText, lendableText, otherEditionText } from "./friendCards";

/**
 * A Want List line's Friend chips (#251, the Friends' cards verdict): "Friends:" and one chip per Friend and Edition
 * that matches the line, "Misty W. · 2 spare · 1 in a Deck", spare copies first (the order the API gives). A copy of
 * another Edition says which. Nothing when no Friend has one.
 *
 * Borrow Requests (#252) pass `chip` to draw each one as the control that asks for a copy (loans/BorrowDrafts'
 * AskChip); without it a chip only says who can lend.
 */
export function FriendChips({
  name,
  edition,
  wanted,
  copies,
  chip,
}: {
  /** The card's name, for the list's accessible name. */
  name: string;
  /** The line's Edition as text, so two Editions of one name get lists of their own. */
  edition: string;
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
        aria-label={`Friends who can lend ${name}, ${edition}`}
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
 * Borrow Requests (#252) pass `action` for each Friend's row (Ask, then a stepper) and `asked`, the copies of a card
 * the drafts ask for, which the panel's heading shows as "3 of 4 asked".
 */
export function GetFromFriends({
  rows,
  byCard,
  deckName,
  scoped,
  pending,
  action,
  asked,
}: {
  rows: CombinedRow[];
  byCard: Map<string, FriendCopy[]>;
  deckName: (id: string) => string;
  /** The Deck the Want List is scoped to, or null for all Decks. */
  scoped: string | null;
  /** The Friends' cards for this scope aren't in yet (or couldn't be read): no line about what they lack. */
  pending: boolean;
  action?: (row: CombinedRow, copy: FriendCopy) => ReactNode;
  /** Copies of the row's card the Borrow Request drafts ask Friends for. */
  asked?: (row: CombinedRow, copies: FriendCopy[]) => number;
}) {
  if (rows.length === 0)
    return (
      <p className="m-0 text-body text-text-muted">
        {scoped
          ? `${scoped} can be built from your Collection.`
          : "Every Deck can be built from your Collection."}
      </p>
    );
  const lendable = rows.filter(
    (row) => (byCard.get(row.edition_id) ?? []).length > 0
  );
  const missing = rows.length - lendable.length;
  return (
    <div className="flex min-w-0 flex-col gap-4">
      {!pending && lendable.length > 0 && (
        <p className="m-0 text-body text-text-muted">
          Cards you need that Friends can lend.
        </p>
      )}
      {lendable.map((row) => (
        <CardPanel
          key={row.edition_id}
          row={row}
          copies={byCard.get(row.edition_id)!}
          deckName={deckName}
          action={action}
          asked={asked}
        />
      ))}
      {!pending && missing > 0 && (
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
  asked,
}: {
  row: CombinedRow;
  copies: FriendCopy[];
  deckName: (id: string) => string;
  action?: (row: CombinedRow, copy: FriendCopy) => ReactNode;
  asked?: (row: CombinedRow, copies: FriendCopy[]) => number;
}) {
  const headingId = useId();
  const askedCopies = asked?.(row, copies) ?? 0;
  const editionId = useId();
  const decks = row.decks.map((deck) => deckName(deck.deck_id)).join(" · ");
  return (
    <section
      aria-labelledby={`${headingId} ${editionId}`}
      className="grid min-w-0 grid-cols-[var(--tile-small)_minmax(0,1fr)] gap-x-3 rounded-panel border border-border bg-surface p-3 phone:grid-cols-[64px_minmax(0,1fr)]"
    >
      <CopyArt
        name={row.name}
        imageUrl={row.image_url}
        className="row-span-2 phone:row-span-1"
      />
      <div className="flex min-w-0 flex-wrap items-center gap-3 pb-3">
        <div className="min-w-0">
          <h3
            id={headingId}
            className="m-0 text-body font-semibold wrap-anywhere"
          >
            {row.name}
          </h3>
          <p
            id={editionId}
            className="m-0 text-meta text-text-muted wrap-anywhere"
          >
            {editionText(row)}
          </p>
          <p className="m-0 text-meta text-text-muted wrap-anywhere">
            You need {row.need} · {decks}
          </p>
        </div>
        {asked && (
          <span>
            <Pill tone={askedCopies >= Number(row.need) ? "ok" : "neutral"}>
              {askedCopies} of {row.need} asked
            </Pill>
          </span>
        )}
      </div>
      <ul
        aria-label={`Friends who can lend ${row.name}, ${editionText(row)}`}
        className="col-start-2 m-0 min-w-0 list-none border-t border-border p-0 phone:col-span-full phone:col-start-1"
      >
        {copies.map((copy) => {
          const other = otherEditionText(copy, row.edition_id);
          return (
            <li
              key={`${copy.collector_id}:${copy.edition_id}`}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-4 py-2 last:border-b-0 phone:px-0"
            >
              <span className="min-w-0 flex-1 wrap-anywhere phone:basis-full">
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
