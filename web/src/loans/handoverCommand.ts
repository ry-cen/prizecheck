import {
  SocialError,
  type LoanSide,
  type LoanStep,
  type LoanView,
} from "../social_generated";
import { canRetryHandover } from "../social/confirmationRetry";
type Transport = {
  confirm: (id: string, body: LoanStep) => Promise<LoanView>;
  read: (id: string) => Promise<LoanView>;
  readSide: (id: string) => Promise<LoanSide>;
};
/** One bounded peer-confirm retry; the cache always names the last POST made with this key. */
export async function handoverCommand(
  loan: LoanView,
  side: LoanSide,
  key: string,
  bodies: Map<string, LoanStep>,
  api: Transport,
  onFresh: (loan: LoanView, side: LoanSide) => void
) {
  let command = bodies.get(key);
  if (!command) {
    command = {
      loan_id: loan.loan_id,
      revision: loan.revision,
      idempotency_key: key,
    };
    bodies.set(key, command);
  }
  try {
    return await api.confirm(loan.thread_id, command);
  } catch (cause) {
    if (!(cause instanceof SocialError) || cause.code !== "LOAN_CHANGED")
      throw cause;
    const [fresh, freshSide] = await Promise.all([
      api.read(loan.thread_id),
      api.readSide(loan.thread_id),
    ]);
    if (!canRetryHandover(loan, fresh, side, freshSide)) throw cause;
    const retried = {
      ...command,
      loan_id: fresh.loan_id,
      revision: fresh.revision,
      idempotency_key: key,
    };
    bodies.set(key, retried);
    onFresh(fresh, freshSide);
    return await api.confirm(loan.thread_id, retried);
  }
}
