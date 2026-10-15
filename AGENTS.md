## Branch policy

Use `dev` as the integration branch. Update `main` from `dev` when the user authorizes a release.

## UI copy

Show collectors only what helps them decide or act. Leave data-source and provenance names (TCGdex, TCGplayer, marketplace IDs), fetch and check times, cache or refresh state, internal reasons and record IDs out of the UI, even when the API returns them. Owner and admin review screens are exempt, and so are legally required credits such as the Published Deck page's not-endorsed notice. If you aren't sure something belongs, leave it out and ask.

## Agent skills

### Issue tracker

Tickets are GitHub Issues on `ry-cen/prizecheck`; specs and Wayfinder artifacts are Markdown under `docs/planning/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the five default engineering-skill triage labels. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repository using root `CONTEXT.md` and system-wide ADRs under `docs/adr/`. See `docs/agents/domain.md`.

### Verification

For checks, browser failures, or harness changes, read `docs/agents/verification.md`.
