import { SocialError, type VoidCommandKey } from "../social_generated";
import {
  DURABLE_KINDS,
  PATHS,
  REPLAYABLE,
  newAttempt,
  object,
  readSession,
  sendAnswer,
  transmit,
  voidAnswer,
  type Answer,
  type Attempt,
  type DurableKind,
} from "./loanAttempt";

export const VOID_PATH = "/api/loans/command-keys/void";
export type LoanPorts = {
  storage: Storage | null;
  locks: Pick<LockManager, "request"> | null;
  fetchImpl: typeof fetch;
  now: () => number;
  uuid: () => string;
  onStorage: (
    fn: (e: { key: string | null; newValue: string | null }) => void
  ) => () => void;
};
type StoreHandle = { invalidate(): void };
export type TabContext = {
  scrubbed: Set<string>;
  stores: Map<string, Set<StoreHandle>>;
};
export type Binding = {
  accountId: string;
  boundEpoch: number;
  generation: number;
};
export type Refusal = {
  status: number;
  code: string;
  detail: Record<string, unknown>;
};
export type IntentView = {
  operationId: string;
  kind: DurableKind | null;
  scope: string;
  state: "unknown" | "confirming" | "fencing";
  waitingAccount: boolean;
  replayable: boolean;
};
export type FlowOutcome =
  | { kind: "done"; response: unknown }
  | { kind: "voided"; refusal: Refusal | null; otherAccount: boolean }
  | { kind: "pending"; view: IntentView; refusal: Refusal | null }
  | {
      kind:
        | "wrong_account"
        | "not_sent"
        | "busy"
        | "not_saved"
        | "no_locks"
        | "settled_elsewhere"
        | "stale";
    };
export type AttemptDraft = {
  kind: DurableKind;
  scope: string;
  path: string;
  fields: Record<string, unknown>;
};
type Stub = {
  v: 2;
  accountId: string;
  operationId: string;
  kind: DurableKind | null;
  scope: string;
  key: string;
  createdAt: number;
  state: "saved" | "sending" | IntentView["state"];
  contract: string;
};
type Body = { operationId: string; epoch: number; path: string; body: string };
export interface LoanIntentStore {
  bind(): Binding | null;
  list(): IntentView[];
  blockerFor(scope: string): IntentView | undefined;
  send(binding: Binding, draft: AttemptDraft): Promise<FlowOutcome>;
  replay(binding: Binding, operationId: string): Promise<FlowOutcome>;
  cancel(binding: Binding, operationId: string): Promise<FlowOutcome>;
  check(binding: Binding, operationId: string): Promise<FlowOutcome>;
  subscribe(fn: () => void): () => void;
  dispose(): void;
}
export const createTabContext = (): TabContext => ({
  scrubbed: new Set(),
  stores: new Map(),
});
export const defaultTab = createTabContext();
export function browserPorts(): LoanPorts {
  let storage: Storage | null = null;
  try {
    storage = window.localStorage;
  } catch {
    /* Storage can be unavailable. */
  }
  return {
    storage,
    locks: navigator.locks ?? null,
    fetchImpl: (...args) => window.fetch(...args),
    now: Date.now,
    uuid: () => crypto.randomUUID(),
    onStorage: (fn) => {
      window.addEventListener("storage", fn);
      return () => window.removeEventListener("storage", fn);
    },
  };
}
export const refusalError = (r: Refusal): SocialError =>
  new SocialError(r.status, r.code, r.detail);
export const accountToScrub = (
  previous: string | null,
  next: string | null
): string | null => (previous !== null && previous !== next ? previous : null);
const prefix = (type: "intent" | "body" | "epoch", acc: string) =>
  `prizecheck:loan-${type}:v2:${encodeURIComponent(acc)}${type === "epoch" ? "" : ":"}`;
