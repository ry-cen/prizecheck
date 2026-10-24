import { useEffect, useState } from "react";
import { traderConversationPath } from "./tradeListModel";

export const DRAFT_PARAM = "draft";
/** The longest prefill taken, in code points. */
export const PREFILL_LIMIT = 300;

/** The conversation with a trader, with `text` to start the composer with. */
export function prefilledMessagePath(traderId: string, text: string): string {
  return `${traderConversationPath(traderId)}?${new URLSearchParams({ [DRAFT_PARAM]: text })}`;
}

/** The prefill in an address's query string: trimmed, or "" when it is missing, empty or too long. */
export function readPrefill(search: string): string {
  const text = (new URLSearchParams(search).get(DRAFT_PARAM) ?? "").trim();
  return [...text].length > PREFILL_LIMIT ? "" : text;
}

/** The query string without the prefill: "" when nothing is left, else "?" and the rest. */
export function withoutPrefill(search: string): string {
  const rest = new URLSearchParams(search);
  rest.delete(DRAFT_PARAM);
  const text = rest.toString();
  return text === "" ? "" : `?${text}`;
}

/**
 * The text to start the composer with. It is read once per mount, then dropped from the address, so a reload, Back or
 * a reread never puts it back. It is plain text the reader can edit before sending.
 */
export function useMessagePrefill(): string {
  const [text] = useState(() => readPrefill(window.location.search));
  useEffect(() => {
    if (new URLSearchParams(window.location.search).has(DRAFT_PARAM)) {
      window.history.replaceState(
        null,
        "",
        window.location.pathname +
          withoutPrefill(window.location.search) +
          window.location.hash
      );
    }
  }, []);
  return text;
}
