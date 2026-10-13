import { AsyncLocalStorage } from "node:async_hooks";

// The trusted client IP of the request being handled. The gateway computes it with trustedClientIp() (x-real-ip only
// from a trusted proxy) and runs each OAuth callback inside this context; the signup gate reads it from here, so no
// request header can set it. Outside a context there is no IP, and the gate refuses to create an account.
export const ipContext = new AsyncLocalStorage<{ ip: string }>();

export function contextIp(): string | null {
  return ipContext.getStore()?.ip ?? null;
}
