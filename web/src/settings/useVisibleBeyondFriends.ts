import { useReadOnShow } from "../shell/keptRead";
import { useEffect, useRef, useState } from "react";
import { getDiscovery } from "../social_generated";

/**
 * Whether the collector is visible beyond Friends, read on mount and quietly on return when given activation.
 * Initial failure uses Stage 1 wording; a failed quiet read keeps the last known wording.
 */
export function useDiscoveryVisibility(active = false): {
  beyond: boolean;
  settled: boolean;
} {
  const [state, setState] = useState({
    beyond: false,
    settled: false,
    failed: false,
  });
  const generation = useRef(0);
  const pending = useRef<AbortController | null>(null);
  function read(quiet = false) {
    const mine = ++generation.current;
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    return getDiscovery(controller.signal)
      .then((settings) => {
        if (!controller.signal.aborted && mine === generation.current)
          setState({
            beyond: settings.visible_beyond_friends,
            settled: true,
            failed: false,
          });
      })
      .catch(() => {
        if (!controller.signal.aborted && mine === generation.current && !quiet)
          setState({ beyond: false, settled: true, failed: true });
      });
  }
  useEffect(() => {
    void read();
    return () => {
      generation.current++;
      pending.current?.abort();
    };
  }, []);
  useReadOnShow(active, state.failed, (quiet) => void read(quiet));
  return state;
}

/** Whether the collector is visible beyond Friends; false until known. */
export function useVisibleBeyondFriends(): boolean {
  return useDiscoveryVisibility().beyond;
}
