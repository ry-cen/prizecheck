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

A track may be a slice, ``Track(through=..., after=...)``, so an entry can run the root files up to a cutoff, then another
track, then the root files after it. A track may also list files it ``recorded``: for a database that already holds a
file's effects (Pokémon with the core baseline, S10), ``apply`` checks that the objects the file creates exist, inserts the
ledger row and does not run it. A new game's entry lists the same file as an ordinary one and it runs.

Tracks do not nest. A ``.sql`` file two or more directories below ``migrations/`` (``migrations/core/x/001_a.sql``) belongs
to no track and nothing would ever run it, so every function here that lists a migration tree refuses it by name instead
of ignoring it. The suffix is matched exactly as the runner globs it, lower-case ``.sql``: ``001_a.SQL`` is ignored at every
depth, as it always was, and only a nested ``.sql`` is an error.
"""
from dataclasses import dataclass
import os
from pathlib import Path
import re

LEDGER = "CREATE TABLE IF NOT EXISTS schema_migration (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"


class MissingObjects(RuntimeError):
    """A file an entry records without running would be recorded over objects the database does not have."""


@dataclass(frozen=True)
class Track:
    """``directory`` is relative to ``migrations/``; the empty string is the root track (Pokémon's, unqualified names).

    ``through`` and ``after`` slice the track by file name: only files named at or before ``through`` and after ``after``
    (a ``""`` bound is no bound). ``recorded`` names files of this slice that the entry records without running."""
    directory: str = ""
    through: str = ""
    after: str = ""
    recorded: tuple = ()

    def __post_init__(self):
        if "/" in self.directory or self.directory in (".", ".."):
            raise ValueError(f"A track is the root or one directory directly under migrations/, not {self.directory!r}")

    def ledger_name(self, filename):
        return f"{self.directory}/{filename}" if self.directory else filename

    def files(self, migrations):
        """This slice's files in apply order: by name, as the runner always ordered the root directory."""
        paths = sorted((Path(migrations) / self.directory).glob("*.sql"))
        return [path for path in paths if (not self.through or path.name <= self.through) and (not self.after or path.name > self.after)]


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
    for track in tracks:
        absent = set(track.recorded) - {path.name for path in track.files(migrations)}
        if absent:
            raise ValueError(f"Track {track.directory or 'root'!r} records files it does not have: {', '.join(sorted(absent))}")
    return plan


def recorded_names(tracks):
    """The ledger names ``tracks`` record without running."""
    return {track.ledger_name(name) for track in tracks for name in track.recorded}


CREATES = re.compile(r"^CREATE (?:OR REPLACE )?(TABLE|VIEW|FUNCTION) (?:IF NOT EXISTS )?([a-z_][a-z0-9_]*)", re.M)
INSERTS = re.compile(r"^INSERT INTO ([a-z_][a-z0-9_]*)", re.M)


def missing_objects(conn, text):
    """What ``text`` (a file recorded without running) leaves in the database that is not there: each table, view and function
    it creates at the start of a line, and each table it inserts into at the start of a line, which must hold rows. Reads the
    SQL's statements, not its effects, so it is a precondition and not a comparison: api/tests/test_core_baseline.py proves the
    objects match."""
    missing = []
    for kind, name in dict.fromkeys(CREATES.findall(text)):
        if kind == "FUNCTION":
            present = conn.execute("SELECT EXISTS (SELECT 1 FROM pg_proc WHERE proname = %s AND pronamespace = 'public'::regnamespace)", (name,)).fetchone()[0]
        else:
            present = conn.execute("SELECT to_regclass(%s) IS NOT NULL", (name,)).fetchone()[0]
        if not present:
            missing.append(f"{kind.lower()} {name}")
    for name in dict.fromkeys(INSERTS.findall(text)):
        present = conn.execute("SELECT to_regclass(%s) IS NOT NULL", (name,)).fetchone()[0]
        if not present or not conn.execute(f"SELECT EXISTS (SELECT 1 FROM {name})").fetchone()[0]:
            missing.append(f"rows in {name}")
    return missing


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
    """Apply the pending files of ``tracks`` in plan order, each in its own transaction, recording its ledger name. A pending
    file the tracks record is not run: its objects must already exist (``missing_objects``) or the whole run stops and
    nothing is committed. Returns the ledger names added. The plan is read first, so a tree the tools refuse (a nested
    ``.sql`` file) changes nothing, not even the ledger table."""
    tracks = tuple(tracks)
    plan = planned(migrations, tracks)
    recorded = recorded_names(tracks)
    conn.execute(LEDGER)
    added = []
    for name, path in plan:
        if conn.execute("SELECT 1 FROM schema_migration WHERE name = %s", (name,)).fetchone():
            continue
        with conn.transaction():
            if name in recorded:
                missing = missing_objects(conn, path.read_text())
                if missing:
                    raise MissingObjects(f"Refusing to record {name} without running it; the database lacks {', '.join(missing)}")
                announce(f"Recorded {name} without running it")
            else:
                conn.execute(path.read_text())
                announce(f"Applied {name}")
            conn.execute("INSERT INTO schema_migration (name) VALUES (%s)", (name,))
        added.append(name)
    return added
