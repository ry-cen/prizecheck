/** A known version refusal is safe to reread; an unknown outcome keeps its body/key. */
export function threadVersionChanged(code: string): boolean {
  return (
    code === "OFFER_CHANGED" ||
    code === "TRADE_CHANGED" ||
    code === "LOAN_CHANGED"
  );
}

/** A Loan terms editor stays bound to the round/version it opened for. */
export function sameLoanTermsVersion(
  opened: { loan_id: string; revision: number },
  current: {
    loan_id: string;
    revision: number;
    state: string;
    actions: readonly string[];
  }
) {
  return (
    current.loan_id === opened.loan_id &&
    current.revision === opened.revision &&
    current.state === "requested" &&
    current.actions.includes("edit_and_resend")
  );
}
