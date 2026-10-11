import { useEffect, useState } from "react";
import { CostSection, type CostSettled } from "./DeckCost";
import { getPublishedDeckCost, PriceError } from "./prices_generated";

// The Published Deck's Estimated Deck Cost: one anonymous access over every frozen copy of the snapshot version shown on
// this page. The server derives every row and quantity from the token and version. An answer for another version is
// never shown; a 409 (republished or rewritten) or 404 (revoked) answer asks the page to read its snapshot again, and the
// new version is then priced on its own.
const CLIENT_TIMEOUT_MS = 3_500;

export function PublishedDeckCost({
  token,
  version,
  totalCopies,
  onChanged,
}: {
  token: string;
  version: number;
  totalCopies: string;
  onChanged: () => void;
}) {
  const [settled, setSettled] = useState<CostSettled>(null);
  useEffect(() => {
    setSettled(null);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CLIENT_TIMEOUT_MS);
    let live = true;
    getPublishedDeckCost(token, version, controller.signal)
      .then((cost) => {
        if (!live) return;
        setSettled(
          cost.version === version
            ? { kind: "cost", cost }
            : { kind: "unavailable" }
        );
      })
      .catch((error) => {
        if (!live) return;
        setSettled({ kind: "unavailable" });
        if (
          error instanceof PriceError &&
          (error.status === 409 || error.status === 404)
        )
          onChanged();
      })
      .finally(() => clearTimeout(timer));
    return () => {
      live = false;
      clearTimeout(timer);
      controller.abort();
    };
    // onChanged is a fresh closure on every render; only the token and the version start a new access.
  }, [token, version]);
  return <CostSection settled={settled} totalCopies={totalCopies} />;
}
