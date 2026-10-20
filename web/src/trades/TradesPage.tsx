import { useId } from "react";
import { PageHeader } from "../shell/PageHeader";
import { Segmented, segmentId } from "../ui/Segmented";
import { MyTradeList } from "./MyTradeList";
import {
  TRADES_VIEWS,
  tradesViewPath,
  type TradesView,
} from "./tradeListModel";

type Props = {
  /** The view the address opens. */
  view: TradesView;
  /** Goes to another address in the app. */
  onNavigate: (to: string) => void;
};

/**
 * The Trades tab (Trading #269, prototype verdict variant A): the page header and the switch over the tab's views,
 * `Trades · Find trades · My Trade List`. My Trade List is the first view; the Trades list and Find trades join the
 * switch in later tickets. The switch stays mounted across the views' addresses, as the Decks page's does.
 */
export function TradesPage({ view, onNavigate }: Props) {
  const idBase = useId();
  const panelId = `${idBase}-panel`;
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
        <MyTradeList onOpenCollection={() => onNavigate("/collection")} />
      </div>
    </main>
  );
}
