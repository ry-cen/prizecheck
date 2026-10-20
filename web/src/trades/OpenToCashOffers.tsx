import { useEffect, useId, useState } from "react";
import { getTradeSettings, setTradeSettings } from "../social_generated";
import { Button } from "../ui/Button";
import { useToast } from "../ui/Toast";

type Load =
  { kind: "loading" } | { kind: "failed" } | { kind: "ready"; saved: boolean };

/**
 * The Open to cash offers setting (Trading #277; prototype verdict variant A puts it at the top of My Trade List).
 * While it is on, Friends can send the collector a Trade Proposal in which one side gives only cash; cash alongside
 * cards is always fine. It is off by default and saves at once, by value, so a change needs no Save. It loads, saves
 * and fails on its own, apart from the Trade List's read.
 */
export function OpenToCashOffers() {
  const toast = useToast();
  const helpId = useId();
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [pending, setPending] = useState<boolean | null>(null);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    getTradeSettings(controller.signal).then(
      (settings) => {
        if (!controller.signal.aborted)
          setLoad({ kind: "ready", saved: settings.open_to_cash_offers });
      },
      () => {
        if (!controller.signal.aborted) setLoad({ kind: "failed" });
      }
    );
    return () => controller.abort();
  }, [attempt]);

  async function change(next: boolean) {
    if (load.kind !== "ready" || pending !== null) return;
    setPending(next);
    setNotice("");
    try {
      const settings = await setTradeSettings({ open_to_cash_offers: next });
      setLoad({ kind: "ready", saved: settings.open_to_cash_offers });
      toast.show({
        message: settings.open_to_cash_offers
          ? "Friends can now send you Trade Proposals where one side gives only cash."
          : "Friends can't send you cash-only Trade Proposals now.",
      });
    } catch {
      setNotice(
        "The setting couldn't be saved. Check your connection and try again."
      );
    } finally {
      setPending(null);
    }
  }

  if (load.kind === "loading") return null;
  if (load.kind === "failed")
    return (
      <div className="flex flex-wrap items-center gap-3">
        <p role="alert" className="m-0 text-body text-danger">
          Open to cash offers couldn't be loaded.
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
    );

  return (
    <>
      <div className="flex flex-col gap-1 rounded-panel border border-border bg-surface px-4 py-3">
        <label className="flex min-h-control cursor-pointer items-center gap-2 text-body font-medium text-text phone:min-h-tap">
          <input
            type="checkbox"
            className="m-0 size-4 shrink-0 accent-accent"
            aria-describedby={helpId}
            aria-busy={pending !== null || undefined}
            checked={pending ?? load.saved}
            onChange={(event) => void change(event.currentTarget.checked)}
          />
          Open to cash offers
        </label>
        <p id={helpId} className="m-0 pl-6 text-meta text-text-muted">
          Let Friends send you Trade Proposals where one side gives only cash.
        </p>
      </div>
      {notice && (
        <p role="alert" className="m-0 text-meta text-danger">
          {notice}
        </p>
      )}
    </>
  );
}
