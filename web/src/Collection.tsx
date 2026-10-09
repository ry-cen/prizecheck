import { useEffect, useState, type FormEvent } from "react";
import {
  getCollection,
  getEditionDistribution,
  type CollectionFilters,
  type CollectionEntry,
} from "./collection_generated";
import { HoldingError, type HoldingView } from "./holdings_generated";
import "./Holdings.css";

export function Collection({
  locationId,
  locationName,
}: {
  locationId?: string;
  locationName?: string;
}) {
  const [entries, setEntries] = useState<CollectionEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [filters, setFilters] = useState<CollectionFilters>({ sort: "name" });
  const [draft, setDraft] = useState<CollectionFilters>({ sort: "name" });
  const [distribution, setDistribution] = useState<HoldingView[] | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  async function load(next?: string) {
    setBusy(true);
    try {
      const result = await getCollection(
        { ...filters, location_id: locationId },
        next
      );
      setEntries((previous) =>
        next ? [...previous, ...result.entries] : result.entries
      );
      setCursor(result.next_cursor ?? null);
    } catch (cause) {
      if (
        cause instanceof HoldingError &&
        ["INVENTORY_CHANGED", "CATALOG_CHANGED"].includes(cause.code)
      ) {
        setEntries([]);
        setCursor(null);
        setMessage(
          "Cards changed. Restart from page one to see current totals."
        );
      } else setMessage("Collection is temporarily unavailable. Retry.");
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    setMessage("");
    void load();
  }, [filters, locationId]);
  async function find(edition: string) {
    try {
      setDistribution((await getEditionDistribution(edition)).holdings);
    } catch {
      setMessage("Distribution is temporarily unavailable. Retry.");
    }
  }
  function filter(event: FormEvent) {
    event.preventDefault();
    setFilters({ ...draft });
  }
  return (
    <section
      aria-label={locationName ? `Collection in ${locationName}` : "Collection"}
    >
      <h2>{locationName ? `Cards under ${locationName}` : "Collection"}</h2>
      <form onSubmit={filter}>
        <label>
          Owned card name{" "}
          <input
            value={draft.name ?? ""}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            maxLength={120}
          />
        </label>
        <label>
          Owned set{" "}
          <input
            value={draft.set_id ?? ""}
            onChange={(e) => setDraft({ ...draft, set_id: e.target.value })}
            maxLength={80}
          />
        </label>
        <label>
          Owned collector number{" "}
          <input
            value={draft.collector_number ?? ""}
            onChange={(e) =>
              setDraft({ ...draft, collector_number: e.target.value })
            }
            maxLength={40}
          />
        </label>
        <label>
          Collection sort{" "}
          <select
            value={draft.sort}
            onChange={(e) =>
              setDraft({
                ...draft,
                sort: e.target.value as "name" | "quantity",
              })
            }
          >
            <option value="name">Name</option>
            <option value="quantity">Most copies</option>
          </select>
        </label>
        <button disabled={busy}>Filter Collection</button>
      </form>
      {entries.length ? (
        <ul className="holding-grid">
          {entries.map((item) => (
            <li key={item.edition_id}>
              <article className="holding-stack">
                {item.image_url ? (
                  <img
                    src={item.image_url}
                    alt={`${item.printing_name} card art`}
                    onError={(e) => {
                      e.currentTarget.hidden = true;
                    }}
                  />
                ) : (
                  <span>Artwork unavailable</span>
                )}
                <strong>{item.printing_name}</strong>
                <span>
                  {item.set_name} #{item.collector_number}
                </span>
                <span>
                  {typeof item.descriptor.label === "string"
                    ? item.descriptor.label
                    : Object.entries(item.descriptor)
                        .map(([k, v]) => `${k}: ${String(v)}`)
                        .join(" · ") || "Unspecified Variant"}
                </span>
                <strong>{item.quantity} copies</strong>
                <button onClick={() => void find(item.edition_id)}>
                  Find copies
                </button>
              </article>
            </li>
          ))}
        </ul>
      ) : (
        !busy && <p>No owned Editions match.</p>
      )}
      {cursor && (
        <button disabled={busy} onClick={() => void load(cursor)}>
          More owned cards
        </button>
      )}
      {message && (
        <p role="status">
          {message}{" "}
          <button
            onClick={() => {
              setMessage("");
              void load();
            }}
          >
            Restart Collection
          </button>
        </p>
      )}
      {distribution && (
        <div role="dialog" aria-modal="true" aria-label="Physical copies">
          <h3>Physical copies</h3>
          <ul>
            {distribution.map((item) => (
              <li key={item.location_id}>
                {item.location_name}: {item.quantity} copies
              </li>
            ))}
          </ul>
          <button autoFocus onClick={() => setDistribution(null)}>
            Close distribution
          </button>
        </div>
      )}
    </section>
  );
}
