import { useEffect, useState } from "react";
import { getDiscovery } from "../social_generated";

/**
 * Whether the collector is visible beyond Friends (open discovery on, or a conversation in reach), read once on mount,
 * and whether that read has finished (answered or failed). `beyond` is false until the answer arrives and when the
 * read fails, so Stage 1's wording stays whenever the flag is unknown.
 */
export function useDiscoveryVisibility(): {
  beyond: boolean;
  settled: boolean;
} {
  const [state, setState] = useState({ beyond: false, settled: false });
  useEffect(() => {
    const controller = new AbortController();
    getDiscovery(controller.signal)
      .then((settings) => {
        if (!controller.signal.aborted)
          setState({
            beyond: settings.visible_beyond_friends,
            settled: true,
          });
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setState({ beyond: false, settled: true });
      });
    return () => controller.abort();
  }, []);
  return state;
}

/** Whether the collector is visible beyond Friends; false until known. */
export function useVisibleBeyondFriends(): boolean {
  return useDiscoveryVisibility().beyond;
}
