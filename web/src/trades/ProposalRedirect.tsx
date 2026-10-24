import { ChevronLeft } from "lucide-react";
import { useEffect, useState, type MouseEvent } from "react";
import { PageHeader } from "../shell/PageHeader";
import { getFriendTradeList, SocialError } from "../social_generated";
import { Button } from "../ui/Button";
import { Icon } from "../ui/Icon";
import { rekeyProposal } from "./openProposal";
import { proposalPath, TRADE_FIND_PATH } from "./tradeListModel";

type Load = "loading" | "missing" | "failed";

const FRAME =
  "mx-auto box-border flex max-w-7xl flex-col gap-4 px-7 py-6 phone:px-4 phone:py-4";
const BACK =
  "inline-flex h-control items-center gap-1 self-start rounded-control px-2 text-control font-medium text-text-muted no-underline hover:bg-surface-raised hover:text-text phone:h-control-phone";

/**
 * The Handle address of a Friend's proposal builder, /trades/new/<Handle> (Trading #284, #299). It reads the Friend's
 * Trade List once to learn their trader id, moves the in-memory seed and origin from the Handle to it, and replaces the
 * address with /trades/new/<trader id>, so Back never lands here again. A Handle that isn't one of the collector's
 * Friends gets the plain sentence the builder used to give.
 */
export function ProposalRedirect({
  handle,
  onNavigate,
}: {
  handle: string;
  onNavigate: (to: string, options?: { replace?: boolean }) => void;
}) {
  const [load, setLoad] = useState<Load>("loading");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoad("loading");
    getFriendTradeList(handle, { q: "" }, controller.signal).then(
      (page) => {
        if (controller.signal.aborted) return;
        rekeyProposal(handle, page.trader_id);
        onNavigate(proposalPath(page.trader_id), { replace: true });
      },
      (cause) => {
        if (controller.signal.aborted) return;
        setLoad(
          cause instanceof SocialError && cause.status === 404
            ? "missing"
            : "failed"
        );
      }
    );
    return () => controller.abort();
  }, [handle, attempt]);

  const go = (event: MouseEvent) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey) return;
    event.preventDefault();
    onNavigate(TRADE_FIND_PATH);
  };
  return (
    <main className={FRAME}>
      <a href={TRADE_FIND_PATH} onClick={go} className={BACK}>
        <Icon icon={ChevronLeft} />
        Find trades
      </a>
      <PageHeader title="Trade Proposal" />
      {load === "missing" ? (
        <p className="m-0 text-body text-text-muted">
          This collector isn't one of your Friends.
        </p>
      ) : load === "failed" ? (
        <div className="flex flex-wrap items-center gap-3">
          <p role="alert" className="m-0 text-body text-danger">
            This proposal couldn't be opened. Please retry.
          </p>
          <Button onClick={() => setAttempt((n) => n + 1)}>Retry</Button>
        </div>
      ) : (
        <p role="status" className="m-0 text-body text-text-muted">
          Loading…
        </p>
      )}
    </main>
  );
}
