import { useCallback, useEffect, useRef, useState } from "react";
import { getConversationPulse } from "../social_generated";

/** How often the pulse is read while a conversation page is open and the document is visible. */
export const PULSE_FAST_MS = 15_000;
/** How often it is read otherwise, while the document is visible. */
export const PULSE_SLOW_MS = 60_000;

/**
 * The conversation pulse (Trading #298): `unread` conversations for the Trades tab's badge, and a call to `onChange`
 * when the watermark differs from the last one seen (the first read only stores it). It reads at once on mount, on
 * focus and on the document becoming visible, then every 15 s with a conversation open (`fast`) or every 60 s, and
 * never while the document is hidden. A failed read is ignored; the next one tries again. `poll` reads now.
 */
export function usePulse(
  fast: boolean,
  onChange: () => void
): { unread: number; poll: () => void } {
  const [unread, setUnread] = useState(0);
  const watermark = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef(false);
  const again = useRef(false);
  const changed = useRef(onChange);
  const quick = useRef(fast);
  const alive = useRef(true);
  changed.current = onChange;
  quick.current = fast;

  const clear = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const poll = useCallback(() => {
    if (document.visibilityState !== "visible") return;
    if (inFlight.current) {
      // A focus or a send during a read asks for one more read when this one ends.
      again.current = true;
      return;
    }
    clear();
    inFlight.current = true;
    getConversationPulse()
      .then(
        (pulse) => {
          if (!alive.current) return;
          setUnread(pulse.unread_conversations);
          const before = watermark.current;
          watermark.current = pulse.watermark;
          if (before !== null && before !== pulse.watermark) changed.current();
        },
        () => {
          // The next poll tries again.
        }
      )
      .finally(() => {
        inFlight.current = false;
        clear();
        if (alive.current && again.current) {
          again.current = false;
          poll();
          return;
        }
        again.current = false;
        if (alive.current && document.visibilityState === "visible")
          timer.current = setTimeout(
            poll,
            quick.current ? PULSE_FAST_MS : PULSE_SLOW_MS
          );
      });
  }, [clear]);

  useEffect(() => {
    alive.current = true;
    poll();
    const onVisibility = () => {
      if (document.visibilityState === "visible") poll();
      else clear();
    };
    window.addEventListener("focus", poll);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      alive.current = false;
      window.removeEventListener("focus", poll);
      document.removeEventListener("visibilitychange", onVisibility);
      clear();
    };
  }, [poll, clear]);

  // A changed cadence takes effect from now, not after the wait already running.
  useEffect(() => {
    if (inFlight.current || document.visibilityState !== "visible") return;
    clear();
    timer.current = setTimeout(poll, fast ? PULSE_FAST_MS : PULSE_SLOW_MS);
  }, [fast, poll, clear]);

  return { unread, poll };
}
