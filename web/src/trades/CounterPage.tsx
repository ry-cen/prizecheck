import { ChevronLeft } from "lucide-react";
import { useEffect, useState, type MouseEvent, type ReactNode } from "react";
import { PageHeader } from "../shell/PageHeader";
import { getTrade, SocialError, type TradeView } from "../social_generated";
import { Button } from "../ui/Button";
import { Icon } from "../ui/Icon";
import { ProposalBuilderPage } from "./ProposalBuilderPage";
import { tradePath } from "./tradeListModel";

type Load =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "failed" }
  | { kind: "ready"; trade: TradeView };

const FRAME =
  "mx-auto box-border flex max-w-7xl flex-col gap-4 px-7 py-6 phone:px-4 phone:py-4";
const BACK =
  "inline-flex h-control items-center gap-1 self-start rounded-control px-2 text-control font-medium text-text-muted no-underline hover:bg-surface-raised hover:text-text phone:h-control-phone";

/**
 * The Counter builder's page (Trading #278), at /trades/<id>/counter. It reads the Trade again on every load, so a
 * reload prefills the Counter again, and a proposal that was answered meanwhile can't be countered: it says so and
 * links back to the Trade. When the Trade is waiting for the reader's answer it hands the Trade to the proposal builder
 * in counter mode.
 */
export function CounterPage({
  tradeId,
  onNavigate,
}: {
  tradeId: string;
  onNavigate: (to: string) => void;
}) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    getTrade(tradeId, controller.signal).then(
      (trade) => {
        if (!controller.signal.aborted) setLoad({ kind: "ready", trade });
      },
      (cause) => {
        if (controller.signal.aborted) return;
        setLoad(
          cause instanceof SocialError && cause.status === 404
            ? { kind: "missing" }
            : { kind: "failed" }
        );
      }
    );
    return () => controller.abort();
  }, [tradeId, attempt]);

  if (
    load.kind === "ready" &&
    load.trade.actions.includes("counter") &&
    load.trade.other.handle
  )
    return (
      <ProposalBuilderPage
        handle={load.trade.other.handle}
        onNavigate={onNavigate}
        counter={load.trade}
      />
    );

  const to = tradePath(tradeId);
  const go = (event: MouseEvent) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey) return;
    event.preventDefault();
    onNavigate(to);
  };
  const frame = (title: string, children: ReactNode) => (
    <main className={FRAME}>
      <a href={to} onClick={go} className={BACK}>
        <Icon icon={ChevronLeft} />
        {load.kind === "ready"
          ? `${load.trade.other.display_name}'s Trade Proposal`
          : "Trade Proposal"}
      </a>
      <PageHeader title={title} />
      {children}
    </main>
  );

  if (load.kind === "missing")
    return frame(
      "Trade not found",
      <p className="m-0 text-body text-text-muted">
        This Trade can't be found.
      </p>
    );
  if (load.kind === "failed")
    return frame(
      "Counter",
      <div className="flex flex-wrap items-center gap-3">
        <p role="alert" className="m-0 text-body text-danger">
          This Trade couldn't be loaded.
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
  if (load.kind === "loading")
    return frame(
      "Counter",
      <p role="status" className="m-0 text-body text-text-muted">
        Loading…
      </p>
    );
  return frame(
    "Counter",
    <p className="m-0 text-body text-text-muted">
      {load.trade.actions.includes("counter")
        ? "This Trade Proposal can't be countered right now."
        : "This Trade Proposal isn't waiting for your answer, so it can't be countered."}
    </p>
  );
}
