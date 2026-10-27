import { useEffect, useId, useState } from "react";
import { Button } from "../ui/Button";
import { getLocationTree, type TreeLocation } from "../location_generated";
import { indexLocations } from "../workspace/locationTree";
import {
  FOR_TRADE_BEYOND_FRIENDS,
  FOR_TRADE_CHANGE_HINT,
} from "../trades/nearYouMessages";
import { useVisibleBeyondFriends } from "./useVisibleBeyondFriends";

type Load =
  { kind: "loading" } | { kind: "ready"; paths: string[] } | { kind: "failed" };

/**
 * Settings › Privacy's summary of For trade Locations (Trading #283): the Locations the collector marked, by full
 * path, topmost marks only. Everything inside each one, apart from Decks, is offered too. Marking happens in each
 * Location's settings in Collection (#292); this only lists them. Rendered inside the Privacy section beside Hidden Locations.
 */
export function ForTradeLocationsSection() {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const headingId = `${useId()}-heading`;
  const beyond = useVisibleBeyondFriends();
  useEffect(() => {
    let live = true;
    getLocationTree()
      .then(({ locations }) => {
        if (!live) return;
        const index = indexLocations(locations);
        const paths = locations
          .filter(
            (node: TreeLocation) =>
              node.for_trade === true && !node.for_trade_by
          )
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
        For trade
      </h3>
      {load.kind === "loading" && (
        <p className="m-0 text-meta text-text-muted">Loading…</p>
      )}
      {load.kind === "failed" && (
        <div className="flex flex-wrap items-center gap-3">
          <p role="alert" className="m-0 text-meta text-danger">
            Your For trade Locations couldn't be loaded.
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
          Nothing is offered for trade. To offer a Location's cards, use its
          gear in Collection.
        </p>
      )}
      {load.kind === "ready" && load.paths.length > 0 && (
        <>
          <p className="m-0 text-meta text-text-muted">
            {beyond
              ? `${FOR_TRADE_BEYOND_FRIENDS} ${FOR_TRADE_CHANGE_HINT}`
              : "Friends can trade for the cards in these Locations and everything inside them, apart from Decks. Change this in each Location's settings in Collection."}
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
