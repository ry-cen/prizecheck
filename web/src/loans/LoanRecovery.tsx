import { useLoanCommand } from "./PendingLoanRequest";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  browserPorts,
  createLoanIntentStore,
  type IntentView,
  type LoanIntentStore,
  type LoanPorts,
  type TabContext,
  type AttemptDraft,
  type FlowOutcome,
} from "./loanIntents";
type Recovery = {
  accountId: string;
  accountName: string | null;
  store: LoanIntentStore;
  intents: IntentView[];
  blockerFor(scope: string): IntentView | undefined;
};
const Context = createContext<Recovery | null>(null);
export function LoanRecoveryProvider({
  accountId,
  accountName,
  children,
  ports,
  tab,
}: {
  accountId: string;
  accountName: string | null;
  children: ReactNode;
  ports?: LoanPorts;
  tab?: TabContext;
}) {
  const store = useMemo(
    () => createLoanIntentStore(accountId, ports ?? browserPorts(), tab),
    [accountId, ports, tab]
  );
  const [intents, setIntents] = useState(() => store.list());
  useEffect(() => {
    const update = () => setIntents(store.list());
    update();
    const off = store.subscribe(update);
    return () => {
      off();
      store.dispose();
    };
  }, [store]);
  return (
    <Context.Provider
      value={{
        accountId,
        accountName,
        store,
        intents,
        blockerFor: (scope) =>
          intents.find((v) => v.scope === scope || v.scope === "*"),
      }}
    >
      {children}
    </Context.Provider>
  );
}
export function useLoanRecovery(): Recovery {
  const value = useContext(Context);
  if (!value) throw new Error("LoanRecoveryProvider missing");
  return value;
}
type Token = { store: LoanIntentStore; accountId: string; generation: number };
export function useFlowGuard() {
  const { store, accountId } = useLoanRecovery();
  const current = useRef({ store, accountId, generation: 0, mounted: true });
  if (
    current.current.store !== store ||
    current.current.accountId !== accountId
  )
    current.current = {
      store,
      accountId,
      generation: current.current.generation + 1,
      mounted: true,
    };
  useEffect(() => {
    current.current.mounted = true;
    return () => {
      current.current.mounted = false;
      current.current.generation++;
    };
  }, [store, accountId]);
  return {
    capture(): Token {
      return { store, accountId, generation: current.current.generation };
    },
    live(token: Token) {
      const c = current.current;
      return (
        c.mounted &&
        c.store === token.store &&
        c.accountId === token.accountId &&
        c.generation === token.generation
      );
    },
    bump() {
      current.current.generation++;
    },
  };
}

/** The in-session fence covers the running flow. Once it answers, the durable
 * store owns the unresolved intent and permits leaving without freeing scope. */
export function useDurableSend() {
  const { store } = useLoanRecovery();
  const guard = useFlowGuard();
  const fence = useLoanCommand<{ kind: AttemptDraft["kind"] }>();
  return {
    fence,
    async send(draft: AttemptDraft): Promise<FlowOutcome | null> {
      if (!fence.beginAttempt()) return null;
      const token = guard.capture();
      const binding = store.bind();
      if (!binding) {
        fence.endAttempt();
        return { kind: "not_saved" };
      }
      fence.retain({ kind: draft.kind });
      let outcome: FlowOutcome;
      try {
        outcome = await store.send(binding, draft);
      } finally {
        fence.settle();
        fence.endAttempt();
      }
      return guard.live(token) ? outcome : null;
    },
  };
}
