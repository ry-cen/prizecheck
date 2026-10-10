# Issue tracker: GitHub Issues

Tickets for this repository are GitHub Issues on [ry-cen/tcg-tracker](https://github.com/ry-cen/tcg-tracker/issues). Specifications, Wayfinder maps, research, prototypes, resolutions and evidence are tracked Markdown under `docs/planning/`. Use the `gh` CLI for issue operations.

`.scratch/` is ignored local working space. Do not store anything there that must be shared or kept.

## Feature conventions

- One feature per planning directory: `docs/planning/<feature-slug>/`
- The specification is `docs/planning/<feature-slug>/spec.md`
- Implementation tickets are GitHub Issues labelled `implementation`
- Wayfinder decision tickets are GitHub Issues labelled `wayfinder`
- Ticket state is the issue's open/closed state; close completed work with reason "completed"
- Comments and conversation history go in issue comments

## Existing Pokémon TCG tracker effort

The active effort is `docs/planning/tcg-collection-tracker/`.

- Specification: `docs/planning/tcg-collection-tracker/spec.md`
- Implementation tickets: [issues labelled `implementation`](https://github.com/ry-cen/tcg-tracker/issues?q=label%3Aimplementation)
- Wayfinder map: `docs/planning/tcg-collection-tracker/wayfinder/map.md`
- Wayfinder decision tickets: [issues labelled `wayfinder`](https://github.com/ry-cen/tcg-tracker/issues?q=label%3Awayfinder)
- Research: `docs/planning/tcg-collection-tracker/wayfinder/research/`
- Prototypes: `docs/planning/tcg-collection-tracker/wayfinder/prototypes/`
- Resolutions: `docs/planning/tcg-collection-tracker/wayfinder/resolutions/`
- Evidence: `docs/planning/tcg-collection-tracker/evidence/`
- Launch checklist: `docs/planning/tcg-collection-tracker/launch-checklist.md`

The original tickets were migrated from `.scratch/` Markdown on 2026-10-09. Implementation tickets 01–19 are issues #16–#34; Wayfinder tickets 01–15 are issues #1–#15. Each issue body ends with a note giving its original path.

## Feature-branch efforts

Tickets that existed only on feature branches were migrated the same day, labelled by feature:

- `feature: prices & exports` (`feature/card-prices-and-deck-exports`): Wayfinder tickets 16–25 are issues #35–#44; implementation tickets 01–15 are issues #50–#64, with titles prefixed "Prices & exports".
- `feature: workspace redesign` (`feature/ui-workspace-redesign`): Wayfinder tickets 26–30 are issues #45–#49.

Each branch also has a cleanup commit that moves its planning files from `.scratch/` to `docs/planning/` and deletes its ticket files. A branch commit that predates that cleanup and edits `.scratch/` will conflict when replayed onto `dev`. Resolve it by dropping the `.scratch/` change and recording the update on the GitHub issue or the moved `docs/planning/` file.

## Skill operations

When a skill says “publish to the issue tracker,” create or update a GitHub Issue (`gh issue create` / `gh issue edit`) with the appropriate label. Put long-form specs and supporting artifacts under `docs/planning/<feature-slug>/` and link them from the issue.

When a skill says “fetch the relevant ticket,” read the issue with `gh issue view <number> --comments`. The user will normally provide its number, URL, or title.

## Wayfinder operations

- Read the effort’s `wayfinder/map.md`.
- List open, unblocked Wayfinder tickets with `gh issue list --label wayfinder --state open`.
- Claim a ticket by assigning it before starting work.
- Store substantial supporting research, prototypes, and resolutions in their existing Wayfinder subdirectories under `docs/planning/`.
- Resolve a ticket by commenting its conclusion, closing the issue, and adding a linked summary to the map’s “Decisions so far” section.
- Preserve dependencies and refer to tickets by issue links rather than bare numbers.

## Completion and launch acceptance

When scope changes, record the owner's decision in an ADR and replace the active completion criteria before closing tickets. Put superseded criteria under a historical heading with a link to the current criteria.

Close an implementation ticket after its active criteria pass and its evidence identifies the tested code, procedure and environment. Track external deployment, real-recipient delivery, provider measurements and human walkthroughs in a separate launch checklist. A completed implementation status does not establish production launch acceptance.
