import { useEffect } from "react";
/** Retired pair-Conversation links land on the item list. */
export function LegacyThreadLink({
  onNavigate,
}: {
  section: string;
  onNavigate: (to: string, options?: { replace?: boolean }) => void;
}) {
  useEffect(() => onNavigate("/trades", { replace: true }), [onNavigate]);
  return <p role="status">Opening Trades…</p>;
}
