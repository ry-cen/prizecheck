import { useRef, useState, type FormEvent } from "react";
import { searchCatalog, type PrintingView } from "./generated";
import {
  addHolding,
  HoldingError,
  type AddResult,
} from "./holdings_generated";

/** A Variant Descriptor as one line of text. */
export function descriptorText(descriptor: Record<string, unknown>) {
  if (typeof descriptor.label === "string") return descriptor.label;
  return (
    Object.entries(descriptor)
      .map(([key, value]) => `${key}: ${String(value)}`)
      .join(" · ") || "Unspecified Variant"
  );
}

type Props = {
  locationId: string;
  locationName: string;
  /** Search and Add outcomes for the parent's status line; "" clears it. */
  onMessage: (message: string) => void;
  /** Runs after a successful Add, before the success message is reported. */
  onAdded: (result: AddResult) => Promise<void> | void;
};

/** Search the English catalog and Add copies of one Card Edition to a Storage Leaf or Deck.
 * The Decks page's Holdings panel and the workspace's Add cards dialog (ticket 114) both use it. */
export function AddCardsForm({
  locationId,
  locationName,
  onMessage,
  onAdded,
}: Props) {
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<PrintingView[]>([]);
  const [editionId, setEditionId] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [busy, setBusy] = useState(false);
  const pendingKey = useRef<string | null>(null);

  async function search(event: FormEvent) {
    event.preventDefault();
    if (!query.trim()) return;
    setBusy(true);
    onMessage("");
    try {
      const result = await searchCatalog({ name: query.trim() });
      setMatches(result.printings);
      setEditionId("");
      if (!result.available)
        onMessage("The catalog is unavailable until its first pull.");
      else if (!result.printings.length) onMessage("No matching Printings.");
    } catch {
      onMessage("Search is temporarily unavailable. Please retry.");
    } finally {
      setBusy(false);
    }
  }

  async function add(event: FormEvent) {
    event.preventDefault();
    if (
      !editionId ||
      !/^[0-9]+$/.test(quantity) ||
      BigInt(quantity) < 1n ||
      BigInt(quantity) > 9223372036854775807n
    ) {
      onMessage("Choose an Edition and enter a positive whole quantity.");
      return;
    }
    setBusy(true);
    onMessage("");
    const key = pendingKey.current ?? crypto.randomUUID();
    pendingKey.current = key;
    let result: AddResult;
    try {
      result = await addHolding({
        location_id: locationId,
        edition_id: editionId,
        quantity,
        idempotency_key: key,
      });
    } catch (cause) {
      const code = cause instanceof HoldingError ? cause.code : "";
      if (code === "EDITION_UNAVAILABLE") {
        pendingKey.current = null;
        onMessage("That Edition is no longer available to Add. Search again.");
      } else if (code === "QUANTITY_OVERFLOW" || code === "INVALID_QUANTITY") {
        pendingKey.current = null;
        onMessage("The quantity is invalid or too large.");
      } else if (code === "LOCATION_NOT_FOUND") {
        pendingKey.current = null;
        onMessage("This Storage Leaf is unavailable. Refresh Locations.");
      } else onMessage("Add may have completed. Retry to check safely.");
      setBusy(false);
      return;
    }
    pendingKey.current = null;
    // A failed refresh in the parent must never look like a failed Add: a retry would add again.
    try {
      await onAdded(result);
    } catch {
      /* the parent reports its own refresh errors */
    }
    onMessage(
      `Added. This stack now has ${result.quantity} copies in ${locationName}.`
    );
    setEditionId("");
    setQuantity("1");
    setBusy(false);
  }

  return (
    <>
          <form onSubmit={search}>
            <label>
              Search English card name{" "}
              <input
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  pendingKey.current = null;
                }}
                required
                maxLength={120}
              />
            </label>
            <button disabled={busy}>Search</button>
          </form>
          {matches.length > 0 && (
            <form onSubmit={add}>
              <label>
                Card Edition{" "}
                <select
                  required
                  value={editionId}
                  onChange={(event) => {
                    setEditionId(event.target.value);
                    pendingKey.current = null;
                  }}
                >
                  <option value="">Choose a Printing and Edition</option>
                  {matches.flatMap((printing) =>
                    printing.editions
                      .filter((edition) => edition.active)
                      .map((edition) => (
                        <option key={edition.id} value={edition.id}>
                          {printing.name} · {printing.set_name} #
                          {printing.collector_number} ·{" "}
                          {descriptorText(edition.descriptor)}
                        </option>
                      ))
                  )}
                </select>
              </label>
              <label>
                Quantity{" "}
                <input
                  inputMode="numeric"
                  pattern="[0-9]+"
                  required
                  value={quantity}
                  onChange={(event) => {
                    setQuantity(event.target.value);
                    pendingKey.current = null;
                  }}
                />
              </label>
              <button disabled={busy || !editionId}>
                {busy ? "Adding…" : "Add to Location"}
              </button>
            </form>
          )}
    </>
  );
}
