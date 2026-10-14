import { useEffect } from "react";
import {
  getOwnerCatalogStatus,
  startCatalogRun,
  type OwnerCatalogStatus,
} from "./generated";
import { OperationsHealth } from "./OperationsHealth";
import { CatalogReview } from "./CatalogReview";
import { MetadataReview } from "./MetadataReview";
import { OwnerMissingCardReview } from "./MissingCardReports";

type Props = {
  status: OwnerCatalogStatus;
  /** A status read; null when the owner binding is gone (403), which closes the page. */
  onStatus: (status: OwnerCatalogStatus | null) => void;
  /** Shows a message in the page's alert line. */
  onMessage: (message: string) => void;
};

/** The Owner controls page's content, moved unchanged out of main.tsx (#162). While a catalog run is in
 * progress it re-reads the run's status every 5 seconds. */
export function OwnerControls({ status, onStatus, onMessage }: Props) {
  useEffect(() => {
    if (!status.run || status.run.outcome) return;
    const timer = window.setInterval(() => {
      void getOwnerCatalogStatus()
        .then(onStatus)
        .catch(() => onMessage("Catalog status temporarily unavailable."));
    }, 5000);
    return () => window.clearInterval(timer);
  }, [status.run?.outcome]);

  async function beginCatalogRun() {
    onMessage("");
    try {
      onStatus(await startCatalogRun());
    } catch {
      onMessage("Unable to start catalog pull. Please retry.");
    }
  }

  return (
    <section aria-label="Catalog pull">
      <h2>English catalog pull</h2>
      <p>
        {status.catalog.available
          ? `Last successful pull: ${new Date(status.catalog.last_success!).toLocaleString()}`
          : "Catalog unavailable until the first complete import."}
      </p>
      <button
        disabled={
          !!status.run && !status.run.outcome && !status.run.heartbeat_stale
        }
        onClick={() => void beginCatalogRun()}
      >
        Start full English pull
      </button>
      <button
        onClick={() =>
          void getOwnerCatalogStatus()
            .then(onStatus)
            .catch(() => onMessage("Catalog status temporarily unavailable."))
        }
      >
        Refresh status
      </button>
      {status.run && (
        <article>
          <h3>Run {status.run.id}</h3>
          <p>Phase: {status.run.phase}</p>
          <p>
            Enumerated: {status.run.enumerated_count} · Fetched:{" "}
            {status.run.fetched_count} · Validated: {status.run.validated_count}
          </p>
          <p>Result: {status.run.outcome ?? "In progress"}</p>
          {status.run.error && <p role="alert">{status.run.error}</p>}
        </article>
      )}
      {status.run?.heartbeat_stale && !status.run.outcome && (
        <p role="status">
          Progress is stale. Start a full pull to check the current runner and
          recover if interrupted.
        </p>
      )}
      <h3>Pending review ({status.pending_reviews.length})</h3>
      {status.pending_reviews.map((item) => (
        <article key={item.id}>
          <strong>{item.kind}</strong> · {item.source_id}
          <p>{item.detail}</p>
        </article>
      ))}
      <OperationsHealth />
      <CatalogReview />
      <MetadataReview />
      <OwnerMissingCardReview />
    </section>
  );
}
