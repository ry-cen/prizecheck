import { useEffect, useId, useRef, useState } from "react";
import { RevokeControl } from "../decks/RevokeControl";
import { visibilityText } from "../decks/publication";
import { formatLabel } from "../decks/targetFormat";
import type { PublishedFormatCheck } from "../format_checks_generated";
import {
  getOwnedPublications,
  PublicationError,
  revokePublication,
  setPublishedDeckVisibility,
  type OwnedPublication,
} from "../publications_generated";
import { Button } from "../ui/Button";
import { SECONDARY } from "./controls";
import { followLink } from "./publicRoutes";

type Props = {
  token: string;
  /** The snapshot's Target Format and today's result in it (null while it is checked or couldn't be). */
  targetFormat: string;
  result: PublishedFormatCheck | null;
  onNavigate: (to: string) => void;
  /** A visibility change or a revoke landed: the page reads its snapshot again (a revoked one is gone). */
  onChanged: () => void;
};

type Action = "listed" | "unlisted" | "revoke";

/**
 * Why a Listed Published Deck isn't on Discover (ADR 0011: Discover lists only decks legal in their Target Format
 * today), or null while it is legal, unlisted or still being checked.
 */
export function hiddenFromDiscover(
  visibility: string,
  targetFormat: string,
  result: PublishedFormatCheck | null
): string | null {
  if (visibility !== "listed" || !result || result.status === "legal")
    return null;
  const format = formatLabel(targetFormat);
  return result.status === "not_legal"
    ? `Hidden from Discover: not legal in ${format}`
    : `Hidden from Discover: ${format} result unknown`;
}

/**
 * The owner bar (#183): only for the signed-in owner of this Published Deck, found by its token among their own
 * publications (GET /api/publications; no public route says who owns a deck). "Your Published Deck · Unlisted · v3",
 * Make Listed or Unlisted, Revoke in two steps, and Open Deck, or "Deck deleted" when its Deck is gone. While Listed
 * but not legal in its Target Format it says it is hidden from Discover. Republish lives on the Deck.
 *
 * Commands use the token routes, which work with or without the Deck. A retry after an unconfirmed answer reuses the
 * same idempotency key, as the Decks index does (#181).
 */
export function OwnerBar({
  token,
  targetFormat,
  result,
  onNavigate,
  onChanged,
}: Props) {
  const idBase = useId();
  const [mine, setMine] = useState<OwnedPublication | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const pending = useRef<{ action: Action; key: string } | null>(null);
  const reads = useRef(0);

  async function read() {
    const ticket = ++reads.current;
    try {
      const owned = await getOwnedPublications();
      if (ticket !== reads.current || !Array.isArray(owned.publications))
        return;
      setMine(
        owned.publications.find((entry) => entry.token === token) ?? null
      );
    } catch {
      // Not signed in any more, or the read failed: show no bar rather than a wrong one.
      if (ticket === reads.current) setMine(null);
    }
  }
  useEffect(() => {
    void read();
    return () => {
      reads.current++;
    };
  }, [token]);

  async function act(action: Action) {
    if (busy || !mine) return;
    setBusy(true);
    setMessage("");
    const previous = pending.current;
    const attempt =
      previous && previous.action === action
        ? previous
        : { action, key: crypto.randomUUID() };
    pending.current = attempt;
    try {
      if (action === "revoke")
        await revokePublication(token, { idempotency_key: attempt.key });
      else
        await setPublishedDeckVisibility(token, {
          visibility: action,
          idempotency_key: attempt.key,
        });
      pending.current = null;
      if (action !== "revoke") {
        await read();
        setMessage(
          `${mine.title} is ${action === "listed" ? "Listed" : "Unlisted"} now.`
        );
      }
      onChanged();
    } catch (cause) {
      if (cause instanceof PublicationError && cause.status < 500) {
        pending.current = null;
        await read();
        onChanged();
        setMessage(
          "This Published Deck changed somewhere else. It's up to date now: try again."
        );
      } else
        setMessage(
          "That change hasn't been confirmed. Press the same button again to finish it safely."
        );
    } finally {
      setBusy(false);
    }
  }

  if (!mine) return null;
  const listed = mine.visibility === "listed";
  const hidden = hiddenFromDiscover(mine.visibility, targetFormat, result);
  const deckHref = mine.deck_id
    ? `/decks/${encodeURIComponent(mine.deck_id)}`
    : null;
  return (
    <section
      aria-labelledby={`${idBase}-owner`}
      className="box-border flex flex-wrap items-center gap-x-4 gap-y-2 rounded-panel border border-accent-border bg-surface px-4 py-3"
    >
      <div className="flex min-w-0 flex-[1_1_16rem] flex-col gap-0.5">
        <h2
          id={`${idBase}-owner`}
          className="m-0 text-body font-semibold wrap-anywhere"
        >
          Your Published Deck · {visibilityText(mine.visibility)} · v
          {mine.version}
        </h2>
        {!deckHref && (
          <p className="m-0 text-meta text-text-muted">Deck deleted</p>
        )}
        {hidden && <p className="m-0 text-meta text-warning">{hidden}</p>}
        {mine.projection_pending && (
          <p className="m-0 text-meta text-warning">
            The public copy is catching up. Press the last button again to
            finish it.
          </p>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          aria-disabled={busy || undefined}
          onClick={() => void act(listed ? "unlisted" : "listed")}
        >
          {listed ? "Make Unlisted" : "Make Listed"}
        </Button>
        <RevokeControl
          title={mine.title}
          busy={busy}
          onRevoke={() => void act("revoke")}
        />
        {deckHref && (
          <a
            href={deckHref}
            onClick={followLink(onNavigate)}
            className={SECONDARY}
          >
            Open Deck
          </a>
        )}
      </div>
      <p role="status" className="m-0 basis-full text-meta text-text-muted">
        {message}
      </p>
    </section>
  );
}
