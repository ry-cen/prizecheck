-- Deploying a release applies its newest catalog rules (#377, ADR 0021, design section 4.15).
--
-- catalog_rule_activation.source says who made an activation: the owner (every row before this migration), a deploy that
-- applied the release's newest version, or a rollback that restored an older release's version. A deploy or rollback row
-- names the release commit and always has a version. The table stays append-only; adding columns fires no row trigger.
--
-- catalog_rule_rollout is the progress of re-evaluating targets after a deploy activation: the phase it is in, the cursor
-- (the last Edition id handled) a resumed run starts after, and the counts the Owner controls panel shows. done and total
-- count the current phase and reset when it changes; changed is cumulative. failed_phase remembers the phase a failed
-- rollout stopped in, so a later run resumes there.
--
-- Safe to run once on existing data; the owner rows keep source 'owner'.
ALTER TABLE catalog_rule_activation
  ADD COLUMN source text NOT NULL DEFAULT 'owner' CHECK (source IN ('owner','deploy','rollback')),
  ADD COLUMN release_commit text CHECK (release_commit ~ '^[0-9a-f]{40}$'),
  ADD CONSTRAINT catalog_rule_activation_release CHECK (source = 'owner' OR (release_commit IS NOT NULL AND version IS NOT NULL));
CREATE TABLE catalog_rule_rollout (
  activation_id uuid PRIMARY KEY REFERENCES catalog_rule_activation(id),
  phase text NOT NULL CHECK (phase IN ('live','editions','quote_variants','deliver','done','failed')),
  failed_phase text CHECK (failed_phase IN ('live','editions','quote_variants','deliver')),
  cursor uuid,
  total integer CHECK (total >= 0),
  done integer NOT NULL DEFAULT 0 CHECK (done >= 0),
  changed integer NOT NULL DEFAULT 0 CHECK (changed >= 0),
  started_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  error text CHECK (length(error) <= 1000),
  CHECK ((phase = 'failed') = (failed_phase IS NOT NULL)),
  CHECK ((phase = 'done') = (finished_at IS NOT NULL))
);
