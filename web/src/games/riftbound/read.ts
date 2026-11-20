import { useEffect, useState } from "react";
export type ReadState<T> = { key: string; value?: T; failed?: boolean };
/** Keyed render + cleanup guard: even a reader ignoring abort cannot publish a superseded response. No shared cache. */
export function useRead<T>(
  key: string,
  load: (signal: AbortSignal) => Promise<T>,
  active = true
) {
  const [state, setState] = useState<ReadState<T>>({ key: "" });
  const [attempt, retry] = useState(0);
  useEffect(() => {
    if (!active) return;
    let current = true;
    const controller = new AbortController();
    setState((previous) =>
      previous.key === key && previous.value !== undefined ? previous : { key }
    );
    load(controller.signal).then(
      (value) => {
        if (current) setState({ key, value });
      },
      () => {
        if (current) setState({ key, failed: true });
      }
    );
    return () => {
      current = false;
      controller.abort();
    };
  }, [key, active, attempt, load]);
  return {
    ...(state.key === key ? state : { key }),
    retry: () => retry((n) => n + 1),
  };
}