function epoch(storage: Storage | null, acc: string): number | null {
  try {
    if (!storage) return null;
    const value = storage.getItem(prefix("epoch", acc));
    if (value === null) return 0;
    if (!/^\d+$/.test(value)) return null;
    const n = Number(value);
    return Number.isSafeInteger(n) ? n : null;
  } catch {
    return null;
  }
}
function keys(storage: Storage | null, start: string): string[] {
  const found: string[] = [];
  if (storage)
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key?.startsWith(start)) found.push(key);
    }
  return found;
}
const parse = (value: string | null): unknown => {
  try {
    return value === null ? null : JSON.parse(value);
  } catch {
    return null;
  }
};
const uuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export function scrubLoanBodies(
  accountId: string | null,
  ports = browserPorts(),
  tab = defaultTab
): void {
  if (accountId === null) return;
  try {
    const e = epoch(ports.storage, accountId);
    if (e !== null)
      ports.storage?.setItem(prefix("epoch", accountId), String(e + 1));
  } catch {
    /* Independent best-effort invalidation. */
  }
  try {
    for (const key of keys(ports.storage, prefix("body", accountId)))
      ports.storage?.removeItem(key);
  } catch {
    /* Deletion must run even if invalidation failed. */
  }
  tab.scrubbed.add(accountId);
  for (const store of tab.stores.get(accountId) ?? []) store.invalidate();
}
export function createLoanIntentStore(
  accountId: string,
  ports: LoanPorts,
  tab = defaultTab
): LoanIntentStore {
  const storage = ports.storage;
  const stubPrefix = prefix("intent", accountId),
    bodyPrefix = prefix("body", accountId);
  let generation = 0;
  const controllers = new Set<AbortController>(),
    listeners = new Set<() => void>();
  const overlays = new Map<string, "replay" | "void">();
  const refusals = new Map<string, Refusal>();
  const notify = () => {
    for (const fn of listeners) fn();
  };
  const handle: StoreHandle = {
    invalidate() {
      generation++;
      for (const c of controllers) c.abort();
      overlays.clear();
      refusals.clear();
      notify();
    },
  };
  if (!tab.stores.has(accountId)) tab.stores.set(accountId, new Set());
  tab.stores.get(accountId)!.add(handle);
  if (tab.scrubbed.has(accountId)) {
    try {
      const e = epoch(storage, accountId);
      if (e !== null && storage) {
        storage.setItem(prefix("epoch", accountId), String(e + 1));
        if (epoch(storage, accountId) === e + 1) tab.scrubbed.delete(accountId);
      }
    } catch {
      /* Keep the mark until confirmed re-invalidation. */
    }
  }
  const dropBody = (id: string) => {
    try {
      storage?.removeItem(bodyPrefix + id);
    } catch {
      /* Best effort. */
    }
  };
  function sweep() {
    try {
      const e = epoch(storage, accountId);
      if (e === null) return;
      for (const key of keys(storage, bodyPrefix)) {
        const b = parse(storage!.getItem(key));
        if (!object(b) || b.epoch !== e) storage!.removeItem(key);
      }
    } catch {
      /* Readers still validate every body. */
    }
  }
  function stub(id: string): Stub | null {
    try {
      const s = parse(storage?.getItem(stubPrefix + id) ?? null);
      if (!object(s) || s.accountId !== accountId || !uuid(s.key)) return null;
      const valid =
        s.v === 2 &&
        s.operationId === id &&
        typeof s.kind === "string" &&
        DURABLE_KINDS.includes(s.kind as DurableKind) &&
        typeof s.scope === "string" &&
        typeof s.createdAt === "number" &&
        Number.isFinite(s.createdAt) &&
        typeof s.contract === "string" &&
        ["saved", "sending", "unknown", "confirming", "fencing"].includes(
          String(s.state)
        );
      return valid
        ? (s as Stub)
        : {
            v: 2,
            accountId,
            operationId: id,
            kind: null,
            scope: "*",
            key: s.key,
            createdAt: 0,
            state: "unknown",
            contract: "",
          };
    } catch {
      return null;
    }
  }
  function body(s: Stub, boundEpoch = epoch(storage, accountId)): Body | null {
    try {
      const b = parse(storage?.getItem(bodyPrefix + s.operationId) ?? null);
      const json =
        object(b) && typeof b.body === "string" ? parse(b.body) : null;
      if (
        s.kind &&
        REPLAYABLE[s.kind].includes(s.contract) &&
        object(b) &&
        b.operationId === s.operationId &&
        typeof b.epoch === "number" &&
        b.epoch === boundEpoch &&
        b.epoch === epoch(storage, accountId) &&
        !tab.scrubbed.has(accountId) &&
        typeof b.path === "string" &&
        PATHS[s.kind].test(b.path) &&
        typeof b.body === "string" &&
        object(json) &&
        json.account_id === accountId &&
        json.idempotency_key === s.key
      )
        return {
          operationId: s.operationId,
          epoch: b.epoch,
          path: b.path,
          body: b.body,
        };
    } catch {
      /* Unusable bodies never replay. */
    }
    dropBody(s.operationId);
    return null;
  }
  function view(s: Stub): IntentView {
    return {
      operationId: s.operationId,
      kind: s.kind,
      scope: s.scope,
      state: s.state === "saved" || s.state === "sending" ? "unknown" : s.state,
      waitingAccount: overlays.has(s.operationId),
      replayable: body(s) !== null,
    };
  }
  function list(): IntentView[] {
    sweep();
    try {
      return keys(storage, stubPrefix)
        .map((k) => stub(k.slice(stubPrefix.length)))
        .filter((s): s is Stub => s !== null)
        .sort((a, b) => a.createdAt - b.createdAt)
        .map(view);
    } catch {
      return [];
    }
  }
  const blockerFor = (scope: string) =>
    list().find((v) => v.scope === scope || v.scope === "*");
  const moved = (b: Binding) =>
    epoch(storage, accountId) !== b.boundEpoch || tab.scrubbed.has(accountId);
  const stale = (b: Binding) => b.generation !== generation;
  function state(s: Stub, next: Stub["state"]): boolean {
    try {
      storage!.setItem(
        stubPrefix + s.operationId,
        JSON.stringify({ ...s, state: next })
      );
      s.state = next;
      notify();
      return true;
    } catch {
      return false;
    }
  }
  const pending = (
    s: Stub,
    refusal: Refusal | null = refusals.get(s.operationId) ?? null
  ): FlowOutcome => ({
    kind: "pending",
    view: view(s),
    refusal,
  });
  async function registered<T>(
    call: (signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    const c = new AbortController();
    controllers.add(c);
    try {
      return await call(c.signal);
    } finally {
      controllers.delete(c);
    }
  }
  const session = () =>
    registered((signal) => readSession(ports.fetchImpl, signal));
  const post = (path: string, text: string) =>
    registered((signal) => transmit(ports.fetchImpl, path, text, signal));
  function settle(
    s: Stub,
    end: "done" | "voided",
    response: unknown,
    refusal: Refusal | null,
    otherAccount: boolean
  ): FlowOutcome {
    try {
      storage!.removeItem(bodyPrefix + s.operationId);
      storage!.removeItem(stubPrefix + s.operationId);
    } catch {
      return pending(s, refusal);
    }
    overlays.delete(s.operationId);
    refusals.delete(s.operationId);
    notify();
    return end === "done"
      ? { kind: "done", response }
      : { kind: "voided", refusal, otherAccount };
  }
  async function fence(
    s: Stub,
    b: Binding,
    refusal: Refusal | null = refusals.get(s.operationId) ?? null,
    response?: unknown
  ): Promise<FlowOutcome> {
    const who = await session();
    if (stale(b)) return { kind: "stale" };
    if (!who.ok) return pending(s, refusal);
    if (who.userId !== accountId) {
      overlays.set(s.operationId, "void");
      notify();
      return pending(s, refusal);
    }
    const answer = await post(
      VOID_PATH,
      JSON.stringify({
        idempotency_key: s.key,
        account_id: accountId,
      } satisfies VoidCommandKey)
    );
    const result = voidAnswer(answer, accountId);
    if (result === "applied" || result === "void") {
      const outcome = settle(
        s,
        result === "applied" ? "done" : "voided",
        response,
        refusal,
        result === "void" && s.state === "confirming"
      );
      return stale(b) ? { kind: "stale" } : outcome;
    }
    if (stale(b)) return { kind: "stale" };
    if (result === "account") overlays.set(s.operationId, "void");
    notify();
    return pending(s, refusal);
  }
  async function afterSend(
    s: Stub,
    b: Binding,
    answer: Answer
  ): Promise<FlowOutcome> {
    const result = sendAnswer(answer);
    if (result === "void") {
      const outcome = settle(s, "voided", undefined, null, false);
      return stale(b) ? { kind: "stale" } : outcome;
    }
    const next =
      result === "confirm"
        ? "confirming"
        : result === "refused"
          ? "fencing"
          : "unknown";
    const saved = state(s, next);
    if (stale(b)) return { kind: "stale" };
    const refusal: Refusal | null =
      result === "refused"
        ? {
            status: answer.status!,
            code: answer.code ?? "UNKNOWN",
            detail: answer.detail,
          }
        : null;
    if (refusal) {
      refusals.set(s.operationId, refusal);
    } else refusals.delete(s.operationId);
    if (!saved) return pending(s, refusal);
    if (result === "account") {
      overlays.set(s.operationId, "replay");
      notify();
    }
    return result === "confirm" || result === "refused"
      ? fence(
          s,
          b,
          refusal,
          answer.parsed &&
            answer.status !== null &&
            answer.status >= 200 &&
            answer.status < 300
            ? answer.json
            : undefined
        )
      : pending(s);
  }
  async function replayInside(s: Stub, b: Binding): Promise<FlowOutcome> {
    if (view(s).state !== "unknown") return pending(s);
    const payload = body(s, b.boundEpoch);
    if (!payload) return pending(s);
    const who = await session();
    if (stale(b)) {
      dropBody(s.operationId);
      return { kind: "stale" };
    }
    if (!who.ok) return pending(s);
    if (who.userId !== accountId) {
      overlays.set(s.operationId, "replay");
      notify();
      return pending(s);
    }
    if (moved(b) || payload.epoch !== b.boundEpoch) {
      dropBody(s.operationId);
      return pending(s);
    }
    if (!state(s, "sending")) return pending(s);
    return afterSend(s, b, await post(payload.path, payload.body));
  }
  async function locked(
    b: Binding,
    scope: string,
    call: () => Promise<FlowOutcome>
  ): Promise<FlowOutcome> {
    if (b.accountId !== accountId) return { kind: "stale" };
    if (!ports.locks) return { kind: "no_locks" };
    if (!storage) return { kind: "not_saved" };
    try {
      return await ports.locks.request(
        `prizecheck:loan-scope:${encodeURIComponent(accountId)}:${scope}`,
        { mode: "exclusive", ifAvailable: true },
        async (lock) => {
          if (!lock) return { kind: "busy" };
          sweep();
          if (stale(b)) return { kind: "stale" };
          return call();
        }
      );
    } catch {
      const blocking = blockerFor(scope);
      return blocking
        ? { kind: "pending", view: blocking, refusal: null }
        : { kind: "not_saved" };
    }
  }
  async function operate(
    action: "replay" | "cancel" | "check",
    b: Binding,
    id: string
  ): Promise<FlowOutcome> {
    const initial = stub(id);
    return locked(b, initial?.scope ?? "*", async () => {
      const s = stub(id);
      if (!s) return { kind: "settled_elsewhere" };
      if (action === "replay") return replayInside(s, b);
      if (action === "cancel") {
        if (!state(s, "fencing")) return pending(s);
        return fence(s, b);
      }
      const overlay = overlays.get(id);
      if (overlay) {
        const who = await session();
        if (stale(b)) return { kind: "stale" };
        if (!who.ok || who.userId !== accountId) return pending(s);
        overlays.delete(id);
        if (overlay === "replay") return replayInside(s, b);
      }
      return view(s).state === "unknown" ? pending(s) : fence(s, b);
    });
  }
  sweep();
  const unsubscribe = ports.onStorage((e) => {
    if (e.key === prefix("epoch", accountId)) {
      handle.invalidate();
      return;
    }
    if (e.key?.startsWith(bodyPrefix) && e.newValue !== null) {
      const value = parse(e.newValue);
      if (!object(value) || value.epoch !== epoch(storage, accountId)) {
        try {
          storage?.removeItem(e.key);
        } catch {
          /* Best effort. */
        }
      }
    }
    if (e.key?.startsWith(stubPrefix)) notify();
  });
  return {
    bind() {
      const e = epoch(storage, accountId);
      return e === null ? null : { accountId, boundEpoch: e, generation };
    },
    list,
    blockerFor,
    send(b, draft) {
      return locked(b, draft.scope, async () => {
        const blocker = blockerFor(draft.scope);
        if (blocker)
          return {
            kind: "pending",
            view: blocker,
            refusal: refusals.get(blocker.operationId) ?? null,
          };
        const who = await session();
        if (stale(b)) return { kind: "stale" };
        if (!who.ok) return { kind: "not_sent" };
        if (who.userId !== accountId) return { kind: "wrong_account" };
        if (moved(b)) return { kind: "not_saved" };
        const a: Attempt = newAttempt({ accountId, ...draft }, ports);
        const s: Stub = {
          v: 2,
          accountId,
          operationId: a.operationId,
          kind: a.kind,
          scope: a.scope,
          key: a.key,
          createdAt: a.createdAt,
          state: "saved",
          contract: a.contract,
        };
        const removeBoth = () => {
          dropBody(a.operationId);
          try {
            storage!.removeItem(stubPrefix + a.operationId);
          } catch {
            /* Never transmitted. */
          }
        };
        try {
          const bodyText = JSON.stringify({
            operationId: a.operationId,
            epoch: b.boundEpoch,
            path: a.path,
            body: a.body,
          });
          const stubText = JSON.stringify(s);
          storage!.setItem(bodyPrefix + a.operationId, bodyText);
          storage!.setItem(stubPrefix + a.operationId, stubText);
          if (
            storage!.getItem(bodyPrefix + a.operationId) !== bodyText ||
            storage!.getItem(stubPrefix + a.operationId) !== stubText ||
            moved(b)
          ) {
            removeBoth();
            return { kind: "not_saved" };
          }
        } catch {
          removeBoth();
          return { kind: "not_saved" };
        }
        if (!state(s, "sending") || moved(b)) {
          removeBoth();
          return { kind: "not_saved" };
        }
        return afterSend(s, b, await post(a.path, a.body));
      });
    },
    replay: (b, id) => operate("replay", b, id),
    cancel: (b, id) => operate("cancel", b, id),
    check: (b, id) => operate("check", b, id),
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    dispose() {
      unsubscribe();
      refusals.clear();
      tab.stores.get(accountId)?.delete(handle);
    },
  };
}
