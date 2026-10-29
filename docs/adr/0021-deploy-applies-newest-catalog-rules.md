# Deploying a release applies its newest catalog rules

**Status:** accepted 2026-10-28 (implemented in #377). Refines [ADR 0007](0007-edition-marketplace-metadata-boundary.md)
and [ADR 0019](0019-tcgcsv-daily-prices.md): the owner no longer activates catalog rules from Owner controls. Design:
[tcgcsv-prices design §4.15](../planning/tcgcsv-prices/design.md). Ticket: P11 (#377).

**Context.** Catalog rules (live derivation and marketplace matching) live in code as numbered versions with a pinned
digest. Until now a version took effect only when the owner activated it, from Owner controls or by a host command.
Production keeps `MARKETPLACE_MATCHING` off, so every new matching version needed a manual step after the release that
shipped it. That step is slow and blocking ([#343](https://github.com/ry-cen/prizecheck/issues/343)): one transaction
re-evaluates every unverified Edition. v3 took 18 minutes on production and blocked collection writes for the whole run.
On dev, `MARKETPLACE_MATCHING=automatic` already applies the newest matching version without an owner step.

**Decision.**

- The newest registered version of each rule kind is the rule a release runs. Deploying the release applies it. No owner
  activation, no environment switch, no deactivation.
- The owner approves a rule by merging the release that carries it. The pinned digest test keeps every archived version
  unchanged.
- Older versions stay registered as an archive. Their activation rows, and the Editions verified under them, keep their
  history.
- Applying a version records an activation (append-only, as before) marked as applied by a deploy, with the release
  commit. It then re-evaluates the affected targets in a resumable background rollout with short transactions. A
  collection write waits for at most one batch.
- A digest that differs from the recorded digest for the same version is an integrity failure. It is reported, never
  applied.
- The rollout's `editions` phase first refreshes the candidate inputs the newest rule reads and only a catalog import used to
  write, so a release does not wait for the next pull ([#395](https://github.com/ry-cen/prizecheck/issues/395)). Today that
  is `mapping_candidate.card_tcgplayer` (read by rule v5 and later): each batch of unverified Editions gets the key rebuilt
  from the Printing's stored `source_record.thirdParty.tcgplayer`, by the same function the import uses
  (`catalog_targets.card_tcgplayer_candidate`), and is then evaluated. The lookup (`candidate`) cannot be rebuilt, because
  stored records have no `pricing`, and is not touched. Gaining the key is enrichment: the mapping revision does not move,
  and a verified Edition keeps its state (the phase reaches only unverified Editions; a verified one gains the key on its
  next import). The refresh adds the key only where it is missing, so a rerun or a resumed batch changes nothing more. A
  later rule version that reads a new import-derived key must add its refresh there too. The refresh runs only inside a matching rollout, so a host whose newest matching version was applied before the refresh existed (dev and prod for v5 and v6) still needed one catalog pull.
- Rolling back to an older release restores, for each kind, the activation that was current before the newer one, so the
  older code never runs against a version it does not know.

**Consequences.**

- `MARKETPLACE_MATCHING`, the activation route and the activation form are removed. The Owner controls rules panel becomes
  read-only and shows the active version, when and by which release it was applied, and the rollout's progress or error.
- #343 is superseded: there is no activation request left to time out, and the rollout is batched and resumable.
- A rule change reaches production on the next release with no operator step. It must therefore be reviewed in its pull
  request like any other code.
- After a rollout starts, Editions it has not reached yet keep their previous state until it reaches them. Nothing
  un-verifies an Edition, so no price disappears during a rollout.
