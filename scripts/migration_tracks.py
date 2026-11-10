"""Migration tracks and the runner that applies them (IM-11, IM-12; ADR 0023).

A track is a directory of numbered ``*.sql`` files under ``migrations/``. The root directory is Pokémon's track and keeps
its files and ledger names as they are. Every other track is a subdirectory (``core``, later ``auth`` or a game), numbers
itself, and records its files in ``schema_migration`` under a path-qualified name such as ``core/001_x.sql``, so an older
release reading the ledger sees only extra rows.

There is no registry and no run-time game setting. A per-database entry script (``scripts/migrate.py`` for Pokémon) names
its tracks, in the order they apply, and hands them to ``apply`` with its own connection. Core migrations never reference a
game's tables and game migrations may depend on core, so an entry lists ``core`` before its game's track.

The duplicate-number guardrail (scripts/check_guardrails.py) runs for the root and for each track, one number space per
track. The runner itself only refuses a repeated ledger name.

Tracks do not nest. A ``.sql`` file two or more directories below ``migrations/`` (``migrations/core/x/001_a.sql``) belongs
to no track and nothing would ever run it, so every function here that lists a migration tree refuses it by name instead
of ignoring it. The suffix is matched exactly as the runner globs it, lower-case ``.sql``: ``001_a.SQL`` is ignored at every
depth, as it always was, and only a nested ``.sql`` is an error.
"""
from dataclasses import dataclass
import os
from pathlib import Path

LEDGER = "CREATE TABLE IF NOT EXISTS schema_migration (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"


@dataclass(frozen=True)
class Track:
    """``directory`` is relative to ``migrations/``; the empty string is the root track (Pokémon's, unqualified names)."""
    directory: str = ""

    def __post_init__(self):
        if "/" in self.directory or self.directory in (".", ".."):
            raise ValueError(f"A track is the root or one directory directly under migrations/, not {self.directory!r}")

    def ledger_name(self, filename):
        return f"{self.directory}/{filename}" if self.directory else filename

    def files(self, migrations):
        """This track's files in apply order: by name, as the runner always ordered the root directory."""
        return sorted((Path(migrations) / self.directory).glob("*.sql"))


class NestedMigrationError(ValueError):
    """A ``.sql`` file sits two or more directories below ``migrations/``, where no track would apply it."""


def nested_files(migrations):
    """The ``.sql`` files two or more directories below ``migrations``, as sorted paths relative to it (``core/x/001_a.sql``).
    Directories are walked without following symlinks."""
    migrations = Path(migrations)
    found = []
    for folder, _, names in os.walk(migrations):
        depth = len(Path(folder).relative_to(migrations).parts)
        if depth >= 2:
            found += [(Path(folder) / name).relative_to(migrations).as_posix() for name in names if name.endswith(".sql")]
    return sorted(found)


def reject_nested(migrations):
    """Raises ``NestedMigrationError`` naming every nested ``.sql`` file; returns normally when there is none."""
    nested = nested_files(migrations)
    if nested:
        raise NestedMigrationError(
            f"Migration files must sit in migrations/ or directly in one track directory under it; nothing would run "
            f"{', '.join('migrations/' + name for name in nested)}")


def planned(migrations, tracks):
    """``[(ledger name, path)]`` for every file of ``tracks``, tracks in the order given and files by name within each.
    Refuses a migration tree holding a nested ``.sql`` file."""
    reject_nested(migrations)
    tracks = tuple(tracks)
    if len(set(tracks)) != len(tracks):
        raise ValueError("A track is named more than once")
    plan = [(track.ledger_name(path.name), path) for track in tracks for path in track.files(migrations)]
    if len({name for name, _ in plan}) != len(plan):
        raise ValueError("Two migration files share a ledger name")
    return plan


def every_track(migrations):
    """The root track and each subdirectory of ``migrations`` that holds ``*.sql`` files, for tools that look at a release's
    whole migration tree (release immutability, the guardrails). It is not what one database applies: that database's entry
    names its tracks. ``release_runtime`` reads the whole tree for the Pokémon ledger today, a gap for S4 (see there)."""
    reject_nested(migrations)
    migrations = Path(migrations)
    directories = sorted(path.name for path in migrations.iterdir() if path.is_dir() and any(path.glob("*.sql")))
    return (Track(), *(Track(directory) for directory in directories))


def files(migrations):
    """``{ledger name: path}`` across every track of a migration tree."""
    return dict(planned(migrations, every_track(migrations)))


def apply(conn, migrations, tracks, announce=print):
    """Apply the pending files of ``tracks`` in plan order, each in its own transaction, recording its ledger name.
    Returns the ledger names applied. The plan is read first, so a tree the tools refuse (a nested ``.sql`` file) changes
    nothing, not even the ledger table."""
    plan = planned(migrations, tracks)
    conn.execute(LEDGER)
    applied = []
    for name, path in plan:
        if conn.execute("SELECT 1 FROM schema_migration WHERE name = %s", (name,)).fetchone():
            continue
        with conn.transaction():
            conn.execute(path.read_text())
            conn.execute("INSERT INTO schema_migration (name) VALUES (%s)", (name,))
        announce(f"Applied {name}")
        applied.append(name)
    return applied
