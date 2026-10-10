# Local preparation review and validation

Date: 2026-10-06. Integration branch: `codex/mvp-integration`. Confirmed review baseline: `a38c674`; this continuation isolates changes after `a197edb`, following the earlier application review. Final tested preparation tip: `3cc7dfa`.

The owner explicitly authorized local operational tooling and measured evidence while keeping production provisioning pending. Tickets 15–18 are not complete.

## Standards

No documented-standard violations or actionable baseline smells were found. A P2 private/public separation guard skipped the application default when PUBLIC_PROJECTION_DIR was absent. It now applies the same default and fails closed for an empty configured path. Independent re-review confirmed both cases; CLI regressions cover them.

## Spec

A P2 backup correctness issue skipped inaccessible sequence state for a table-readable role, risking reused IDs after a verified restore. Backup now requires sequence visibility and fails safely when missing. A real restricted-role regression and used/unused sequence continuation checks cover the fix. Independent re-review confirmed resolution. Deferred provider/production acceptance gates are recorded as pending rather than local implementation defects.

Two review concerns were resolved by one implementer. No remaining concrete issue in the focused re-reviews.

## Validation

At `ed77188`, the combined `scripts/ci.sh` disposable-database gate passed migrations/generated clients, TypeScript/build, 68 API/PostgreSQL tests (34.93s), six live auth tests (6.04s), and 19 Chromium tests (50.8s). One opt-in capacity test was skipped by this ordinary gate and exercised separately. Recovery-only fixes afterward passed five PostgreSQL/CLI tests at `3cc7dfa` (2.995s). The complete application gate was not repeated for isolated recovery CLI fixes.

The documented fresh-database capacity command passed its new fixture plus two existing rollback/stale-boundary checks after integration. See [capacity evidence](local-capacity.md) and [sanitized report](../validation/local-capacity.json). Five successful 25,000-Edition Moves took 3.031–3.655 seconds at the signed in-process HTTP boundary. These are synthetic local measurements, not browser, full-catalog or provider proof.

Recovery procedure: [local private backup and disposable restore](../../../operations/local-recovery.md). Five local tests cover a small deterministic fixture, exact immutable inventory/override identity, publication burns/outbox, expiry filtering, sequence continuation/privileges, checksum corruption, existing-target refusal and public-path separation. No remote production backup or cutover was performed.

Provider topology preparation: [deployment boundaries](../../../deployment-boundaries.md). Retention, schedulers, independent watchdog, alerts/owner status, remote storage integration, real email delivery, exact-release deployment/rollback, full representative workload and owner walkthrough remain pending. Application signup remains owner-only.
