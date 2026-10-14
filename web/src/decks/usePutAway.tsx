import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SurplusHolding } from "../decks_generated";
import { applyUndo, listUndo, type UndoEntry } from "../inventoryUndo";
import { getLocationTree } from "../location_generated";
import {
  commitMove,
  MoveError,
  stageMove,
  startMove,
  type MoveResult,
} from "../moves_generated";
import { useToast, type ToastInput } from "../ui/Toast";
import { MoveDialog } from "../workspace/InventoryDialogs";
import { STAGE_BATCH } from "../workspace/inventoryActionsModel";
import { indexLocations, type LocationIndex } from "../workspace/locationTree";
import type { OpenPutAway } from "./Surplus";
import {
  copiesText,
  putAwayFailure,
  putAwayItems,
  surplusCards,
  surplusTotal,
} from "./surplusModel";

type Options = {
  deckId: string;
  /** The Deck's name, for the Undo toast. */
  deckName: string;
  /** The Deck read's surplus, or undefined before the first read. */
  surplus: readonly SurplusHolding[] | undefined;
  /** Read the Deck again: after a Put away, its Undo, or a failure that changed what the page shows. */
  onChanged: () => void;
};

/** A staged manifest and its idempotency key. A retry of the same copies to the same Location reuses both, so a
 * commit whose answer was lost applies once. */
type Pending = { manifestId: string; key: string; signature: string };

const EMPTY_INDEX = indexLocations([]);
const NOTHING_EXPANDED: ReadonlySet<string> = new Set();
const NO_SURPLUS: readonly SurplusHolding[] = [];

/**
 * Put away (#180): moves surplus copies out of the Deck to a Location the collector picks, as one ordinary Move
 * (the manifest routes, as Collection's Move), with an Undo toast on the kit's one toast host.
 *
 * The page calls this before its early return, so the dialog's state and the toast outlive a phone's Deck and Library
 * tab switch; the toast goes when the page does. The dialog draws the cards from the page's current read, so after a
 * refresh it offers the current copies and versions, and it closes once they are gone.
 *
 * Undo returns the copies to the Deck. Copies arriving in a Deck join its Deck List (migration 031), so they come back
 * listed, not as surplus; the toast says so.
 */
