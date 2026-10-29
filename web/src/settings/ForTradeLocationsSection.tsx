import { useEffect, useId, useState } from "react";
import { getLocationTree, type TreeLocation } from "../location_generated";
import { indexLocations } from "../workspace/locationTree";
import {
  FOR_TRADE_BEYOND_FRIENDS,
  FOR_TRADE_CHANGE_HINT,
} from "../trades/nearYouMessages";
import { useDiscoveryVisibility } from "./useVisibleBeyondFriends";
import { useSettingsSectionSettled } from "./settingsNavigation";

type Load =
  { kind: "loading" } | { kind: "ready"; paths: string[] } | { kind: "failed" };

/**
 * Settings › Privacy's summary of For trade Locations (Trading #283): the Locations the collector marked, by full
 * path, topmost marks only. Everything inside each one, apart from Decks, is offered too. Marking happens in each
 * Location's settings in Collection (#292); this only lists them. Rendered inside the Privacy section beside Hidden Locations.
 */
export function ForTradeLocationsSection() {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  // The wording below also depends on the discovery read, so the section is settled once both have answered.
  const { beyond, settled: discoverySettled } = useDiscoveryVisibility();
  useSettingsSectionSettled(
    "for-trade-locations",
    load.kind !== "loading" && discoverySettled
  );
  const headingId = `${useId()}-heading`;
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
  }, []);
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <h3 id={headingId} className="m-0 text-body font-semibold">
        For trade
      </h3>
      {load.kind === "loading" && (
        <p className="m-0 text-meta text-text-muted">Loading…</p>
      )}
      {load.kind === "failed" && (
        <p role="alert" className="m-0 text-meta text-danger">
          Your For trade Locations are temporarily unavailable. Please retry.
        </p>
      )}
      {load.kind === "ready" && load.paths.length === 0 && (
        <p className="m-0 text-meta text-text-muted">
          Nothing is offered for trade. To offer a Location's cards, open its
          settings from the gear beside it in Collection and choose For trade.
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
