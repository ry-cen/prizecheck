import { useEffect, useId, useRef, useState } from "react";
import { commandMessage } from "../social/socialMessages";
import {
  getBlocked,
  unblockCollector,
  type Collector,
} from "../social_generated";
import { Button } from "../ui/Button";

type Load =
  | { kind: "loading" }
  | { kind: "ready"; blocked: Collector[] }
  | { kind: "failed" };

/**
 * Settings › Privacy's Blocked collectors (social network #248): everyone the collector blocked, by name, each with
 * Unblock. Unblocking lets them find the collector and send a Friend Request again; it doesn't make them Friends.
 * Rendered inside the Privacy section (#246), under its own heading.
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
      list.current?.querySelectorAll<HTMLElement>("li[data-collector]") ?? []
    )
      .find((row) => row.dataset.collector === focusNext.id)
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

  async function unblock(person: Collector) {
    if (busy) return;
    setBusy(true);
    setStatus("");
    setProblem("");
    try {
      await unblockCollector(person.collector_id, {
        idempotency_key: crypto.randomUUID(),
      });
      setStatus(`Unblocked ${person.display_name}.`);
      const rows = load.kind === "ready" ? load.blocked : [];
      const at = rows.findIndex(
        (row) => row.collector_id === person.collector_id
      );
      setFocusNext({ id: rows[at + 1]?.collector_id ?? null });
    } catch (cause) {
      setProblem(commandMessage(cause));
      setFocusNext({ id: person.collector_id }); // the row stays: focus returns to its Unblock
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
        Blocked collectors
      </h3>
      {load.kind === "loading" && (
        <p className="m-0 text-meta text-text-muted">Loading…</p>
      )}
      {load.kind === "failed" && (
        <p role="alert" className="m-0 text-meta text-danger">
          Your Blocked collectors are temporarily unavailable. Please retry.
        </p>
      )}
      {load.kind === "ready" && load.blocked.length === 0 && (
        <p className="m-0 text-meta text-text-muted">
          You haven't blocked anyone. To block someone, choose Block in their ⋯
          menu in Friends.
        </p>
      )}
      {load.kind === "ready" && load.blocked.length > 0 && (
        <>
          <p className="m-0 text-meta text-text-muted">
            They can't find you by your Handle, use your Invite Link or send you
            Friend Requests.
          </p>
          <ul
            ref={list}
            aria-labelledby={headingId}
            className="m-0 flex list-none flex-col gap-1 p-0"
          >
            {load.blocked.map((person) => (
              <li
                key={person.collector_id}
                data-collector={person.collector_id}
                className="flex min-h-tap items-center gap-2"
              >
                <span className="min-w-0 flex-1">
                  <span className="font-semibold text-text">
                    {person.display_name}
                  </span>{" "}
                  <span className="text-meta text-text-muted">
                    @{person.handle}
                  </span>
                </span>
                <Button
                  disabled={busy}
                  aria-label={`Unblock ${person.display_name}`}
                  onClick={() => void unblock(person)}
                >
                  Unblock
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
