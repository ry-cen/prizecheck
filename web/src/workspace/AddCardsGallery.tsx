import { useRef, type RefObject } from "react";
import { CatalogGallery } from "../catalog/CatalogGallery";
import type { AddedCards } from "../catalog/useAddToast";
import type { Place } from "../catalog/usePlaces";
import { Dialog } from "../ui/Dialog";

type Props = {
  open: boolean;
  /** The open Storage Leaf or Deck, by path: titled "Add cards to <path>" and set to it. Null (All owned, or the
   * Location it was opened for is gone): titled "Add cards", with a Location picker. */
  target: Place | null;
  onClose: () => void;
  /** A batch add succeeded: Add N cards (Collection closes this and opens that Location) or the popup's Add N. */
  onAdded: (added: AddedCards) => void;
  /** Add N cards found its Location gone: Collection reads its tree again. */
  onTargetGone: () => void;
  returnFocus?: RefObject<HTMLElement | null>;
};

/**
 * Collection's Add cards (#175, spec "Collection"): Catalog's gallery in Add mode over Collection, in a wide Dialog
 * that fills the screen on a phone. It replaces the old Add cards dialog and its form, so the app has one card search.
 * The search box takes focus. Each opening starts afresh: an empty search and an empty queue. Collection shows the
 * Undo toast for what it adds.
 */
export function AddCardsGallery({
  open,
  target,
  onClose,
  onAdded,
  onTargetGone,
  returnFocus,
}: Props) {
  const body = useRef<HTMLDivElement>(null);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={target ? `Add cards to ${target.label}` : "Add cards"}
      closeLabel="Close Add cards"
      size="wide"
      bodyRef={body}
      returnFocus={returnFocus}
    >
      {open && (
        <CatalogGallery
          active
          adding
          fixedTarget={target}
          undoToast={false}
          onAdded={onAdded}
          onTargetGone={onTargetGone}
          stick="dialog"
          scrollRoot={body}
          autoFocusSearch
        />
      )}
    </Dialog>
  );
}