export function usePutAway({ deckId, deckName, surplus, onChanged }: Options) {
  const kit = useToast();
  // Every surplus card, or the ones the collector pressed; null while closed.
  const [target, setTarget] = useState<readonly string[] | "all" | null>(null);
  const [tree, setTree] = useState<LocationIndex>(EMPTY_INDEX);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const busyRef = useRef(false);
  const pending = useRef<Pending | null>(null);
  const treeRef = useRef(tree);
  treeRef.current = tree;
  const toastId = useRef<number | null>(null);
  const live = useRef({ deckName, onChanged });
  live.current = { deckName, onChanged };

  const all = useMemo(() => surplusCards(surplus ?? NO_SURPLUS), [surplus]);
  const cards = useMemo(
    () =>
      target === null
        ? []
        : target === "all"
          ? all
          : all.filter((card) => target.includes(card.editionId)),
    [all, target]
  );

  const loadTree = useCallback(async () => {
    try {
      const response = await getLocationTree();
      setTree(indexLocations(response.locations));
      return true;
    } catch {
      return false;
    }
  }, []);

  const open: OpenPutAway = useCallback(
    (editionIds) => {
      if (busyRef.current) return;
      setError("");
      setProgress("");
      setTarget(editionIds === "all" ? "all" : [...editionIds]);
      // Read the tree on every opening, so new and renamed Locations show.
      void loadTree().then((loaded) => {
        if (!loaded)
          setError(
            "Your Locations couldn't be loaded. Close this and try again."
          );
      });
    },
    [loadTree]
  );

  const close = useCallback(() => {
    if (busyRef.current) return;
    setTarget(null);
    setError("");
  }, []);

  // A refresh that leaves nothing to put away (another tab put it away, or the line was raised) closes the dialog.
  // A failure message still showing is carried to a toast, so the collector is always told whether anything moved.
  useEffect(() => {
    if (target === null || cards.length || busyRef.current) return;
    if (error) {
      toastId.current = kit.show({ message: error, focus: true });
      setError("");
    }
    setTarget(null);
  }, [target, cards.length, error, kit]);

  // The toast belongs to this Deck's page: it goes when the page does (the Decks page isn't kept mounted).
  useEffect(
    () => () => {
      if (toastId.current !== null) kit.dismiss(toastId.current);
    },
    [kit]
  );

  const show = useCallback(
    (input: ToastInput) => {
      toastId.current = kit.show(input);
      return toastId.current;
    },
    [kit]
  );

  /** The success toast, with Undo only while this Move's record is the newest (Undo applies the newest alone). */
  const announce = useCallback(
    async (result: MoveResult, where: string) => {
      const message = `Put away ${copiesText(BigInt(result.copy_count))} to ${where}.`;
      const entries = await listUndo().catch(() => [] as UndoEntry[]);
      const mine =
        result.undo_id && entries[0]?.id === result.undo_id ? entries[0] : null;
      if (!mine) {
        show({ message, focus: true });
        return;
      }
      // One key per record, kept when an Undo gets no answer, so a retry applies once.
      const key = crypto.randomUUID();
      let undoing = false;
      const offer = (text: string, working: boolean): ToastInput => ({
        message: text,
        action: {
          label: "Undo",
          busy: working,
          keepOpen: true,
          onAction: () => void undo(),
        },
        focus: true,
      });
      const id = show(offer(message, false));
      async function undo() {
        if (undoing) return;
        undoing = true;
        kit.update(id, offer(message, true));
        try {
          const restored = await applyUndo(mine!.id, key);
          show({
            message: `Undo returned ${copiesText(BigInt(restored.copy_count))} to ${live.current.deckName}. They're on its Deck List again.`,
            focus: true,
          });
          live.current.onChanged();
        } catch (cause) {
          const code = cause instanceof MoveError ? cause.code : "";
          if (!(cause instanceof MoveError) || cause.status >= 500) {
            kit.update(
              id,
              offer(
                "Undo may not have finished. Try again to check safely.",
                false
              )
            );
          } else if (code === "UNDO_INCOMPATIBLE") {
            show({
              message:
                "Undo unavailable: these copies have moved since they were put away, so nothing was restored.",
              focus: true,
            });
            live.current.onChanged();
          } else if (code === "UNDO_NOT_NEWEST") {
            show({
              message:
                "Undo unavailable: your collection changed since, so nothing was restored.",
              focus: true,
            });
            live.current.onChanged();
          } else if (code === "REPLAY_OUTCOME_UNAVAILABLE") {
            show({
              message:
                "Undo may already have finished. The Deck has been refreshed.",
              focus: true,
            });
            live.current.onChanged();
          } else if (code === "UNDO_EXPIRED" || code === "UNDO_NOT_FOUND") {
            show({ message: "That Undo is no longer available.", focus: true });
            live.current.onChanged();
          } else {
            show({
              message: "Undo couldn't be completed. Nothing was restored.",
              focus: true,
            });
          }
        } finally {
          undoing = false;
        }
      }
    },
    [kit, show]
  );

  const confirm = useCallback(
    async (destinationId: string) => {
      if (busyRef.current || !cards.length) return;
      busyRef.current = true;
      setBusy(true);
      setError("");
      // startMove replaces the owner's staged Collection manifest, as starting a Move in Collection does.
      const items = putAwayItems(deckId, cards);
      const signature = JSON.stringify([destinationId, items]);
      const where = treeRef.current.byId.has(destinationId)
        ? treeRef.current.path(destinationId)
        : "the Location you chose";
      try {
        let attempt =
          pending.current?.signature === signature ? pending.current : null;
        if (!attempt) {
          pending.current = null;
          setProgress("Preparing…");
          const manifest = await startMove(deckId);
          for (let start = 0; start < items.length; start += STAGE_BATCH)
            await stageMove(
              manifest.id,
              items.slice(start, start + STAGE_BATCH)
            );
          attempt = {
            manifestId: manifest.id,
            key: crypto.randomUUID(),
            signature,
          };
          pending.current = attempt;
        }
        setProgress("Putting away…");
        const result = await commitMove(
          attempt.manifestId,
          destinationId,
          attempt.key
        );
        pending.current = null;
        setTarget(null);
        live.current.onChanged();
        void announce(result, where);
      } catch (cause) {
        const failure = putAwayFailure(cause, where);
        if (!failure.retrySame) pending.current = null;
        if (failure.refreshDeck) live.current.onChanged();
        if (failure.refreshTree) void loadTree();
        setError(failure.text);
      } finally {
        busyRef.current = false;
        setBusy(false);
        setProgress("");
      }
    },
    [cards, deckId, announce, loadTree]
  );

  const copies = surplusTotal(cards);
  const dialog =
    target !== null && cards.length ? (
      <MoveDialog
        verb="Put away"
        index={tree}
        initialExpanded={NOTHING_EXPANDED}
        groups={putAwayItems(deckId, cards)}
        copies={Number(copies)}
        busy={busy}
        progress={progress}
        error={error}
        onConfirm={(destinationId) => void confirm(destinationId)}
        onCancel={close}
      />
    ) : null;

  return { open, dialog };
}
