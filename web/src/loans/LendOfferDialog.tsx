import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import {
  getFriends,
  sendLendOffer,
  SocialError,
  type Collector,
} from "../social_generated";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { Select } from "../ui/Select";
import { TextField } from "../ui/TextField";
import type { LendRow } from "../workspace/inventoryActionsModel";
import { cardCount, outcomeUnknown, today } from "./loanText";

type Friends =
  | { kind: "loading" }
  | { kind: "failed" }
  | { kind: "ready"; friends: Collector[] };

type Sent = { id: string; friend: string };

/** What an offer that couldn't be sent says. `card` names a selected card by its Edition id. */
function offerMessage(
  cause: unknown,
  friend: string,
  card: (editionId: string) => string
): string {
  if (outcomeUnknown(cause))
    return "The offer may not have been sent. Check your connection and try again.";
  const error = cause as SocialError;
  switch (error.code) {
    case "NOT_ENOUGH_COPIES": {
      const available = String(error.detail.available ?? "0");
      const name = card(String(error.detail.edition_id ?? ""));
      return available === "0"
        ? `${name} is already promised to another Loan.`
        : `Only ${available} of ${name} can be lent from there now.`;
    }
    case "NOT_FRIENDS":
      return `${friend} isn't one of your Friends anymore.`;
    case "INVALID_RETURN_BY":
      return "Choose a return-by date from today on.";
    case "TOO_MANY_CHANGES":
      return "Too many changes in a short time. Try again in a few minutes.";
    default:
      return "The offer couldn't be sent. Check it and try again.";
  }
}

/**
 * **Lend to a Friend…** from the Collection's selection bar (social network #258, spec "Starting a Lend Offer"): the
 * selected copies, a Friend to offer them to, an optional return-by date, and **Send offer**. Sending reserves the
 * copies where they are; the dialog then says so, with focus on Open the Loan. One key per offer until it settles,
 * so a retry after a lost answer never sends it twice. Friends that couldn't be read offer Retry, which keeps focus on
 * the Friend field.
 */
export function LendOfferDialog({
  open,
  rows,
  onClose,
  onSent,
  onOpenLoan,
  returnFocus,
}: {
  open: boolean;
  rows: LendRow[];
  onClose: () => void;
  /** The offer went out: the selection is done with. */
  onSent: () => void;
  onOpenLoan: (id: string) => void;
  returnFocus?: RefObject<HTMLElement | null>;
}) {
  const [friends, setFriends] = useState<Friends>({ kind: "loading" });
  const [friendId, setFriendId] = useState("");
  const [returnBy, setReturnBy] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<Sent | null>(null);
  const [attempt, setAttempt] = useState(0);
  const key = useRef<string | null>(null);
  // Retry after the Friends couldn't be read stays, busy, while they are read again; then focus moves to the Friend
  // field, or stays on Retry if they still can't be read.
  const friendField = useRef<HTMLSelectElement>(null);
  const [retrying, setRetrying] = useState(false);
  useLayoutEffect(() => {
    if (!retrying || friends.kind === "loading") return;
    setRetrying(false);
    if (friends.kind === "ready") friendField.current?.focus();
  }, [retrying, friends.kind]);
  // Sending replaces Send offer: focus moves to Open the Loan, so it never falls to the page.
  const openButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (sent) openButton.current?.focus();
  }, [sent]);

  useEffect(() => {
    if (!open) return;
    setFriendId("");
    setReturnBy("");
    setMessage("");
    setSent(null);
    setRetrying(false);
    key.current = null;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setFriends({ kind: "loading" });
    getFriends().then(
      (view) => live && setFriends({ kind: "ready", friends: view.friends }),
      () => live && setFriends({ kind: "failed" })
    );
    return () => {
      live = false;
    };
  }, [open, attempt]);

  const copies = rows.reduce((sum, row) => sum + row.count, 0);
  const friendName =
    friends.kind === "ready"
      ? (friends.friends.find((friend) => friend.collector_id === friendId)
          ?.display_name ?? "")
      : "";
  // One line per card, however many Locations its copies are in.
  const cards = new Map<string, { card: string; count: number }>();
  for (const row of rows) {
    const found = cards.get(row.editionId);
    if (found) found.count += row.count;
    else cards.set(row.editionId, { card: row.card, count: row.count });
  }

  async function send() {
    if (busy || !friendId) return;
    setBusy(true);
    setMessage("");
    key.current ??= crypto.randomUUID();
    try {
      const loan = await sendLendOffer({
        borrower_id: friendId,
        copies: rows.map((row) => ({
          location_id: row.locationId,
          edition_id: row.editionId,
          quantity: String(row.count),
        })),
        return_by: returnBy || null,
        idempotency_key: key.current,
      });
      key.current = null;
      setSent({ id: loan.id, friend: friendName });
      onSent();
    } catch (cause) {
      if (!outcomeUnknown(cause)) key.current = null;
      setMessage(
        offerMessage(cause, friendName, (id) => cards.get(id)?.card ?? "a card")
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Lend to a Friend"
      closeLabel="Close Lend to a Friend"
      returnFocus={returnFocus}
    >
      {sent ? (
        <div className="flex flex-col gap-3">
          <p role="status" className="m-0 text-body">
            Offer sent to {sent.friend}.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              ref={openButton}
              variant="primary"
              onClick={() => onOpenLoan(sent.id)}
            >
              Open the Loan
            </Button>
            <Button onClick={onClose}>Done</Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <ul
            aria-label="Cards to lend"
            className="m-0 flex list-none flex-col gap-1 p-0"
          >
            {[...cards.entries()].map(([edition, { card, count }]) => (
              <li key={edition} className="text-body wrap-anywhere">
                {count} × {card}
              </li>
            ))}
          </ul>
          {friends.kind === "ready" && friends.friends.length === 0 ? (
            <p className="m-0 text-body text-text-muted">
              Add a Friend first to lend them cards.
            </p>
          ) : (
            <Select
              ref={friendField}
              label="Friend"
              value={friendId}
              disabled={friends.kind !== "ready"}
              onChange={(event) => {
                key.current = null;
                setFriendId(event.target.value);
              }}
            >
              <option value="">
                {friends.kind === "failed"
                  ? "Your Friends couldn't be loaded"
                  : "Choose a Friend"}
              </option>
              {friends.kind === "ready" &&
                friends.friends.map((friend) => (
                  <option key={friend.collector_id} value={friend.collector_id}>
                    {friend.display_name}
                  </option>
                ))}
            </Select>
          )}
          {(friends.kind === "failed" || retrying) && (
            <Button
              aria-disabled={friends.kind === "loading" || undefined}
              onClick={() => {
                if (friends.kind !== "failed") return;
                setRetrying(true);
                setFriends({ kind: "loading" });
                setAttempt((n) => n + 1);
              }}
            >
              Retry
            </Button>
          )}
          <TextField
            type="date"
            label="Return by (optional)"
            min={today()}
            value={returnBy}
            onChange={(event) => {
              key.current = null;
              setReturnBy(event.target.value);
            }}
          />
          <p role="alert" className="m-0 text-meta text-danger empty:hidden">
            {message}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              disabled={!friendId || copies === 0}
              aria-disabled={busy || undefined}
              onClick={() => void send()}
            >
              Send offer of {cardCount(copies)}
            </Button>
            <Button onClick={onClose}>Cancel</Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
