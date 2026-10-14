import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import {
  PublicationError,
  publishDeck,
  republishDeck,
  revokeDeck,
  setPublicationVisibility,
} from "../publications_generated";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { TextField } from "../ui/TextField";
import { visibilityText, type PublicationRead } from "./publication";
import { RevokeControl } from "./RevokeControl";

type Action = "publish" | "republish" | "revoke" | "visibility";
type Attempt = {
  action: Action;
  title: string;
  key: string;
  visibility?: "listed" | "unlisted";
};

type Props = {
  open: boolean;
  onClose: () => void;
  returnFocus: React.RefObject<HTMLElement | null>;
  deckId: string;
  /** The Deck's publication, read by the page (usePublication). */
  publication: PublicationRead;
  /** Reads the publication again; the dialog calls it after every command. */
  onReload: () => Promise<void>;
  /** Why Publish and Republish are disabled (publishBlock), or null when the result is legal. */
  blocked: string | null;
  /** The server refused the result as not legal: the page reads the Deck again, so the header and this agree. */
  onNotLegal: () => void;
};

const MESSAGES: Record<Action, string> = {
  publish: "Published. Anyone with the link can view the snapshot.",
  republish: "Republished: the public snapshot now matches this Deck List.",
  revoke: "Public link revoked permanently.",
  visibility: "Public visibility updated.",
};

/**
 * The Publish dialog (#181): a Published Deck is a snapshot of the Deck List under a public title. Unpublished, it
 * asks for the title and publishes an Unlisted snapshot. Published, it shows the title, visibility and version, a link
 * to the public page, Republish, List in Discover (or Make Unlisted) and Revoke.
 *
 * Publish and Republish need a legal Target Format result (`blocked`); visibility and Revoke never do, so a
 * publication whose Deck stopped being legal can still be unlisted or revoked. A command with no answer keeps its
 * idempotency key, so pressing the same button again applies it once.
 */
export function PublishDialog({
  open,
  onClose,
  returnFocus,
  deckId,
  publication,
  onReload,
  blocked,
  onNotLegal,
}: Props) {
  const idBase = useId();
  const status = publication.kind === "ready" ? publication.status : null;
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const pending = useRef<Attempt | null>(null);
  const titleField = useRef<HTMLInputElement>(null);

  // Each opening starts from the publication's own title, with no old message.
  useEffect(() => {
    if (!open) return;
    setTitle(status?.title ?? "");
    setMessage("");
    pending.current = null;
    // Only an opening resets the form; a reload while open keeps what was typed.
  }, [open]);

  async function act(action: Action, visibility?: "listed" | "unlisted") {
    if (busy) return;
    setBusy(true);
    setMessage("");
    const previous = pending.current;
    const attempt: Attempt =
      previous &&
      previous.action === action &&
      previous.visibility === visibility &&
      (action === "revoke" ||
        action === "visibility" ||
        previous.title === title.trim())
        ? previous
        : { action, title: title.trim(), key: crypto.randomUUID(), visibility };
    pending.current = attempt;
    try {
      if (action === "visibility")
        await setPublicationVisibility(deckId, {
          visibility: visibility!,
          idempotency_key: attempt.key,
        });
      else if (action === "revoke")
        await revokeDeck(deckId, { idempotency_key: attempt.key });
      else
        await (action === "publish" ? publishDeck : republishDeck)(deckId, {
          title: attempt.title,
          idempotency_key: attempt.key,
        });
      pending.current = null;
      await onReload();
      setMessage(MESSAGES[action]);
      if (action === "revoke") {
        setTitle("");
        titleField.current?.focus();
      }
    } catch (cause) {
      if (cause instanceof PublicationError && cause.status < 500) {
        pending.current = null;
        if (cause.status === 422)
          setMessage(
            "Use a plain-text public title of at most 120 characters, without markup or links."
          );
        else if (cause.code === "TARGET_FORMAT_NOT_LEGAL") {
          setMessage(
            "Nothing was published: this Deck List isn't legal in its Target Format any more. The result above the Deck List says why."
          );
          onNotLegal();
        } else {
          await onReload();
          setMessage(
            "This publication changed somewhere else. It's up to date now: check it and try again."
          );
        }
      } else
        setMessage(
          "The publication hasn't been confirmed. Press the same button again to finish it safely."
        );
    } finally {
      setBusy(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    void act(status?.token ? "republish" : "publish");
  }

  const reasonId = `${idBase}-reason`;
  const canSend = !blocked && title.trim() !== "";
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={status?.token ? "Published Deck" : "Publish"}
      closeLabel="Close Publish"
      returnFocus={returnFocus}
      bodyClassName="flex flex-col gap-3"
    >
      <p className="m-0 text-meta text-text-muted">
        A Published Deck is a snapshot of this Deck List, including cards you
        don't own. It never shows what you own, where your cards are, or this
        Deck's own name. Edits here reach it only when you republish.
      </p>
      {publication.kind === "loading" ? (
        <p role="status" className="m-0 text-body text-text-muted">
          Checking whether this Deck is published…
        </p>
      ) : publication.kind === "failed" ? (
        <>
          <p role="status" className="m-0 text-body text-text-muted">
            The publication couldn't be loaded. Check your connection and try
            again.
          </p>
          <Button className="self-start" onClick={() => void onReload()}>
            Retry
          </Button>
        </>
      ) : (
        <>
          {status?.token && (
            <div className="flex flex-col gap-1">
              <p className="m-0 text-body wrap-anywhere">
                <strong className="font-semibold">{status.title}</strong> ·{" "}
                {visibilityText(status.visibility)} · version {status.version}
              </p>
              <a
                href={`/published/${status.token}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex min-h-control items-center self-start text-control text-accent-strong underline phone:min-h-tap"
              >
                View public snapshot
              </a>
            </div>
          )}
          <form onSubmit={submit} className="flex flex-col gap-2">
            <TextField
              ref={titleField}
              label="Public title"
              required
              maxLength={120}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              aria-describedby={blocked ? reasonId : undefined}
            />
            {blocked && (
              <p id={reasonId} className="m-0 text-meta text-warning">
                {blocked}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                type="submit"
                variant="primary"
                disabled={!canSend}
                aria-disabled={busy || undefined}
                aria-describedby={blocked ? reasonId : undefined}
              >
                {status?.token
                  ? "Republish snapshot"
                  : "Publish Unlisted snapshot"}
              </Button>
            </div>
          </form>
          {status?.token && (
            <div className="flex flex-col gap-2 border-t border-border pt-3">
              <p className="m-0 text-meta text-text-muted">
                {status.visibility === "listed"
                  ? "Listed: Discover shows it while it is legal in its Target Format."
                  : "Unlisted: only people with the link can open it."}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  aria-disabled={busy || undefined}
                  onClick={() =>
                    void act(
                      "visibility",
                      status.visibility === "listed" ? "unlisted" : "listed"
                    )
                  }
                >
                  {status.visibility === "listed"
                    ? "Make Unlisted"
                    : "List in Discover"}
                </Button>
                <RevokeControl
                  title={status.title ?? "this Published Deck"}
                  busy={busy}
                  onRevoke={() => void act("revoke")}
                />
              </div>
            </div>
          )}
          {status?.projection_pending && (
            <p role="status" className="m-0 text-meta text-warning">
              The public copy is catching up. Press the last button again to
              finish it.
            </p>
          )}
        </>
      )}
      <p role="status" className="m-0 text-body text-text-muted">
        {message}
      </p>
    </Dialog>
  );
}
