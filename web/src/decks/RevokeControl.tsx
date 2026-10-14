import { useEffect, useRef, useState } from "react";
import { Button } from "../ui/Button";

type Props = {
  /** The Published Deck's public title, for the buttons' accessible names. */
  title: string;
  /** A command is running for this publication: both steps wait. */
  busy: boolean;
  onRevoke: () => void;
};

/**
 * Revoke in two steps (#181): Revoke shows what it does, then "Revoke for good" revokes and "Keep it" goes back.
 * Revoking burns the public link permanently, so one press never does it. The second step takes focus, and going back
 * returns focus to Revoke.
 */
export function RevokeControl({ title, busy, onRevoke }: Props) {
  const [confirming, setConfirming] = useState(false);
  const confirm = useRef<HTMLButtonElement>(null);
  const start = useRef<HTMLButtonElement>(null);
  const backed = useRef(false);
  useEffect(() => {
    if (confirming) confirm.current?.focus();
    else if (backed.current) start.current?.focus();
    backed.current = false;
  }, [confirming]);

  if (!confirming)
    return (
      <Button
        ref={start}
        variant="danger"
        aria-label={`Revoke: ${title}`}
        aria-disabled={busy || undefined}
        onClick={() => {
          if (!busy) setConfirming(true);
        }}
      >
        Revoke
      </Button>
    );
  return (
    <div
      role="group"
      aria-label={`Revoke ${title}`}
      className="flex basis-full flex-wrap items-center gap-2"
    >
      <p className="m-0 basis-full text-meta text-text-muted">
        Revoking stops the public link working for good. Copies people already
        saved can't be recalled.
      </p>
      <Button
        ref={confirm}
        variant="danger"
        aria-disabled={busy || undefined}
        onClick={() => {
          if (busy) return;
          setConfirming(false);
          onRevoke();
        }}
      >
        Revoke for good
      </Button>
      <Button
        variant="quiet"
        onClick={() => {
          backed.current = true;
          setConfirming(false);
        }}
      >
        Keep it
      </Button>
    </div>
  );
}
