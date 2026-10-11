import { useEffect, useState } from "react";
import { AddCardsForm, descriptorText } from "./AddCardsForm";
import {
  getLeafHoldings,
  HoldingError,
  type HoldingView,
  type LeafFilters,
} from "./holdings_generated";
import { MoveHoldings, type MoveDestination } from "./MoveHoldings";
import "./Holdings.css";
import { EditionCorrections } from "./EditionCorrections";
import { EditionPrice } from "./EditionPrice";

function HoldingArt({ url, name }: { url: string | null; name: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  if (!url || failed)
    return (
      <div
        role="img"
        aria-label={`Artwork unavailable for ${name}`}
        className="holding-placeholder"
      >
        Artwork unavailable
      </div>
    );
  return (
    <img src={url} alt={`${name} card art`} onError={() => setFailed(true)} />
  );
}

/** Mount inside the selected Storage Leaf's contents area. */
export function Holdings({
  locationId,
  locationName,
  destinations,
  onMoveReady,
  onInventoryChanged,
}: {
  locationId: string;
  locationName: string;
  destinations: MoveDestination[];
  onMoveReady?: (move: ((destinationId: string) => void) | null) => void;
  onInventoryChanged?: () => Promise<void> | void;
}) {
  const [leafFilters, setLeafFilters] = useState<LeafFilters>({ sort: "name" });
  const [leafDraft, setLeafDraft] = useState<LeafFilters>({ sort: "name" });

  const [holdings, setHoldings] = useState<HoldingView[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [message, setMessage] = useState("");

  async function load(next?: string) {
    try {
      const result = await getLeafHoldings(locationId, next, leafFilters);
      setHoldings((previous) =>
        next ? [...previous, ...result.holdings] : result.holdings
      );
      setCursor(result.next_cursor);
      await onInventoryChanged?.();
    } catch (cause) {
      if (
        cause instanceof HoldingError &&
        (cause.code === "INVENTORY_CHANGED" || cause.code === "CATALOG_CHANGED")
      ) {
        const first = await getLeafHoldings(locationId, undefined, leafFilters);
        setHoldings(first.holdings);
        setCursor(first.next_cursor);
        setMessage("Cards changed. Showing the latest page.");
      } else setMessage("Cards are temporarily unavailable. Please retry.");
    }
  }
  useEffect(() => {
    setHoldings([]);
    setCursor(null);
    setMessage("");
    void load();
  }, [locationId, leafFilters]);

  return (
    <section className="holdings-panel" aria-label={`Cards in ${locationName}`}>
      <div className="holdings-heading">
        <h3>Cards in this Location</h3>
        <button
          type="button"
          onClick={() => {
            setAdding((value) => !value);
            setMessage("");
          }}
        >
          Add cards
        </button>
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setLeafFilters({ ...leafDraft });
        }}
      >
        <label>
          Filter owned cards{" "}
          <input
            value={leafDraft.name ?? ""}
            onChange={(e) =>
              setLeafDraft({ ...leafDraft, name: e.target.value })
            }
            maxLength={120}
          />
        </label>
        <label>
          Filter owned set{" "}
          <input
            value={leafDraft.set_id ?? ""}
            onChange={(e) =>
              setLeafDraft({ ...leafDraft, set_id: e.target.value })
            }
            maxLength={80}
          />
        </label>
        <label>
          Filter owned number{" "}
          <input
            value={leafDraft.collector_number ?? ""}
            onChange={(e) =>
              setLeafDraft({ ...leafDraft, collector_number: e.target.value })
            }
            maxLength={40}
          />
        </label>
        <label>
          Owned cards sort{" "}
          <select
            value={leafDraft.sort}
            onChange={(e) =>
              setLeafDraft({
                ...leafDraft,
                sort: e.target.value as "name" | "quantity",
              })
            }
          >
            <option value="name">Name</option>
            <option value="quantity">Most copies</option>
          </select>
        </label>
        <button>Filter cards</button>
      </form>
      {holdings.length ? (
        <ul className="holding-grid">
          {holdings.map((item) => (
            <li key={item.edition_id}>
              <article
                className="holding-stack"
                tabIndex={0}
                aria-label={`${item.printing_name}, ${item.set_name} number ${item.collector_number}, ${descriptorText(item.descriptor)}, ${item.quantity} copies in ${item.location_name}`}
              >
                <HoldingArt url={item.image_url} name={item.printing_name} />
                <strong className="holding-count">×{item.quantity}</strong>
                <div className="holding-details">
                  <strong>{item.printing_name}</strong>
                  <span>
                    {item.set_name} ({item.set_id}) · #{item.collector_number}
                  </span>
                  <span>{descriptorText(item.descriptor)}</span>
                  <span>{item.location_name}</span>
                  <EditionPrice editionId={item.edition_id} />
                </div>
              </article>
            </li>
          ))}
        </ul>
      ) : (
        <p>No cards here yet.</p>
      )}
      {cursor && (
        <button type="button" onClick={() => void load(cursor)}>
          More cards
        </button>
      )}
      <EditionCorrections
        holdings={holdings}
        onChanged={async () => {
          await load();
          await onInventoryChanged?.();
        }}
      />
      <MoveHoldings
        locationId={locationId}
        holdings={holdings}
        destinations={destinations}
        onMoved={() => load()}
        onMoveReady={onMoveReady}
      />
      {adding && (
        <div className="holding-add">
          <h4>Add a Card Edition to {locationName}</h4>
          <AddCardsForm
            locationId={locationId}
            locationName={locationName}
            onMessage={setMessage}
            onAdded={async () => {
              await load();
              setAdding(false);
            }}
          />
        </div>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
