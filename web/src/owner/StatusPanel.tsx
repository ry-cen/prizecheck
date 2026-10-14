import { useId } from "react";
import type { OperationsStatus, OwnerCatalogStatus } from "../generated";
import { Button } from "../ui/Button";
import { Pill, type PillTone } from "../ui/Pill";
import { ScrollTable } from "../ui/ScrollTable";
import { healthChecks } from "./health";

export const PANEL =
  "box-border flex min-w-0 flex-col gap-3 rounded-panel border border-border bg-surface p-4";

type Props = {
  status: OwnerCatalogStatus;
  /** The operational status, or null until it loads or when it can't be read. */
  operations: OperationsStatus | null;
  operationsFailed: boolean;
  /** Re-reads the pull, operational health and the tab counts. */
  onRefresh: () => void;
  onStart: () => void;
};

/** Owner controls' Status tab (spec "Status"): the catalog pull panel, then operational health. */
export function StatusPanel({
  status,
  operations,
  operationsFailed,
  onRefresh,
  onStart,
}: Props) {
  const pullId = useId();
  const healthId = useId();
  const run = status.run;
  const live = !!run && !run.outcome;
  const stale = live && run.heartbeat_stale;
  const percent =
    run && run.enumerated_count > 0
      ? Math.min(
          100,
          Math.round((run.fetched_count / run.enumerated_count) * 100)
        )
      : null;
  let runTone: PillTone = "warn";
  let runLabel = "In progress";
  if (run?.outcome === "succeeded") {
    runTone = "ok";
    runLabel = "Succeeded";
  } else if (run?.outcome) {
    runTone = "bad";
    runLabel = "Failed";
  } else if (stale) {
    runTone = "bad";
    runLabel = "Progress stale";
  }
  const count = (value: number) => value.toLocaleString();

  return (
    <>
      <section aria-labelledby={pullId} className={PANEL}>
        <div className="flex flex-wrap items-center gap-2">
          <h2 id={pullId} className="m-0 mr-auto text-body font-semibold">
            English catalog pull
          </h2>
          <Button onClick={onRefresh}>Refresh</Button>
          <Button variant="primary" disabled={live && !stale} onClick={onStart}>
            {stale ? "Restart pull" : "Start full pull"}
          </Button>
        </div>
        <p className="m-0 text-meta text-text-muted">
          {status.catalog.available && status.catalog.last_success
            ? `Last successful pull: ${new Date(status.catalog.last_success).toLocaleString()}`
            : "Catalog unavailable until the first complete import."}
        </p>
        {run && (
          <>
            <div className="flex flex-wrap items-center gap-2 text-meta">
              <span className="font-semibold">Run {run.id.slice(0, 8)}</span>
              <Pill tone={runTone}>{runLabel}</Pill>
            </div>
            <p className="m-0 text-meta">Phase: {run.phase}</p>
            <div
              role="progressbar"
              aria-label="Pull progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent ?? undefined}
              aria-valuetext={
                percent === null
                  ? undefined
                  : `${count(run.fetched_count)} of ${count(run.enumerated_count)} fetched`
              }
              className="box-border h-2 overflow-hidden rounded-round border border-border bg-bg"
            >
              <div
                className="h-full bg-accent"
                style={{ width: `${percent ?? 0}%` }}
              />
            </div>
            <p className="m-0 text-meta tabular-nums text-text-muted">
              Enumerated {count(run.enumerated_count)} · Fetched{" "}
              {count(run.fetched_count)} · Validated{" "}
              {count(run.validated_count)}
            </p>
            {run.error && (
              <p role="alert" className="m-0 text-meta text-danger">
                {run.error}
              </p>
            )}
          </>
        )}
        {stale && (
          <p role="status" className="m-0 text-meta text-warning">
            Progress is stale. Restart the pull to check the runner and recover
            if it was interrupted.
          </p>
        )}
      </section>

      <section aria-labelledby={healthId} className={PANEL}>
        <h2 id={healthId} className="m-0 text-body font-semibold">
          Operational health
        </h2>
        {operations ? (
          <ScrollTable label="Health checks">
            <thead>
              <tr>
                <th scope="col">Area</th>
                <th scope="col">Check</th>
                <th scope="col">Value</th>
                <th scope="col">Detail</th>
              </tr>
            </thead>
            <tbody>
              {healthChecks(operations).map((check) => (
                <tr key={`${check.area}:${check.check}`}>
                  <td className="text-text-muted">{check.area}</td>
                  <td>{check.check}</td>
                  <td>
                    <Pill tone={check.tone}>{check.value}</Pill>
                  </td>
                  <td className="text-text-muted">{check.detail}</td>
                </tr>
              ))}
            </tbody>
          </ScrollTable>
        ) : operationsFailed ? null : (
          // A failed read is announced once, by the page's problems line.
          <p className="m-0 text-meta text-text-muted">Loading…</p>
        )}
      </section>
    </>
  );
}
