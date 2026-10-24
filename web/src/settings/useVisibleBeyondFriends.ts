import { useEffect, useState } from "react";
import { getDiscovery } from "../social_generated";

/**
 * Whether the collector is visible beyond Friends (open discovery on, or a conversation in reach), read once on mount. It is false until
 * the answer arrives and when the read fails, so Stage 1's wording stays whenever the flag is unknown.
 */
export function useVisibleBeyondFriends(): boolean {
  const [beyond, setBeyond] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    getDiscovery(controller.signal)
      .then((settings) => {
        if (!controller.signal.aborted)
          setBeyond(settings.visible_beyond_friends);
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);
  return beyond;
}
