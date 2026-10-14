import { useEffect, useState } from "react";
import type { DeckDetail } from "../decks_generated";
import { getLocationTree } from "../location_generated";
import { indexLocations } from "../workspace/locationTree";
import type { MoveDestination } from "../MoveHoldings";
import { Holdings } from "../Holdings";
import { PublishDeck } from "../PublishDeck";
import { DeckLiveExport } from "../DeckLiveExport";
import { DeckMassEntryExport } from "../DeckMassEntryExport";
import { CostSection } from "../DeckCost";
import type { DeckCostSettled } from "./useDeckCost";

const LABELS: Record<string, string> = {
  basic_energy_exempt: "Basic Energy exemption supported",
  unresolved:
    "Basic Energy classification unresolved; exemption not established",
  over_limit: "Over four-copy limit",
  within_limit: "Within four-copy limit",
};

/**
 * The old Decks page's panels for one Deck, unchanged, inside the deck builder until their tickets replace
 * them: the Holdings checks and cost, the Holdings panel with Move, Remove and Undo, Publish, and the Live and
 * Mass Entry exports. #181 moves Export, Publish and Delete into the builder's header and removes the rest.
 * The page renders this inside a .legacy element, so the old light styles apply.
 */
export function LegacyDeckTools({
  detail,
  cost,
  onInventoryChanged,
}: {
  detail: DeckDetail;
  /** The page's one cost read: this panel shows its Holdings cost (the top-level figures). */
  cost: DeckCostSettled;
  /** Holdings changed or Refresh checks was pressed: the page reads the Deck again. */
  onInventoryChanged: () => Promise<void>;
}) {
  const [leaves, setLeaves] = useState<MoveDestination[]>([]);
  const [message, setMessage] = useState("");
  useEffect(() => {
    getLocationTree()
      .then((tree) => {
        const paths = indexLocations(tree.locations);
        setLeaves(
          tree.locations
            .filter((item) => item.kind !== "organization")
            .map((item) => ({ id: item.id, name: paths.path(item.id) }))
        );
      })
      .catch(() =>
        setMessage("Decks are temporarily unavailable. Please retry.")
      );
  }, []);
  return (
    <>
      <section aria-label={`Checks for ${detail.deck.name}`}>
        <h3>{detail.deck.name}</h3>
        <p>
          {detail.checks.total} cards ·{" "}
          {detail.checks.size_status === "complete"
            ? "Exactly 60 cards"
            : detail.checks.size_status === "shortage"
              ? `${detail.checks.shortage} cards short of 60`
              : `${detail.checks.excess} cards over 60`}
        </p>
        <CostSection settled={cost} totalCopies={detail.checks.total} />
        <ul>
          {detail.checks.identities.map((identity) => (
            <li key={identity.identity_id}>
              {identity.name} · {identity.quantity} copies ·{" "}
              {LABELS[identity.status] ?? "Check unresolved"}
            </li>
          ))}
        </ul>
        <p>{detail.checks.disclaimer}</p>
        <button type="button" onClick={() => void onInventoryChanged()}>
          Refresh checks
        </button>
        <Holdings
          key={detail.deck.id}
          locationId={detail.deck.id}
          locationName={detail.deck.name}
          destinations={leaves}
          onInventoryChanged={onInventoryChanged}
        />
        <PublishDeck key={detail.deck.id} deckId={detail.deck.id} />
        <DeckLiveExport
          key={`live-${detail.deck.id}`}
          deckId={detail.deck.id}
          ownerRevision={detail.owner_revision}
          checks={detail.checks}
        />
        <DeckMassEntryExport
          key={`mass-${detail.deck.id}`}
          deckId={detail.deck.id}
          ownerRevision={detail.owner_revision}
          checks={detail.checks}
        />
      </section>
      {message && <p role="status">{message}</p>}
    </>
  );
}
