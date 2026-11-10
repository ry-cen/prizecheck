# Stub game track

A fixture for `api/tests/test_core_baseline.py`, not a game: it shows that a new game's database installs in the order core
baseline, core tail, game track (IM-11, S10). The test copies `migrations/core/` (the real baseline and seed) into a scratch
tree beside these two directories and applies `core` then `stub_game` with `scripts/migration_tracks.py`.

- `core/002_core_tail.sql` stands in for a later core migration.
- `stub_game/001_catalog.sql` creates the minimal `catalog_*` relations a game owns.
- `stub_game/002_core_references.sql` adds the sixteen foreign keys from core tables into them that the baseline leaves out.
