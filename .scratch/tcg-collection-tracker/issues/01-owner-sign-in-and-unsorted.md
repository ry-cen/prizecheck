# 01 — Owner sign-in and Unsorted

**Label:** ready-for-agent

**Blocked by:** None — can start immediately

**Status:** complete

**What to build:** A collector can open the React app, request and enter an email code, and arrive at a private Locations view containing their Unsorted Storage Leaf. This establishes the Python API, Better Auth boundary, PostgreSQL migration, generated client contract, and local development flow through one usable journey.

- [x] A valid six-digit code signs in an owner account, creates its inventory owner and ordinary Unsorted root leaf atomically, and opens the Locations view; the first configuration rejects other account creation.
- [x] Codes are hashed, expire after five minutes, rotate on resend, fail after three wrong attempts, and use uniform request responses plus durable per-email, trusted-IP, and configurable daily send limits. Configure the cap below the provider allowance when a delivery provider is chosen.
- [x] A same-origin Secure, HttpOnly, SameSite=Lax server session lasts 30 days, rolls while active, ends on sign-out, and restores only safe same-origin protected destinations. Loopback HTTP development omits Secure so browsers can use the cookie.
- [x] The Python API accepts only a verified internal Better Auth session result for immutable user identity; forged headers, auth unavailability, and cross-owner requests cannot grant access. Bind the owner role by an explicit immutable user ID setup step.
- [x] A browser can see the private Unsorted leaf and a safe API health result locally. Python/Pydantic/OpenAPI and generated TypeScript client types agree under the provider-neutral CI gate; real PostgreSQL migration and browser/API tests cover sign-in, sign-out, expiry, limits, CSRF, privacy, and two-user isolation. Running that gate in a hosted CI provider belongs to ticket 17 after provider selection.
- [x] The frontend, API, auth service, database, and fake email delivery run locally without a production provider account.

## Comments

- 2026-09-29: Implemented the slice in the existing repository. `scripts/ci.sh` passed against a fresh PostgreSQL database: repeatable migrations, OpenAPI-generated TypeScript check, TypeScript/build, 2 API tests, 5 live auth HTTP tests, and 2 Chromium tests. It covers the browser journey, hashed/rotated/expired codes, send limits, CSRF, forged identity, auth outage, safe returns, and two-owner API isolation. Verified explicit owner binding separately. Hosted CI invocation was deferred with provider selection by ADR 0002. The configured daily email cap must be set below the allowance of the later delivery provider.
- 2026-09-29: The owner confirmed ticket 01 complete. Its provider-neutral CI gate passed locally; hosted CI wiring remains a ticket 17 launch criterion because the CI provider is deferred. Commit `b492961` contains the implementation.
