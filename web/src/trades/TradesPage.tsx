import { ListDetailLayout } from "../ui/ListDetailLayout";
import { LegacyThreadLink } from "../threads/LegacyThreadLink";
import { useId, useLayoutEffect, useRef, useState } from "react";
import { TradesViewHeader } from "./TradesViewHeader";
import { segmentId } from "../ui/Segmented";
import { ThreadList } from "../threads/ThreadList";

import { CounterPage } from "./CounterPage";
import { FindTrades } from "./FindTrades";
import { MyTradeList } from "./MyTradeList";
import { ProposalBuilderPage } from "./ProposalBuilderPage";
import { ProposalRedirect } from "./ProposalRedirect";
import { TradeScreen } from "./TradeScreen";
import { TraderTradeListPage } from "./TraderTradeListPage";
import { TRADES_PATH, tradePath, tradesRoute } from "./tradeListModel";

type Props = {
  /** The section the address names (``sectionAt``): null for /trades, "find", "list", "new/<trader id>" (or "new/<Handle>", which redirects), "trader/<trader id>", "with/<trader id>", "conversation/<conversation id>", "<id>/counter", or a Trade id. */
  section: string | null;
  active: boolean;
  /** Goes to another address in the app; `replace` swaps the current history entry. */
  onNavigate: (to: string, options?: { replace?: boolean }) => void;
};

/**
 * The Trades tab (Trading #269, #270, #276 and #298, prototype verdict variant A): the page header and the switch over
 * the tab's views, `Trades · Find trades · My Trade List`: the conversation list (/trades), Find trades (/trades/find)
 * and My Trade List (/trades/list). The switch stays mounted across the views' addresses, as the Decks page's does.
 * A conversation (/trades/with/<trader id> or /trades/conversation/<conversation id>, #298), a proposal builder
 * (/trades/new/<trader id>, #284 and #299; /trades/new/<Handle> redirects to it), a stranger's Trade List
 * (/trades/trader/<trader id>, #299), the Counter builder for a proposal sent to you (/trades/<id>/counter, #278)
 * and one Trade (/trades/<id>) are pages of their own under the tab.
 */
export function TradesPage({ active, section, onNavigate }: Props) {
  const idBase = useId();
  const [revision, setRevision] = useState(0);
  const panelId = `${idBase}-panel`;
  // The address an in-app press went to: a Trade opened that way (a list row, a sent Trade Proposal) takes focus on
  // its heading, as a Loan opened from its list does (LoansPage). A direct load or reload leaves focus where it is.
  const opening = useRef<string | null>(null);
  useLayoutEffect(() => {
    opening.current = null;
  }, [section]);
  const route = tradesRoute(section);
  // Capture this render's intent before the layout effect clears the pending press.
  // A canonical replacement carries that intent to the new ID without inventing a press.
  const focusOnOpen =
    route.kind === "trade" && opening.current === tradePath(route.id);
  const go = (to: string, options?: { replace?: boolean }) => {
    opening.current = options?.replace ? (focusOnOpen ? to : null) : to;
    onNavigate(to, options);
  };
  if (route.kind === "new")
    return (
      <ProposalBuilderPage
        key={route.traderId}
        traderId={route.traderId}
        onNavigate={go}
      />
    );
  if (route.kind === "newHandle")
    return (
      <ProposalRedirect
        key={route.handle.toLowerCase()}
        handle={route.handle}
        onNavigate={go}
      />
    );
  if (route.kind === "trader")
    return (
      <TraderTradeListPage
        key={route.traderId}
        traderId={route.traderId}
        onNavigate={go}
      />
    );
  if (route.kind === "with" || route.kind === "conversation")
    return <LegacyThreadLink section={section!} onNavigate={go} />;
  if (route.kind === "counter")
    return (
      <CounterPage
        key={`counter-${route.id}`}
        tradeId={route.id}
        onNavigate={go}
      />
    );
  if (
    route.kind === "trade" ||
    route.kind === "missing" ||
    (route.kind === "view" && route.view === "trades")
  )
    return (
      <ListDetailLayout
        selected={route.kind !== "view"}
        queue={
          <div className="flex min-w-0 flex-col gap-4">
            <TradesViewHeader
              selected={route.kind !== "view"}
              idBase={idBase}
              panelId={panelId}
              view="trades"
              onNavigate={go}
            />
            <div
              role="tabpanel"
              id={panelId}
              aria-labelledby={segmentId(idBase, "trades")}
            >
              <ThreadList
                kind="trade"
                active={active}
                revision={revision}
                selected={route.kind === "trade" ? route.id : null}
                onOpen={(id) => go(`/trades/${id}`)}
              />
            </div>
          </div>
        }
        detail={
          route.kind === "view" ? (
            <p className="m-0 text-body text-text-muted">Choose a Trade…</p>
          ) : (
            <TradeScreen
              active={active}
              onTradeChanged={() => setRevision((n) => n + 1)}
              key={route.kind === "trade" ? route.id : "missing"}
              tradeId={route.kind === "trade" ? route.id : null}
              focusOnOpen={focusOnOpen}
              onAllTrades={() => go(TRADES_PATH)}
              onNavigate={go}
            />
          )
        }
      />
    );
  const view = route.view;
  // Find trades shares the tab's wider frame while keeping search above the
  // stacked Friends / Near you groups: no prototype evidence supports columns.
  return (
    <main className="mx-auto box-border flex w-full min-w-0 max-w-5xl min-[1440px]:max-w-[1536px] flex-col gap-6 px-7 py-7 phone:px-4 phone:py-5">
      <TradesViewHeader
        idBase={idBase}
        panelId={panelId}
        view={view}
        onNavigate={go}
      />
      <div
        role="tabpanel"
        id={panelId}
        aria-labelledby={segmentId(idBase, view)}
        className="flex min-w-0 flex-col gap-5"
      >
        {view === "find" ? (
          <FindTrades onNavigate={go} />
        ) : (
          <MyTradeList onOpenCollection={() => go("/collection")} />
        )}
      </div>
    </main>
  );
}
