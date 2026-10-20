import { useId } from "react";
import { PageHeader } from "../shell/PageHeader";
import { Segmented, segmentId } from "../ui/Segmented";
import { FindTrades } from "./FindTrades";
import { MyTradeList } from "./MyTradeList";
import { TradeDraftPage } from "./TradeDraftPage";
import { TradeScreen } from "./TradeScreen";
import { TradesList } from "./TradesList";
import {
  TRADES_PATH,
  TRADES_VIEWS,
  tradePath,
  tradesRoute,
  tradesViewPath,
} from "./tradeListModel";

type Props = {
  /** The section the address names (``sectionAt``): null for /trades, "find", "list", "draft", or a Trade id. */
  section: string | null;
  /** Goes to another address in the app. */
  onNavigate: (to: string) => void;
};

/**
 * The Trades tab (Trading #269, #270 and #276, prototype verdict variant A): the page header and the switch over the
 * tab's views, `Trades · Find trades · My Trade List`: the Trades list (/trades), Find trades (/trades/find) and My
 * Trade List (/trades/list). The switch stays mounted across the views' addresses, as the Decks page's does.
 * The Trade Proposal draft (/trades/draft) and one Trade (/trades/<id>) are pages of their own under the tab.
 */
export function TradesPage({ section, onNavigate }: Props) {
  const idBase = useId();
  const panelId = `${idBase}-panel`;
  const route = tradesRoute(section);
  if (route.kind === "draft") return <TradeDraftPage onNavigate={onNavigate} />;
  if (route.kind === "trade" || route.kind === "missing")
    return (
      <TradeScreen
        key={route.kind === "trade" ? route.id : "missing"}
        tradeId={route.kind === "trade" ? route.id : null}
        onAllTrades={() => onNavigate(TRADES_PATH)}
      />
    );
  const view = route.view;
  return (
    <main className="mx-auto box-border flex max-w-3xl flex-col gap-6 px-7 py-6 phone:px-4 phone:py-4">
      {/* The switch sits right under the title, closer than the page's sections are to each other. */}
      <div className="flex min-w-0 flex-col">
        <PageHeader title="Trades" />
        <Segmented
          label="Trades view"
          idBase={idBase}
          panelId={panelId}
          value={view}
          onChange={(next) => onNavigate(tradesViewPath(next))}
          options={TRADES_VIEWS}
        />
      </div>
      <div
        role="tabpanel"
        id={panelId}
        aria-labelledby={segmentId(idBase, view)}
        className="flex min-w-0 flex-col gap-5"
      >
        {view === "trades" ? (
          <TradesList onOpenTrade={(id) => onNavigate(tradePath(id))} />
        ) : view === "find" ? (
          <FindTrades onNavigate={onNavigate} />
        ) : (
          <MyTradeList onOpenCollection={() => onNavigate("/collection")} />
        )}
      </div>
    </main>
  );
}
