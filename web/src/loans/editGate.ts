import { SocialError, type LoanView } from "../social_generated";
import { sameLoanTermsVersion } from "../threads/commandChanges";
import { object } from "./loanAttempt";
import type { Binding } from "./loanIntents";

export type EditGate = "checking" | "ok" | "changed" | "error";
export type GateToken = { binding: Binding; opened: LoanView };
export type GateNow =
  | { live: false }
  | {
      live: true;
      active: boolean;
      aborted: boolean;
      binding: Binding | null;
    };
export type EditRead = { loan: unknown } | { error: unknown };
export function classifyTermsRead(
  r: EditRead,
  opened: LoanView
): EditGate | "aborted" {
  try {
    if ("error" in r) {
      if (object(r.error) && r.error.name === "AbortError") return "aborted";
      return r.error instanceof SocialError && r.error.status === 404
        ? "changed"
        : "error";
    }
    const loan = r.loan;
    if (
      !object(loan) ||
      !object(loan.other) ||
      typeof loan.revision !== "number" ||
      !Array.isArray(loan.actions)
    )
      return "error";
    const version = {
      loan_id: typeof loan.loan_id === "string" ? loan.loan_id : "",
      revision: loan.revision,
      state: typeof loan.state === "string" ? loan.state : "",
      actions: loan.actions.filter(
        (action): action is string => typeof action === "string"
      ),
    };
    return sameLoanTermsVersion(opened, version) &&
      loan.role === opened.role &&
      loan.other.collector_id === opened.other.collector_id
      ? "ok"
      : "changed";
  } catch {
    return "error";
  }
}
export function decideEdit(
  captured: GateToken,
  now: GateNow,
  r: EditRead
): EditGate | "ignore" {
  if (!now.live || !now.active) return "ignore";
  const read = classifyTermsRead(r, captured.opened);
  if (now.aborted || read === "aborted") return "error";
  const binding = now.binding;
  if (
    !binding ||
    binding.accountId !== captured.binding.accountId ||
    binding.generation !== captured.binding.generation ||
    binding.boundEpoch !== captured.binding.boundEpoch
  )
    return "error";
  return read;
}
type Dependencies = {
  read: (id: string, signal: AbortSignal) => Promise<unknown>;
  captured: GateToken;
  signal: AbortSignal;
  now: () => GateNow;
  apply: (gate: EditGate) => void;
};
export async function checkEdit(
  deps: Dependencies
): Promise<EditGate | "ignore"> {
  let read: EditRead;
  try {
    read = {
      loan: await deps.read(deps.captured.opened.thread_id, deps.signal),
    };
  } catch (error) {
    read = { error };
  }
  const decision = decideEdit(deps.captured, deps.now(), read);
  if (decision !== "ignore") deps.apply(decision);
  return decision;
}
export async function sendCheckedEdit<T>(
  deps: Dependencies & { send: (binding: Binding) => Promise<T> }
): Promise<{ ignore: true } | { gate: EditGate } | { outcome: T }> {
  let read: EditRead;
  try {
    read = {
      loan: await deps.read(deps.captured.opened.thread_id, deps.signal),
    };
  } catch (error) {
    read = { error };
  }
  const decision = decideEdit(deps.captured, deps.now(), read);
  if (decision === "ignore") return { ignore: true };
  if (decision !== "ok") {
    deps.apply(decision);
    return { gate: decision };
  }
  const pending = deps.send(deps.captured.binding);
  deps.apply("ok");
  return { outcome: await pending };
}
