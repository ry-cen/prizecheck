import { useEffect, useId, useState } from "react";
import { Button } from "../ui/Button";
import { getLocationTree, type TreeLocation } from "../location_generated";
import { indexLocations } from "../workspace/locationTree";

type Load =
  { kind: "loading" } | { kind: "ready"; paths: string[] } | { kind: "failed" };

/**
 * Settings › Privacy's summary of Hidden Locations (social network #249): the Locations the collector hid from
 * Friends, by full path. Everything inside each one is hidden too. Hiding and showing happen in Collection's Manage
 * locations; this only lists them. Rendered inside the Privacy section (#246), under its own heading.
 */
export function HiddenLocationsSection() {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const headingId = `${useId()}-heading`;
  useEffect(() => {
    let live = true;
    getLocationTree()
      .then(({ locations }) => {
        if (!live) return;
        const index = indexLocations(locations);
        const paths = locations
          .filter((node: TreeLocation) => node.hidden)
          .map((node) => index.path(node.id))
          .sort((a, b) =>
            a.localeCompare(b, undefined, {
              numeric: true,
              sensitivity: "base",
            })
          );
        setLoad({ kind: "ready", paths });
      })
      .catch(() => {
        if (live) setLoad({ kind: "failed" });
      });
    return () => {
      live = false;
    };
  }, [attempt]);
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <h3 id={headingId} className="m-0 text-body font-semibold">
        Hidden from Friends
      </h3>
      {load.kind === "loading" && (
        <p className="m-0 text-meta text-text-muted">Loading…</p>
      )}
      {load.kind === "failed" && (
        <div className="flex flex-wrap items-center gap-3">
          <p role="alert" className="m-0 text-meta text-danger">
            Your Hidden Locations couldn't be loaded.
          </p>
          <Button
            onClick={() => {
              setLoad({ kind: "loading" });
              setAttempt((n) => n + 1);
            }}
          >
            Retry
          </Button>
        </div>
      )}
      {load.kind === "ready" && load.paths.length === 0 && (
        <p className="m-0 text-meta text-text-muted">
          Friends can see every Location. To hide one, use its gear in
          Collection.
        </p>
      )}
      {load.kind === "ready" && load.paths.length > 0 && (
        <>
          <p className="m-0 text-meta text-text-muted">
            Friends can't see these Locations or anything inside them. Change
            this in each Location's settings in Collection.
          </p>
          <ul
            aria-labelledby={headingId}
            className="m-0 flex list-disc flex-col gap-1 pl-5"
          >
            {load.paths.map((path) => (
              <li key={path} className="text-body">
                {path}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
