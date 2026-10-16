import { useEffect, useRef, useState } from "react";
import {
  getEditionReplacements,
  reassignHolding,
  type ReplacementView,
} from "./reconciliation_generated";
import { HoldingError, type HoldingView } from "./holdings_generated";
export function Correction({
  holding,
  correction,
  onChanged,
  headingLevel = 4,
}: {
  holding: HoldingView;
  correction: ReplacementView;
  onChanged: () => Promise<void>;
  headingLevel?: 3 | 4;
}) {
  const Heading = headingLevel === 3 ? "h3" : "h4";
  const [amount, setAmount] = useState("1");
  const [confirm, setConfirm] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef<string | null>(null);
  async function apply() {
    setBusy(true);
    const key = pending.current ?? crypto.randomUUID();
    pending.current = key;
    try {
      await reassignHolding({
        location_id: holding.location_id,
        edition_id: holding.edition_id,
        replacement_edition_id: correction.replacement_edition_id,
        quantity: amount,
        expected_version: holding.version,
        idempotency_key: key,
      });
      pending.current = null;
      setConfirm(false);
      await onChanged();
    } catch (cause) {
      if (cause instanceof HoldingError && cause.status < 500)
        pending.current = null;
      setMessage(
        cause instanceof HoldingError && cause.code === "PROMISED_TO_LOAN"
          ? "You promised some of these copies to a Loan. Reassign fewer copies, or cancel the Loan first."
          : cause instanceof HoldingError && cause.code === "EDITION_ON_LOAN"
            ? "This card is on a Loan that's still open. Reassign it once the Loan ends."
            : cause instanceof HoldingError
              ? `Reassignment failed: ${cause.code}. Refresh cards before retrying.`
              : "Reassignment may have completed. Retry safely."
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <article>
      <Heading>Reviewed Edition correction: {holding.printing_name}</Heading>
      <p>
        {correction.reason}{" "}
        <a href={correction.evidence_url} target="_blank" rel="noreferrer">
          Review evidence
        </a>
      </p>
      <p>
        Your {holding.quantity} copies still use the original Edition. Reassign
        only after checking your physical cards.
      </p>
      <label>
        Copies to reassign{" "}
        <input
          value={amount}
          onChange={(e) => {
            setAmount(e.target.value);
            pending.current = null;
            setConfirm(false);
          }}
          inputMode="numeric"
          pattern="[0-9]+"
        />
      </label>
      {confirm ? (
        <>
          <p>
            Reassign {amount} copies to the reviewed replacement in{" "}
            {holding.location_name}?
          </p>
          <button disabled={busy} onClick={() => void apply()}>
            Confirm reassignment
          </button>
          <button onClick={() => setConfirm(false)}>Cancel reassignment</button>
        </>
      ) : (
        <button onClick={() => setConfirm(true)}>Review reassignment</button>
      )}
      {message && <p role="status">{message}</p>}
    </article>
  );
}
export function EditionCorrections({
  holdings,
  onChanged,
}: {
  holdings: HoldingView[];
  onChanged: () => Promise<void>;
}) {
  const [corrections, setCorrections] = useState<ReplacementView[]>([]);
  useEffect(() => {
    void getEditionReplacements()
      .then(setCorrections)
      .catch(() => {});
  }, [holdings]);
  const relevant = corrections.filter((c) =>
    holdings.some((h) => h.edition_id === c.edition_id)
  );
  return relevant.length ? (
    <section aria-label="Reviewed Edition corrections">
      {relevant.map((c) => (
        <Correction
          key={c.edition_id}
          correction={c}
          holding={holdings.find((h) => h.edition_id === c.edition_id)!}
          onChanged={onChanged}
        />
      ))}
    </section>
  ) : null;
}
