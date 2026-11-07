import { PageHeader } from "../shell/PageHeader";
import { Segmented } from "../ui/Segmented";
import { TRADES_VIEWS, tradesViewPath } from "./tradeListModel";

/** The title and view switch share the same spacing in every Trades view. */
export function TradesViewHeader({
  selected = false,
  idBase,
  panelId,
  view,
  onNavigate,
}: {
  selected?: boolean;
  idBase: string;
  panelId: string;
  view: (typeof TRADES_VIEWS)[number]["value"];
  onNavigate: (to: string) => void;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1 border-b border-border pb-4">
      {selected ? (
        <div className="mb-5">
          <h2 className="text-heading">Trades</h2>
        </div>
      ) : (
        <PageHeader title="Trades" />
      )}
      <Segmented
        label="Trades view"
        idBase={idBase}
        panelId={panelId}
        value={view}
        onChange={(next) => onNavigate(tradesViewPath(next))}
        options={TRADES_VIEWS}
      />
    </div>
  );
}
