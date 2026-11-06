import type { CommandKeyOutcome } from "../social_generated";

export type DurableKind =
  | "lend_offer"
  | "borrow_request"
  | "move_borrowed"
  | "start_return"
  | "write_off";
export const DURABLE_KINDS: readonly DurableKind[] = [
  "lend_offer",
  "borrow_request",
  "move_borrowed",
  "start_return",
  "write_off",
];
export const PATHS: Record<DurableKind, RegExp> = {
  lend_offer: /^\/api\/loans\/offers$/,
  borrow_request: /^\/api\/loans$/,
  move_borrowed: /^\/api\/loans\/borrowed\/move$/,
  start_return: /^\/api\/loans\/[0-9a-f-]{36}\/returns$/,
  write_off: /^\/api\/loans\/[0-9a-f-]{36}\/write-off$/,
};
export function scopeFor(
  kind: DurableKind,
  ids: { lenderId?: string; loanId?: string }
): string {
  if (kind === "lend_offer" || kind === "move_borrowed") return kind;
  const id = kind === "borrow_request" ? ids.lenderId : ids.loanId;
  if (!id) throw new Error("scope id missing");
  return `${kind}:${id}`;
}
export const LOAN_CONTRACT = "loans-t1";
export const LEGACY_CONTRACT = "loans-d1";
export const REPLAYABLE: Record<DurableKind, readonly string[]> = {
  lend_offer: [LEGACY_CONTRACT, LOAN_CONTRACT],
  borrow_request: [LEGACY_CONTRACT, LOAN_CONTRACT],
  move_borrowed: [LEGACY_CONTRACT, LOAN_CONTRACT],
  start_return: [LOAN_CONTRACT],
  write_off: [LOAN_CONTRACT],
};
export function threadIdOf(response: unknown): string | null {
  return object(response) && typeof response.thread_id === "string"
    ? response.thread_id
    : null;
}
export type Attempt = Readonly<{
  accountId: string;
  operationId: string;
  kind: DurableKind;
  scope: string;
  path: string;
  body: string;
  key: string;
  createdAt: number;
  contract: string;
}>;
export function newAttempt(
  input: {
    accountId: string;
    kind: DurableKind;
    scope: string;
    path: string;
    fields: Record<string, unknown>;
  },
  ids: { now(): number; uuid(): string }
): Attempt {
  if (!PATHS[input.kind].test(input.path))
    throw new Error("path does not match kind");
  if (
    "idempotency_key" in input.fields ||
    "account_id" in input.fields ||
    "replaces" in input.fields
  )
    throw new Error("reserved attempt field");
  const fields = { ...input.fields };
  const key = ids.uuid();
  return Object.freeze({
    accountId: input.accountId,
    operationId: ids.uuid(),
    kind: input.kind,
    scope: input.scope,
    path: input.path,
    body: JSON.stringify({
      ...fields,
      account_id: input.accountId,
      idempotency_key: key,
    }),
    key,
    createdAt: ids.now(),
    contract: LOAN_CONTRACT,
  });
}
export type Answer = {
  status: number | null;
  code: string | null;
  detail: Record<string, unknown>;
  json: unknown;
  parsed: boolean;
};
export function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export async function transmit(
  fetchImpl: typeof fetch,
  path: string,
  body: string,
  signal: AbortSignal
): Promise<Answer> {
  try {
    const response = await fetchImpl(path, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body,
      signal,
    });
    const text = await response.text();
    let json: unknown;
    let parsed = false;
    try {
      json = JSON.parse(text);
      parsed = true;
    } catch {
      /* An unreadable success still needs confirmation. */
    }
    const detail = object(json) && object(json.detail) ? json.detail : {};
    return {
      status: response.status,
      code: typeof detail.code === "string" ? detail.code : null,
      detail,
      json,
      parsed,
    };
  } catch {
    return {
      status: null,
      code: null,
      detail: {},
      json: undefined,
      parsed: false,
    };
  }
}
export async function readSession(
  fetchImpl: typeof fetch,
  signal: AbortSignal
): Promise<{ ok: true; userId: string | null } | { ok: false }> {
  try {
    const response = await fetchImpl("/auth/session", {
      credentials: "same-origin",
      signal,
    });
    if (!response.ok) return { ok: false };
    const json: unknown = await response.json();
    if (!object(json) || typeof json.signedIn !== "boolean")
      return { ok: false };
    if (!json.signedIn) return { ok: true, userId: null };
    return typeof json.userId === "string"
      ? { ok: true, userId: json.userId }
      : { ok: false };
  } catch {
    return { ok: false };
  }
}
export function sendAnswer(
  a: Answer
): "confirm" | "void" | "account" | "refused" | "unknown" {
  if (a.status === null || a.status >= 500) return "unknown";
  if (a.status >= 200 && a.status < 300) return "confirm";
  if (a.status === 409 && a.code === "IDEMPOTENCY_KEY_VOID") return "void";
  if (a.status === 409 && a.code === "ALREADY_APPLIED") return "confirm";
  if (a.status === 401 || (a.status === 409 && a.code === "ACCOUNT_CHANGED"))
    return "account";
  return a.status >= 400 && a.status < 500 ? "refused" : "unknown";
}
function commandOutcome(value: unknown): value is CommandKeyOutcome {
  return (
    object(value) &&
    (value.outcome === "applied" || value.outcome === "void") &&
    typeof value.account_id === "string"
  );
}
export function voidAnswer(
  a: Answer,
  accountId: string
): "applied" | "void" | "account" | "retry" {
  if (a.status === 401 || (a.status === 409 && a.code === "ACCOUNT_CHANGED"))
    return "account";
  return a.status !== null &&
    a.status >= 200 &&
    a.status < 300 &&
    a.parsed &&
    commandOutcome(a.json) &&
    a.json.account_id === accountId
    ? a.json.outcome
    : "retry";
}
