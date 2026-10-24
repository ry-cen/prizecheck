import type { MouseEvent } from "react";
import { messageLabel } from "./nearYouMessages";
import { traderConversationPath } from "./tradeListModel";

const LINK =
  "inline-flex h-control items-center rounded-control px-2 text-control font-medium text-accent-strong no-underline hover:bg-surface-raised phone:h-control-phone";

/**
 * Message (Trading #300): a plain link to the conversation with a collector by trader id, used by Friend rows, Near
 * you rows and card search holders. It is the one place a composer prefill is added (Trading #301).
 */
export function MessageLink({
  traderId,
  name,
  onNavigate,
}: {
  traderId: string;
  name: string;
  onNavigate: (to: string) => void;
}) {
  const href = traderConversationPath(traderId);
  const go = (event: MouseEvent) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey) return;
    event.preventDefault();
    onNavigate(href);
  };
  return (
    <a
      href={href}
      onClick={go}
      aria-label={messageLabel(name)}
      className={LINK}
    >
      Message
    </a>
  );
}
