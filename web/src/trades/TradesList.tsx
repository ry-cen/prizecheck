import { useEffect, useId, useState, type MouseEvent } from "react";
import { CardImage } from "../social/FriendCollectionPage";
import {
  getTrades,
  type TradeView,
  type TradesView,
} from "../social_generated";
import { Button } from "../ui/Button";
import { tradePath } from "./tradeListModel";
import { tradeHeadline, tradeSubline, tradeWaitingLabel } from "./tradeText";

type Load =
  | { kind: "loading" }
  | { kind: "failed" }
  | { kind: "ready"; view: TradesView };

const SECTIONS = [
  { id: "needs_you", title: "Needs you" },
  { id: "to_swap", title: "To swap" },
  { id: "pending", title: "Pending" },
] as const;

/**
 * The Trades list (Trading #270, prototype verdict variant A), the Trades tab's first view at /trades: the collector's
 * Trade Proposals and Trades in **Needs you**, **To swap** and **Pending**, with **History** folded away. Each row is
 * one link to its Trade, with the headline and what each side gives. A Trade that waits on the reader to fix a pick adds the inbox's "Fix picks" to its second line.
 */
export function TradesList({
  onOpenTrade,
}: {
  onOpenTrade: (id: string) => void;
}) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    getTrades(controller.signal).then(
      (view) => {
        if (!controller.signal.aborted) setLoad({ kind: "ready", view });
      },
      () => {
        if (!controller.signal.aborted) setLoad({ kind: "failed" });
      }
    );
    return () => controller.abort();
  }, [attempt]);

  if (load.kind === "loading")
    return (
      <p role="status" className="m-0 text-body text-text-muted">
        Loading Trades…
      </p>
    );
  if (load.kind === "failed")
    return (
      <div className="flex flex-wrap items-center gap-3">
        <p role="status" className="m-0 text-body text-text-muted">
          Your Trades couldn't be loaded.
        </p>
        <Button
          onClick={() => {
            setLoad({ kind: "loading" });
            setAttempt((n) => n + 1);
          }}
        >
          Retry
        </Button>
      </div>
    );
  const { trades } = load.view;
  if (trades.length === 0)
    return <p className="m-0 text-body text-text-muted">No Trades yet.</p>;
  const history = trades.filter((trade) => trade.section === "history");
  return (
    <>
      {SECTIONS.map(({ id, title }) => {
        const rows = trades.filter((trade) => trade.section === id);
        return rows.length ? (
          <TradeSection
            key={id}
            title={title}
            trades={rows}
            onOpenTrade={onOpenTrade}
          />
        ) : null;
      })}
      {history.length > 0 && (
        <details className="group">
          <summary className="inline-flex min-h-control cursor-pointer items-center gap-2 rounded-control text-heading font-semibold phone:min-h-tap">
            History · {history.length}
          </summary>
          <TradeRows
            trades={history}
            onOpenTrade={onOpenTrade}
            label="History"
          />
        </details>
      )}
    </>
  );
}

function TradeSection({
  title,
  trades,
  onOpenTrade,
}: {
  title: string;
  trades: TradeView[];
  onOpenTrade: (id: string) => void;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <h2 id={headingId} className="m-0 text-heading font-semibold">
        {title}
      </h2>
      <TradeRows trades={trades} onOpenTrade={onOpenTrade} label={title} />
    </section>
  );
}

/** Rows carry no buttons: each is one link to its Trade. */
function TradeRows({
  trades,
  onOpenTrade,
  label,
}: {
  trades: TradeView[];
  onOpenTrade: (id: string) => void;
  label: string;
}) {
  return (
    <ul
      aria-label={label}
      className="m-0 list-none overflow-hidden rounded-panel border border-border bg-surface p-0"
    >
      {trades.map((trade) => (
        <li key={trade.id} className="border-b border-border last:border-b-0">
          <a
            href={tradePath(trade.id)}
            onClick={(event: MouseEvent) => {
              if (event.metaKey || event.ctrlKey || event.shiftKey) return;
              event.preventDefault();
              onOpenTrade(trade.id);
            }}
            className="grid min-h-tap grid-cols-[2.5rem_minmax(0,1fr)] items-center gap-3 px-4 py-3 text-text no-underline hover:bg-surface-raised"
          >
            <CardImage
              url={(trade.you_get[0] ?? trade.you_give[0])?.image_url ?? null}
            />
            <span className="flex min-w-0 flex-col">
              <span className="text-body font-semibold wrap-anywhere">
                {tradeHeadline(trade)}
              </span>
              <span className="text-meta text-text-muted wrap-anywhere">
                {tradeSubline(trade)}
                {trade.waiting === "fix_picks" &&
                  ` · ${tradeWaitingLabel(trade)}`}
              </span>
            </span>
          </a>
        </li>
      ))}
    </ul>
  );
}
