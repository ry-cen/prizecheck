import type { MouseEvent } from "react";
import { CardImage } from "../social/FriendCollectionPage";
import type { TradeView } from "../social_generated";
import { tradePath } from "./tradeListModel";
import { tradeHeadline, tradeSubline, tradeWaitingLabel } from "./tradeText";

/**
 * One Trade as a card-sized link to its screen (Trading #270, moved here by #298 when the conversation took over the
 * Trades tab): the first card's image, the headline, what each side gives, and the inbox's "Fix picks" on the second
 * line when the Trade waits on the reader to fix a pick. The conversation draws it inline for each Trade round.
 */
export function TradeCardLink({
  trade,
  onOpenTrade,
}: {
  trade: TradeView;
  onOpenTrade: (id: string) => void;
}) {
  return (
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
          {trade.waiting === "fix_picks" && ` · ${tradeWaitingLabel(trade)}`}
        </span>
      </span>
    </a>
  );
}
