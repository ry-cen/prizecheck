import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { CardImage } from "../social/FriendCollectionPage";
import {
  getBorrowed,
  moveBorrowed,
  SocialError,
  type BorrowedCard,
  type BorrowedCopies,
} from "../social_generated";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { Select } from "../ui/Select";
import { Stepper } from "../ui/Stepper";
import { leavesOf } from "../workspace/InventoryDialogs";
import type { LocationIndex } from "../workspace/locationTree";
import { outcomeUnknown } from "./loanText";

type Load =
  | { kind: "loading" }
  | { kind: "failed" }
  | { kind: "ready"; view: BorrowedCopies };

const rowKey = (card: BorrowedCard) =>
  `${card.loan_id}:${card.edition_id}:${card.location_id}`;

/** What a refused Move says. A refusal that means the list is out of date reads it again. */
function moveMessage(cause: unknown): string {
  if (cause instanceof SocialError && cause.code === "NOT_ENOUGH_BORROWED")
    return "Those copies aren't there any more. The list is up to date now.";
  if (cause instanceof SocialError && cause.code === "LOCATION_NOT_FOUND")
    return "That Location is gone. Choose another.";
  if (cause instanceof SocialError && cause.code === "TOO_MANY_CHANGES")
    return "Too many changes in a short time. Try again in a few minutes.";
  return "The cards couldn't be moved. Try again.";
}

/**
 * The Collection's **Borrowed** list (social network #254, spec "Inventory touch-points"): every Friend's copy in the
 * collector's Locations, each row "2 from Misty W." with the Location it is in, and Move… to put it in another of
 * their Locations. Borrowed Copies move only here: the gallery and its Move never show them. Read each time it opens.
 */
export function BorrowedDialog({
  open,
  onClose,
  index,
  onMoved,
  returnFocus,
}: {
  open: boolean;
  onClose: () => void;
  /** The collector's Locations: the Move destinations are its Storage Leaves and Decks. */
  index: LocationIndex;
  /** A Move landed: the collector's inventory revision moved on. */
  onMoved: () => void;
  returnFocus?: RefObject<HTMLElement | null>;
}) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  // The row whose Move form is open, its destination and copies.
  const [moving, setMoving] = useState<string | null>(null);
  const [destination, setDestination] = useState("");
  const [copies, setCopies] = useState(1);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const pending = useRef<string | null>(null);
  const leaves = useMemo(() => leavesOf(index), [index]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoad({ kind: "loading" });
    setMoving(null);
    setMessage("");
    getBorrowed(controller.signal).then(
      (view) => {
        if (!controller.signal.aborted) setLoad({ kind: "ready", view });
      },
      () => {
        if (!controller.signal.aborted) setLoad({ kind: "failed" });
      }
    );
    return () => controller.abort();
  }, [open, attempt]);

  function startMove(card: BorrowedCard) {
    setMoving(rowKey(card));
    setDestination("");
    setCopies(Number(card.copies));
    setMessage("");
    pending.current = null;
  }

  async function confirmMove(card: BorrowedCard) {
    if (busy || !destination) return;
    setBusy(true);
    setMessage("");
    const key = pending.current ?? crypto.randomUUID();
    pending.current = key;
    try {
      const view = await moveBorrowed({
        loan_id: card.loan_id,
        edition_id: card.edition_id,
        from_location_id: card.location_id,
        to_location_id: destination,
        quantity: String(copies),
        idempotency_key: key,
      });
      pending.current = null;
      setMoving(null);
      setLoad({ kind: "ready", view });
      onMoved();
    } catch (cause) {
      if (!outcomeUnknown(cause)) pending.current = null;
      setMessage(moveMessage(cause));
      if (
        cause instanceof SocialError &&
        cause.code === "NOT_ENOUGH_BORROWED"
      ) {
        setMoving(null);
        setAttempt((n) => n + 1);
      }
    } finally {
      setBusy(false);
    }
  }

  let body;
  if (load.kind === "loading")
    body = (
      <p role="status" className="m-0 text-body text-text-muted">
        Loading borrowed cards…
      </p>
    );
  else if (load.kind === "failed")
    body = (
      <div className="flex flex-wrap items-center gap-3">
        <p role="status" className="m-0 text-body text-text-muted">
          Your borrowed cards couldn't be loaded.
        </p>
        <Button onClick={() => setAttempt((n) => n + 1)}>Retry</Button>
      </div>
    );
  else if (load.view.cards.length === 0)
    body = (
      <p className="m-0 text-body text-text-muted">
        You have no borrowed cards now.
      </p>
    );
  else
    body = (
      <ul
        aria-label="Borrowed cards"
        className="m-0 list-none overflow-hidden rounded-panel border border-border bg-surface p-0"
      >
        {load.view.cards.map((card) => {
          const key = rowKey(card);
          const open = moving === key;
          return (
            <li
              key={key}
              aria-label={card.name}
              className="flex flex-col gap-3 border-b border-border px-4 py-3 last:border-b-0"
            >
              <div className="grid grid-cols-[2.5rem_minmax(0,1fr)_auto] items-center gap-3">
                <CardImage url={card.image_url} />
                <span className="flex min-w-0 flex-col">
                  <span className="text-body font-semibold wrap-anywhere">
                    {card.name}
                  </span>
                  <span className="text-meta text-text-muted wrap-anywhere">
                    {card.set_code} {card.collector_number}
                  </span>
                  <span className="text-meta text-text-subtle wrap-anywhere">
                    {card.copies} from {card.lender} · In {card.location_name}
                  </span>
                </span>
                {!open && (
                  <Button
                    onClick={() => startMove(card)}
                    aria-label={`Move ${card.name} from ${card.location_name}`}
                  >
                    Move…
                  </Button>
                )}
              </div>
              {open && (
                <form
                  aria-label={`Move ${card.name}`}
                  className="flex flex-wrap items-end gap-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void confirmMove(card);
                  }}
                >
                  <Select
                    label="Move to"
                    value={destination}
                    onChange={(event) => {
                      setDestination(event.target.value);
                      pending.current = null;
                    }}
                  >
                    <option value="">Choose a Location</option>
                    {leaves
                      .filter((node) => node.id !== card.location_id)
                      .map((node) => (
                        <option key={node.id} value={node.id}>
                          {index.path(node.id)}
                        </option>
                      ))}
                  </Select>
                  <Stepper
                    label="Copies"
                    value={copies}
                    min={1}
                    max={Number(card.copies)}
                    onChange={(value) => {
                      setCopies(value);
                      pending.current = null;
                    }}
                  />
                  <span className="flex gap-2">
                    <Button
                      type="submit"
                      variant="primary"
                      disabled={busy || !destination}
                    >
                      Move
                    </Button>
                    <Button onClick={() => setMoving(null)} disabled={busy}>
                      Cancel
                    </Button>
                  </span>
                </form>
              )}
            </li>
          );
        })}
      </ul>
    );

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Borrowed"
      closeLabel="Close Borrowed"
      returnFocus={returnFocus}
    >
      <div className="flex flex-col gap-3">
        {message && (
          <p role="alert" className="m-0 text-body text-text">
            {message}
          </p>
        )}
        {body}
      </div>
    </Dialog>
  );
}
