import { useEffect, useId, useRef, useState } from "react";
import {
  BLOCKED_EMPTY,
  BLOCKED_FAILED,
  BLOCKED_HEADING,
  BLOCKED_LOADING,
  BLOCKED_NOTE,
  UNBLOCK,
  unblockLabel,
  unblockedStatus,
} from "../social/blockMessages";
import { commandMessage } from "../social/socialMessages";
import {
  getBlocked,
  SocialError,
  unblockById,
  type BlockedCollector,
} from "../social_generated";
import { Button } from "../ui/Button";

type Load =
  | { kind: "loading" }
  | { kind: "ready"; blocked: BlockedCollector[] }
  | { kind: "failed" };

/**
 * Settings › Privacy's Blocked collectors (social network #248, Trading #302): everyone the collector blocked, by
 * name, each with Unblock. Rows are keyed by `block_id`; a Handle shows only when the collector already knew it, and
 * either kind of Block is lifted here. Unblocking lets them find the collector and send a Friend Request again; it
 * doesn't make them Friends. Rendered inside the Privacy section (#246), under its own heading.
 */
export function BlockedSection() {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [problem, setProblem] = useState("");
  const headingId = `${useId()}-heading`;
  const heading = useRef<HTMLHeadingElement>(null);
  const list = useRef<HTMLUListElement>(null);
  // Where focus goes once the list is read again: the next row's Unblock, or the heading.
  const [focusNext, setFocusNext] = useState<{ id: string | null } | null>(
    null
  );
  useEffect(() => {
    if (!focusNext || busy) return;
    const target = Array.from(
      list.current?.querySelectorAll<HTMLElement>("li[data-block]") ?? []
    )
      .find((row) => row.dataset.block === focusNext.id)
      ?.querySelector<HTMLElement>("button");
    (target ?? heading.current)?.focus();
    setFocusNext(null);
  }, [focusNext, busy, load]);

  function read() {
    return getBlocked()
      .then(({ blocked }) => setLoad({ kind: "ready", blocked }))
      .catch(() =>
        setLoad((current) =>
          current.kind === "ready" ? current : { kind: "failed" }
        )
      );
  }
  useEffect(() => {
    void read();
  }, []);

  async function unblock(person: BlockedCollector) {
    if (busy) return;
    setBusy(true);
    setStatus("");
    setProblem("");
    const gone = () => {
      setStatus(unblockedStatus(person.display_name));
      const rows = load.kind === "ready" ? load.blocked : [];
      const at = rows.findIndex((row) => row.block_id === person.block_id);
      setFocusNext({ id: rows[at + 1]?.block_id ?? null });
    };
    try {
      await unblockById(person.block_id, {
        idempotency_key: crypto.randomUUID(),
      });
      gone();
    } catch (cause) {
      // Already lifted (another tab, or the account is gone): the Block is not there, which is what was asked.
      if (cause instanceof SocialError && cause.code === "BLOCK_NOT_FOUND")
        gone();
      else {
        setProblem(commandMessage(cause));
        setFocusNext({ id: person.block_id }); // the row stays: focus returns to its Unblock
      }
    } finally {
      await read();
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <h3
        id={headingId}
        ref={heading}
        tabIndex={-1}
        className="m-0 text-body font-semibold outline-none"
      >
        {BLOCKED_HEADING}
      </h3>
      {load.kind === "loading" && (
        <p className="m-0 text-meta text-text-muted">{BLOCKED_LOADING}</p>
      )}
      {load.kind === "failed" && (
        <div className="flex flex-wrap items-center gap-3">
          <p role="alert" className="m-0 text-meta text-danger">
            {BLOCKED_FAILED}
          </p>
          <Button
            onClick={() => {
              setLoad({ kind: "loading" });
              void read();
            }}
          >
            Retry
          </Button>
        </div>
      )}
      {load.kind === "ready" && load.blocked.length === 0 && (
        <p className="m-0 text-meta text-text-muted">{BLOCKED_EMPTY}</p>
      )}
      {load.kind === "ready" && load.blocked.length > 0 && (
        <>
          <p className="m-0 text-meta text-text-muted">{BLOCKED_NOTE}</p>
          <ul
            ref={list}
            aria-labelledby={headingId}
            className="m-0 flex list-none flex-col gap-1 p-0"
          >
            {load.blocked.map((person) => (
              <li
                key={person.block_id}
                data-block={person.block_id}
                className="flex min-h-tap items-center gap-2"
              >
                <span className="min-w-0 flex-1">
                  <span className="font-semibold text-text">
                    {person.display_name}
                  </span>
                  {person.handle !== null && (
                    <>
                      {" "}
                      <span className="text-meta text-text-muted">
                        @{person.handle}
                      </span>
                    </>
                  )}
                </span>
                <Button
                  disabled={busy}
                  aria-label={unblockLabel(person.display_name)}
                  onClick={() => void unblock(person)}
                >
                  {UNBLOCK}
                </Button>
              </li>
            ))}
          </ul>
        </>
      )}
      {problem && (
        <p role="alert" className="m-0 text-meta text-danger">
          {problem}
        </p>
      )}
      <p role="status" className="m-0 text-meta text-text-muted">
        {status}
      </p>
    </section>
  );
}
