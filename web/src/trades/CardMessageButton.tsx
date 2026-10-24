import type { FriendTradeCard } from "../social_generated";
import { Button } from "../ui/Button";
import { prefilledMessagePath } from "./messagePrefill";
import {
  CARD_MESSAGE,
  cardMessageLabel,
  cardQuestion,
} from "./strangerMessages";
import { tradeCardName } from "./tradeText";

/** The conversation with a trader, opened with a question about one of their cards in the composer. */
export function cardMessagePath(
  traderId: string,
  card: FriendTradeCard
): string {
  return prefilledMessagePath(traderId, cardQuestion(tradeCardName(card)));
}

/** **Message** on one card of a stranger's Trade List. */
export function CardMessageButton({
  traderId,
  name,
  card,
  onNavigate,
}: {
  traderId: string;
  name: string;
  card: FriendTradeCard;
  onNavigate: (to: string) => void;
}) {
  return (
    <Button
      aria-label={cardMessageLabel(name, tradeCardName(card))}
      onClick={() => onNavigate(cardMessagePath(traderId, card))}
    >
      {CARD_MESSAGE}
    </Button>
  );
}
