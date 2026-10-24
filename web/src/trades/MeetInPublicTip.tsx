import type { TradeView } from "../social_generated";
import { MEET_IN_PUBLIC, meetTipShows } from "./strangerMessages";

/** The meet-in-public tip, on an accepted Trade with a collector who is not a Friend. */
export function MeetInPublicTip({ trade }: { trade: TradeView }) {
  if (!meetTipShows(trade)) return null;
  return <p className="m-0 text-body text-text-muted">{MEET_IN_PUBLIC}</p>;
}
