import { activationRead } from "./keptPages";
import { createContext, useContext, useEffect, useRef } from "react";

export const FirstReadContext = createContext<(() => void) | null>(null);

export function useFirstReadSettled(settled: boolean) {
  const report = useContext(FirstReadContext);
  useEffect(() => {
    if (settled) report?.();
  }, [settled, report]);
}

/** Mount reads belong to the instance. Activation never cancels a read already in flight. */
export function useReadOnShow(
  active: boolean,
  failed: boolean,
  read: (quiet: boolean) => void,
  skip = false
) {
  const everShown = useRef(false);
  const callback = useRef(read);
  callback.current = read;
  // Only activation starts a read; data arriving or failing while shown must not start another one.
  useEffect(() => {
    if (!active) return;
    const returning = everShown.current;
    everShown.current = true;
    const quiet = activationRead(returning, failed, skip);
    if (quiet !== null) callback.current(quiet);
  }, [active]);
}
