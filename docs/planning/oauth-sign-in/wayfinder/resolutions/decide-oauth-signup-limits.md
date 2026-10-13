# Decide limits on OAuth account creation

Resolved 2026-10-12 for [Decide limits on OAuth account creation](https://github.com/ry-cen/prizecheck/issues/145). This is a technical choice the owner delegated to Claude. The model is today's email-send limiter, `allowedSend()` in `auth/src/server.ts`. It takes a Postgres advisory lock, uses hashed email and IP keys in `auth_send_event`, allows 20 sends per trusted IP per hour, and has an application-wide `DAILY_SEND_CAP` that defaults to 100.

## Decisions

1. **Limit account creation, not sign-in.** Returning collectors are never throttled by these limits. In `owner-only` mode, nobody but the owner can create an account, so the limits only matter once signup is `public` or `local-public`.
2. **Two durable limits, checked in the gate before any row is written:**
   - **Per trusted client IP:** at most 10 new accounts per rolling day. That's generous for a shared household or campus address, and tight enough to stop one source scripting accounts.
   - **Application-wide:** at most `DAILY_SIGNUP_CAP` new accounts per rolling day, defaulting to 100. That's far above the spec's load fixture (1,000 accounts and 200 monthly actives in total) and well inside the agreed capacity envelope.

   Both checks run in `validateUserInfo`'s create-user branch, in one transaction under an advisory lock, like `allowedSend()`. A permitted check records a row in a new `auth_signup_event(ip_key, created_at)` table, with the IP hashed as today. A creation that fails after the check still counts, which errs on the safe side. Rows older than two days are pruned.
3. **The gate learns the IP from the gateway, never from a header.** The gateway already computes `trustedClientIp()`. It runs each OAuth callback inside a Node `AsyncLocalStorage` context holding that IP, and the gate reads it from there. Nothing from the request can spoof the IP. A missing context refuses creation, so the gate fails closed.
4. **A cheap limit on sign-in starts per IP.** At most 60 starts of `/auth/sign-in/:provider` and `/auth/link/:provider` per trusted IP per hour. Each start writes a Better Auth `verification` row, so this stops cheap table growth. It's checked at the gateway with the same lock-and-hash pattern. An in-memory limiter isn't used, because it would reset per replica.
5. **The refusal is a single code, `too_many_sign_ups`.** It shows the "Too many attempts" message from [Decide what the sign-in page says when sign-in fails](https://github.com/ry-cen/prizecheck/issues/144), and it says nothing about any account.
6. **The owner panel shows the numbers.** It shows new accounts in the last day against `DAILY_SIGNUP_CAP`, and warns at 80%, next to the existing quota warnings. It also counts refusals under the existing bounded auth counters (`authCounter`).

## Consequences for the spec

- This adds one migration (`auth_signup_event`) and one env var (`DAILY_SIGNUP_CAP`), and adds a `too_many_sign_ups` counter to the operational outcomes.
- Tests cover:
  - the per-IP and application-wide limits at the boundary;
  - returning sign-ins not being throttled;
  - a missing IP context refusing creation;
  - the start limit;
  - pruning.
- The capacity check in readiness proof version 2 covers these limits at fixture scale.
