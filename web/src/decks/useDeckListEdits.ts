import { useCallback, useEffect, useRef, useState } from "react";
import {
  changeDeckList,
  DeckError,
  type DeckList,
  type DeckListChange,
  type DeckListCommandResult,
} from "../decks_generated";
import { useToast } from "../ui/Toast";

/**
 * One collector action on the Deck List (#177): copies to add (positive) or take off (negative) per Card Edition,
 * from a library drag, the card popup's ±1, the copy sheet's ±1 or Swap, a copy dragged onto the library, or Delete.
 */
export type DeckListEdit = {
  /** Per Edition id, the change in copies. */
  deltas: ReadonlyMap<string, bigint>;
  /** Each Edition's card name, so a merged batch that changes one Edition can name it. */
  names: ReadonlyMap<string, string>;
  /** The toast's words when this edit is sent on its own, for example "Added 1 Charizard ex." */
  message: string;
};

/** The last edit's outcome, for a line inside an open dialog: the toast host is inert behind a modal, so the card
 * popup and the copy sheet repeat its words and its Undo. */
export type EditFeedback = {
  /** Grows with every message, so a dialog shows only the ones after it opened. */
  id: number;
  message: string;
  /** Undo the batch the message names, or null once it can't be (done, refused or replaced). */
  undo: (() => void) | null;
  /** An Undo is on its way. */
  busy: boolean;
};

export type EditNotice = {
  text: string;
  /** Send the same command again (a request whose outcome is unknown), or null. */
  retry: (() => void) | null;
};

type Batch = {
  edits: DeckListEdit[];
  /** Net change per Edition, from the edits. */
  deltas: Map<string, bigint>;
  /** Each changed Edition's quantity in the confirmed Deck List the batch was built on. */
  before: Map<string, bigint>;
  changes: DeckListChange[];
  revision: number;
  key: string;
};

type UndoJob = {
  feedbackId: number;
  message: string;
  changes: DeckListChange[];
  /** The revision the batch answered: the inverse is refused (STALE_DECK_LIST) if the list moved since. */
  revision: number;
  key: string;
};

type Options = {
  deckId: string;
  /** The Deck List the page shows (the last confirmed one: a command's answer or a Deck read). */
  deckList: DeckList | null;
  /** A command answered: show its Deck List, Target Format and result at once. */
  onResult: (result: DeckListCommandResult) => void;
  /** Every command has landed: read the Deck again for its ownership, checks and surplus, which a command's answer
   * doesn't carry. */
  onSettled: () => void;
  /** Read the Deck now and give its Deck List (a batch answered STALE_DECK_LIST is rebuilt on it once). */
  reread: () => Promise<DeckList | null>;
  /** The Deck is gone (404). */
  onMissing: () => void;
};

const big = (value: string | undefined) => BigInt(value ?? "0");

export function copiesText(count: bigint): string {
  return `${count} ${count === 1n ? "copy" : "copies"}`;
}

/** The toast's words for a batch: the edit's own words when it was sent alone, else what changed. */
export function batchMessage(batch: {
  edits: readonly DeckListEdit[];
  deltas: ReadonlyMap<string, bigint>;
  before: ReadonlyMap<string, bigint>;
  changes: readonly DeckListChange[];
}): string {
  if (batch.edits.length === 1) return batch.edits[0].message;
  let added = 0n;
  let removed = 0n;
  for (const change of batch.changes) {
    const difference =
      BigInt(change.quantity) - (batch.before.get(change.edition_id) ?? 0n);
    if (difference > 0n) added += difference;
    else removed -= difference;
  }
  if (batch.changes.length === 1) {
    const edition = batch.changes[0].edition_id;
    const name =
      batch.edits.find((edit) => edit.names.has(edition))?.names.get(edition) ??
      "this card";
    return added > 0n
      ? `Added ${added} ${name}.`
      : `Removed ${removed} ${name}.`;
  }
  const parts = [
    added > 0n && `added ${copiesText(added)}`,
    removed > 0n && `removed ${copiesText(removed)}`,
  ].filter(Boolean);
  return `Deck List changed: ${parts.join(", ")}.`;
}

/** Merges queued edits into one batch on the confirmed Deck List: each Edition's new total is its confirmed quantity
 * plus every queued change, never below 0. An Edition whose total doesn't move is left out. */
export function buildBatch(
  edits: DeckListEdit[],
  confirmed: DeckList,
  key: string
): Batch {
  const deltas = new Map<string, bigint>();
  for (const edit of edits)
    for (const [edition, delta] of edit.deltas)
      deltas.set(edition, (deltas.get(edition) ?? 0n) + delta);
  const listed = new Map(
    confirmed.lines.map((line) => [line.edition_id, big(line.quantity)])
  );
  const before = new Map<string, bigint>();
  const changes: DeckListChange[] = [];
  for (const [edition, delta] of deltas) {
    const was = listed.get(edition) ?? 0n;
    const total = was + delta < 0n ? 0n : was + delta;
    if (total === was) continue;
    before.set(edition, was);
    changes.push({ edition_id: edition, quantity: total.toString() });
  }
  return { edits, deltas, before, changes, revision: confirmed.revision, key };
}

