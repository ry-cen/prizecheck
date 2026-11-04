import { useEffect, useState } from "react";
import { getDiscovery } from "../social_generated";
import { SUSPENDED_NOTE } from "../trades/conversationMessages";

/** Read only the signed-in collector's standing. Counterpart unavailability never
 * supplies a reason, and this notice never changes an agreement's allowed actions. */
export function TradingAvailability({
  enabled,
  revision,
}: {
  enabled: boolean;
  revision: string;
}) {
  const [suspended, setSuspended] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    getDiscovery(controller.signal).then(
      (value) => {
        if (!controller.signal.aborted)
          setSuspended(value.status === "suspended");
      },
      () => {}
    );
    return () => controller.abort();
  }, [enabled, revision]);
  return enabled && suspended ? (
    <p className="m-0 text-body">{SUSPENDED_NOTE}</p>
  ) : null;
}
