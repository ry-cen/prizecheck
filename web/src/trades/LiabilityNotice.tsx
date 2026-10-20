/**
 * The liability notice (spec "Liability"; owner verdict 2026-10-19: shown only where a proposal or Trade includes
 * cash). It is legally required, so it is the one exemption from the UI copy rule. PLACEHOLDER WORDING, NOT FINAL:
 * someone qualified must check it before launch (map.md "Decide the liability notice's wording"). Don't show a
 * placeholder tag to collectors.
 */
export function LiabilityNotice() {
  return (
    <p
      role="note"
      className="m-0 rounded-panel border border-dashed border-border-strong px-4 py-3 text-meta text-text-muted"
    >
      PrizeCheck only records the cash amount you agree on. It doesn't take,
      hold or check any money, and isn't responsible for money that changes
      hands.
    </p>
  );
}