/**
 * The deck builder's Deck List edits (#177). Every add, remove or swap goes through the batch command
 * (POST /api/decks/{id}/deck-list/changes), one command at a time: edits made while one is on its way wait, and
 * the next batch merges all of them, so fast taps all count, in order. Each batch's totals are worked out when it
 * is sent, from the last confirmed Deck List plus the changes since.
 *
 * Each batch that lands shows a toast with Undo, which sends the inverse batch (every changed line back to its
 * total before) at the revision the batch answered; if the list moved since, the server refuses it and the toast
 * says "Can't undo: this deck changed." Deck List Undo never touches the inventory's Undo, nor the other way round.
 *
 * - A batch answered STALE_DECK_LIST (the list moved somewhere else) is rebuilt once on a fresh read; a second
 *   refusal drops it with a notice.
 * - A request whose outcome is unknown (no answer, or a 5xx) stops the queue with a notice whose Try again sends
 *   exactly that request again, with the same key, so the server replays it instead of applying it twice.
 * - Any other refusal drops that batch with a notice.
 *
 * `quantityOf` is an Edition's quantity as the collector expects it: confirmed, plus everything on its way.
 */
export function useDeckListEdits({
  deckId,
  deckList,
  onResult,
  onSettled,
  reread,
  onMissing,
}: Options) {
  const kit = useToast();
  const live = useRef({ deckId, onResult, onSettled, reread, onMissing });
  live.current = { deckId, onResult, onSettled, reread, onMissing };
  const confirmed = useRef<DeckList | null>(null);
  if (
    deckList &&
    (!confirmed.current || deckList.revision >= confirmed.current.revision)
  )
    confirmed.current = deckList;
  const queued = useRef<DeckListEdit[]>([]);
  const inFlight = useRef<Batch | null>(null);
  const failed = useRef<Batch | null>(null);
  const rebuilt = useRef(new WeakSet<DeckListEdit>());
  const undoJob = useRef<UndoJob | null>(null);
  const undoing = useRef(false);
  const dirty = useRef(false);
  const pumping = useRef(false);
  const toastId = useRef<number | null>(null);
  const feedbackIds = useRef(0);
  const [, setTick] = useState(0);
  const redraw = () => setTick((value) => value + 1);
  const [notice, setNotice] = useState<EditNotice | null>(null);
  const [feedback, setFeedbackState] = useState<EditFeedback | null>(null);
  // A late answer after the page has gone must not show a toast (with an Undo) on the next page. Queued sends still
  // drain, so no tap is lost.
  const mounted = useRef(true);
  const setFeedback = (next: EditFeedback | null) => {
    if (mounted.current) setFeedbackState(next);
  };
  const setNoticeIfMounted = (next: EditNotice | null) => {
    if (mounted.current) setNotice(next);
  };

  // Leaving the Deck takes its toast down with the page.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (toastId.current !== null) kit.dismiss(toastId.current);
    };
  }, [kit]);

  function say(message: string, job: UndoJob | null, busy = false) {
    if (!mounted.current) return;
    const id = job?.feedbackId ?? ++feedbackIds.current;
    const undo = job && !busy ? () => requestUndo(job) : null;
    const input = {
      message,
      action: job
        ? {
            label: "Undo",
            keepOpen: true,
            busy,
            onAction: () => requestUndo(job),
          }
        : undefined,
    };
    if (busy && toastId.current !== null) kit.update(toastId.current, input);
    else toastId.current = kit.show(input);
    setFeedback({ id, message, undo, busy });
  }

  function requestUndo(job: UndoJob) {
    if (undoJob.current || undoing.current) return;
    undoJob.current = job;
    say(job.message, job, true);
    void pump();
  }

  async function send(batch: Batch) {
    inFlight.current = batch;
    redraw();
    try {
      const result = await changeDeckList(live.current.deckId, {
        revision: batch.revision,
        idempotency_key: batch.key,
        changes: batch.changes,
      });
      inFlight.current = null;
      confirmed.current = result.deck_list;
      dirty.current = true;
      if (mounted.current) live.current.onResult(result);
      const message = batchMessage(batch);
      say(message, {
        feedbackId: ++feedbackIds.current,
        message,
        changes: batch.changes.map((change) => ({
          edition_id: change.edition_id,
          quantity: (batch.before.get(change.edition_id) ?? 0n).toString(),
        })),
        revision: result.deck_list.revision,
        key: crypto.randomUUID(),
      });
    } catch (cause) {
      inFlight.current = null;
      if (!(cause instanceof DeckError) || cause.status >= 500) {
        failed.current = batch;
        setNoticeIfMounted({
          text: "Your last Deck List change may not have been saved. Try again to check safely.",
          retry,
        });
        redraw();
        return;
      }
      dirty.current = true;
      if (cause.status === 404) {
        queued.current = [];
        if (mounted.current) live.current.onMissing();
        return;
      }
      if (
        cause.code === "STALE_DECK_LIST" &&
        !batch.edits.some((edit) => rebuilt.current.has(edit))
      ) {
        // The list moved somewhere else: rebuild these edits once on a fresh read, ahead of anything queued.
        for (const edit of batch.edits) rebuilt.current.add(edit);
        queued.current = [...batch.edits, ...queued.current];
        const fresh = mounted.current ? await live.current.reread() : null;
        if (fresh && fresh.revision >= (confirmed.current?.revision ?? 0))
          confirmed.current = fresh;
        return;
      }
      setNoticeIfMounted({
        text:
          cause.code === "STALE_DECK_LIST"
            ? "This Deck changed somewhere else, so your last change wasn't saved. It's up to date now: try again."
            : cause.code === "EDITION_UNAVAILABLE"
              ? "That card can't be added any more, so the Deck List wasn't changed."
              : "The Deck List couldn't be changed. Please try again.",
        retry: null,
      });
    }
  }

  async function sendUndo(job: UndoJob) {
    undoing.current = true;
    try {
      const result = await changeDeckList(live.current.deckId, {
        revision: job.revision,
        idempotency_key: job.key,
        changes: job.changes,
      });
      confirmed.current = result.deck_list;
      dirty.current = true;
      if (mounted.current) live.current.onResult(result);
      say(`Undone: ${job.message}`, null);
    } catch (cause) {
      if (!(cause instanceof DeckError) || cause.status >= 500) {
        // No answer: the same key makes pressing Undo again apply it once.
        say("Undo may not have finished. Try again to check safely.", job);
        return;
      }
      dirty.current = true;
      if (cause.status === 404) {
        if (mounted.current) live.current.onMissing();
        return;
      }
      // A newer batch has its own toast and Undo: don't replace them with this refusal.
      if (job.feedbackId < feedbackIds.current) return;
      say(
        cause.code === "STALE_DECK_LIST"
          ? "Can't undo: this deck changed."
          : "That Undo is no longer available.",
        null
      );
    } finally {
      undoing.current = false;
    }
  }

  // One command at a time: queued edits first (merged into one batch), then a requested Undo, then one Deck read
  // once everything has landed.
  async function pump() {
    if (pumping.current) return;
    pumping.current = true;
    try {
      for (;;) {
        if (failed.current || !confirmed.current) return;
        if (queued.current.length) {
          const edits = queued.current;
          queued.current = [];
          const batch = buildBatch(
            edits,
            confirmed.current,
            crypto.randomUUID()
          );
          if (batch.changes.length) await send(batch);
          redraw();
          continue;
        }
        if (undoJob.current) {
          const job = undoJob.current;
          undoJob.current = null;
          await sendUndo(job);
          continue;
        }
        if (dirty.current) {
          dirty.current = false;
          if (mounted.current) live.current.onSettled();
        }
        return;
      }
    } finally {
      pumping.current = false;
    }
  }

  function retry() {
    const batch = failed.current;
    if (!batch) return;
    failed.current = null;
    setNoticeIfMounted(null);
    void (async () => {
      pumping.current = true;
      try {
        await send(batch);
      } finally {
        pumping.current = false;
      }
      void pump();
    })();
  }

  const edit = useCallback((next: DeckListEdit) => {
    queued.current = [...queued.current, next];
    setNotice((current) => (current?.retry ? current : null));
    redraw();
    void pump();
    // pump reads only refs, so one stable edit serves every render.
  }, []);

  const quantityOf = (editionId: string): bigint => {
    const line = confirmed.current?.lines.find(
      (item) => item.edition_id === editionId
    );
    let total = big(line?.quantity);
    const pending = [
      ...(inFlight.current ? [inFlight.current] : []),
      ...(failed.current ? [failed.current] : []),
    ];
    for (const batch of pending) total += batch.deltas.get(editionId) ?? 0n;
    for (const queuedEdit of queued.current)
      total += queuedEdit.deltas.get(editionId) ?? 0n;
    return total < 0n ? 0n : total;
  };

  return {
    edit,
    quantityOf,
    /** A command or an Undo is on its way, waiting to be sent again, or queued. */
    busy:
      inFlight.current !== null ||
      failed.current !== null ||
      queued.current.length > 0 ||
      undoJob.current !== null ||
      undoing.current,
    notice,
    feedback,
    /** Focus the toast's Undo, when the control that made the edit has left the page. */
    focusUndo: () =>
      toastId.current !== null ? kit.focus(toastId.current) : false,
  };
}
