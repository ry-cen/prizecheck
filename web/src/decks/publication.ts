import { useCallback, useEffect, useRef, useState } from "react";
import type { FormatCheck } from "../format_checks_generated";
import {
  getPublication,
  type PublicationStatus,
} from "../publications_generated";
import { formatLabel, issueCount, type TargetFormat } from "./targetFormat";

/**
 * Why Publish (and Republish) is disabled (#181, ADR 0011), or null when the Deck may publish: publishing needs a
 * legal result in the Deck's Target Format. "Publish needs a legal Standard deck: 2 issues".
 */
export function publishBlock(
  target: TargetFormat,
  result: FormatCheck | null
): string | null {
  const format = formatLabel(target);
  if (!result) return `Publish waits for the ${format} result.`;
  if (result.status === "legal") return null;
  if (result.issues.length)
    return `Publish needs a legal ${format} deck: ${issueCount(result)}`;
  return result.status === "unknown"
    ? `Publish needs a legal ${format} deck: the result is unknown`
    : `Publish needs a legal ${format} deck`;
}

/** "Listed" or "Unlisted". */
export function visibilityText(visibility: string | null): string {
  return visibility === "listed" ? "Listed" : "Unlisted";
}

export type PublicationRead =
  | { kind: "loading" }
  | { kind: "ready"; status: PublicationStatus }
  | { kind: "failed" };

/**
 * The Deck's publication (GET /api/decks/{id}/publication): whether it is published, and its title, visibility and
 * version. The deck builder reads it once, so Publish knows whether it publishes or manages a publication, and the
 * Publish dialog reads it again after each command.
 */
export function usePublication(deckId: string) {
  const [read, setRead] = useState<PublicationRead>({ kind: "loading" });
  const ticket = useRef(0);
  const reload = useCallback(async () => {
    const mine = ++ticket.current;
    try {
      const status = await getPublication(deckId);
      if (mine === ticket.current) setRead({ kind: "ready", status });
    } catch {
      if (mine === ticket.current)
        setRead((previous) =>
          previous.kind === "ready" ? previous : { kind: "failed" }
        );
    }
  }, [deckId]);
  useEffect(() => {
    void reload();
    return () => {
      ticket.current++;
    };
  }, [reload]);
  return { read, reload };
}
