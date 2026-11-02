import { useEffect, useState } from "react";
import { Button } from "../ui/Button";

/** Recovery stays available when the refreshed selection and its Actions bar disappear. */
export function PendingMoveNotice({
  text,
  blocked,
  busy,
  otherTab,
  onRefresh,
  onCheck,
  onDismiss,
}: {
  text: string;
  blocked: boolean;
  busy: boolean;
  otherTab: boolean;
  onRefresh: () => void;
  onCheck: () => void;
  onDismiss: (reviewed: boolean) => void;
}) {
  const [reviewed, setReviewed] = useState(false);
  useEffect(() => setReviewed(false), [text, blocked, otherTab]);
  return (
    <section
      aria-label="Pending Move"
      className="flex flex-col gap-2 border-t border-border bg-surface p-3"
    >
      <p role="status" className="m-0 text-meta text-text">
        {text}
      </p>
      {otherTab ? (
        <>
          <Button disabled={busy} onClick={onRefresh}>
            Check availability
          </Button>
        </>
      ) : blocked ? (
        <>
          <label className="flex min-h-8 items-center gap-2 text-meta text-text phone:min-h-tap">
            <input
              type="checkbox"
              checked={reviewed}
              onChange={(event) => setReviewed(event.target.checked)}
            />
            I checked the source and destination Locations.
          </label>
          <Button
            disabled={busy || !reviewed}
            onClick={() => onDismiss(reviewed)}
          >
            Dismiss after review
          </Button>
        </>
      ) : (
        <Button disabled={busy} onClick={onCheck}>
          Check Move
        </Button>
      )}
    </section>
  );
}
