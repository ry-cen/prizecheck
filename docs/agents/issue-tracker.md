# Issue tracker: Local Markdown

Issues, specifications, and Wayfinder artifacts for this repository live as Markdown files under `.scratch/`.

## Feature conventions

- One feature per directory: `.scratch/<feature-slug>/`
- The specification is `.scratch/<feature-slug>/spec.md`
- Implementation tickets are stored individually under `.scratch/<feature-slug>/issues/`
- Ticket state is recorded in a `Status` field near the top of each ticket
- Comments and conversation history may be appended under a `## Comments` heading

## Existing Pokémon TCG tracker effort

The active effort is `.scratch/tcg-collection-tracker/`.

- Specification: `.scratch/tcg-collection-tracker/spec.md`
- Implementation tickets: `.scratch/tcg-collection-tracker/issues/`
- Wayfinder map: `.scratch/tcg-collection-tracker/wayfinder/map.md`
- Wayfinder decision tickets: `.scratch/tcg-collection-tracker/wayfinder/tickets/`
- Research: `.scratch/tcg-collection-tracker/wayfinder/research/`
- Prototypes: `.scratch/tcg-collection-tracker/wayfinder/prototypes/`
- Resolutions: `.scratch/tcg-collection-tracker/wayfinder/resolutions/`

These existing locations are authoritative. Do not relocate or duplicate their contents to match a generic convention.

## Skill operations

When a skill says “publish to the issue tracker,” create or update the appropriate Markdown artifact under `.scratch/<feature-slug>/`.

When a skill says “fetch the relevant ticket,” read the referenced local Markdown file. The user will normally provide its path, number, or linked name.

## Wayfinder operations

- Read the effort’s `wayfinder/map.md`.
- Scan `wayfinder/tickets/` for the next open, unblocked ticket.
- Claim a ticket by updating its status before starting work.
- Store substantial supporting research, prototypes, and resolutions in their existing Wayfinder subdirectories.
- Resolve a ticket by recording its conclusion, closing its status, and adding a linked summary to the map’s “Decisions so far” section.
- Preserve dependencies and refer to tickets by their linked names rather than bare numbers.

## Completion and launch acceptance

When scope changes, record the owner's decision in an ADR and replace the active completion criteria before closing tickets. Put superseded criteria under a historical heading with a link to the current criteria.

Close an implementation ticket after its active criteria pass and its evidence identifies the tested code, procedure and environment. Track external deployment, real-recipient delivery, provider measurements and human walkthroughs in a separate launch checklist. A completed implementation status does not establish production launch acceptance.
