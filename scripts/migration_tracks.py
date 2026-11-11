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
file's effects (Pokémon with the core baseline, S10), ``apply`` checks the objects and seed rows named in the file's
manifest (``core/000_baseline.manifest``), inserts the ledger row and does not run it. A new game's entry lists the same file as an ordinary one and it runs.

Tracks do not nest. A ``.sql`` file two or more directories below ``migrations/`` (``migrations/core/x/001_a.sql``) belongs
to no track and nothing would ever run it, so every function here that lists a migration tree refuses it by name instead
of ignoring it. The suffix is matched exactly as the runner globs it, lower-case ``.sql``: ``001_a.SQL`` is ignored at every
depth, as it always was, and only a nested ``.sql`` is an error.
"""
from dataclasses import dataclass
import os
from pathlib import Path

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


MANIFEST_KINDS = ("table", "view", "function", "index", "constraint", "trigger", "rows")


def manifest_path(path):
    """The manifest of a recorded file: ``core/000_baseline.sql`` has ``core/000_baseline.manifest`` beside it."""
    return Path(path).with_suffix(".manifest")


def parse_manifest(text):
    """The objects a recorded file leaves behind, from its manifest, as ``{kind: set}``. A manifest is one line per fact, in
    sorted order, ``#`` lines being comments:

        table <name> <column> <column> ...      view <name> <column> ...
        function <name>(<identity arguments>)   index <name>
        constraint <table> <name>               trigger <table> <name>
        rows <table> <exact row count>

    A table or view line lists its columns, which become ``table.column`` entries. A recorded file may sit in a database with
    more than its manifest names; it may not lack anything the manifest names."""
    wanted = {kind: set() for kind in ("table", "view", "column", "function", "index", "constraint", "trigger")}
    wanted["rows"] = {}
    for number, line in enumerate(text.splitlines(), 1):
        if not line.strip() or line.startswith("#"):
            continue
        kind, _, rest = line.partition(" ")
        if kind in ("table", "view"):
            name, *columns = rest.split()
            wanted[kind].add(name)
            wanted["column"].update(f"{name}.{column}" for column in columns)
        elif kind == "function" or kind == "index":
            wanted[kind].add(rest)
        elif kind in ("constraint", "trigger"):
            table, name = rest.split()
            wanted[kind].add(f"{table}.{name}")
        elif kind == "rows":
            table, count = rest.split()
            wanted["rows"][table] = int(count)
        else:
            raise ValueError(f"Manifest line {number} starts with {kind!r}, not one of {', '.join(MANIFEST_KINDS)}")
    return wanted


def present_objects(conn):
    """What the database's public schema holds, in the manifest's terms: the same ``{kind: set}`` ``parse_manifest`` returns,
    without ``rows``. Presence is all a precondition reads: an extra object never shows up as missing."""
    found = {kind: set() for kind in ("table", "view", "column", "function", "index", "constraint", "trigger")}
    for relname, relkind, attname in conn.execute(
            "SELECT c.relname, c.relkind, a.attname FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid"
            " WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v') AND a.attnum > 0 AND NOT a.attisdropped"):
        found["view" if relkind == "v" else "table"].add(relname)
        found["column"].add(f"{relname}.{attname}")
    found["function"] = {f"{name}({arguments})" for name, arguments in conn.execute(
        "SELECT proname, pg_get_function_identity_arguments(oid) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND prokind IN ('f', 'p')")}
    found["index"] = {name for (name,) in conn.execute("SELECT indexname FROM pg_indexes WHERE schemaname = 'public'")}
    found["constraint"] = {f"{table}.{name}" for table, name in conn.execute(
        "SELECT c.relname, k.conname FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid WHERE k.connamespace = 'public'::regnamespace")}
    found["trigger"] = {f"{table}.{name}" for table, name in conn.execute(
        "SELECT c.relname, t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid"
        " WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal")}
    return found


def render_manifest(found, rows, header=""):
    """The manifest text for ``found`` (a ``present_objects`` result) and ``rows`` (``{table: count}``): sorted, one fact per
    line, so ``parse_manifest`` of it gives back ``found``. The ledger table is not part of any file's objects."""
    lines = [f"# {line}" if line else "#" for line in header.splitlines()]
    for kind in ("table", "view"):
        for name in sorted(found[kind] - {"schema_migration"}):
            columns = sorted(entry.split(".", 1)[1] for entry in found["column"] if entry.startswith(name + "."))
            lines.append(f"{kind} {name} {' '.join(columns)}")
    lines += [f"function {name}" for name in sorted(found["function"])]
    lines += [f"index {name}" for name in sorted(found["index"] - {"schema_migration_pkey"})]
    for kind in ("constraint", "trigger"):
        lines += [f"{kind} {entry.replace('.', ' ', 1)}" for entry in sorted(found[kind]) if not entry.startswith("schema_migration.")]
    lines += [f"rows {table} {count}" for table, count in sorted(rows.items())]
    return "\n".join(lines) + "\n"


def row_counts(conn, tables):
    """``{table: rows}`` for the tables that exist (a missing table is simply absent)."""
    return {table: conn.execute(f'SELECT count(*) FROM "{table}"').fetchone()[0] for table in sorted(tables)
            if conn.execute("SELECT to_regclass(%s) IS NOT NULL", (table,)).fetchone()[0]}


def missing_objects(conn, manifest_text):
    """What a recorded file's manifest says the database should hold and does not: tables, views, columns, functions, indexes,
    constraints (primary, unique, check and foreign keys) and triggers by name, and the exact row count of each seeded table.
    Presence only: objects the manifest does not name are ignored, so production's harmless extras never block a deploy.
    api/tests/test_core_baseline.py proves each manifest equals what its file builds."""
    wanted = parse_manifest(manifest_text)
    found = present_objects(conn)
    missing = []
    for kind in ("table", "view", "column", "function", "index", "constraint", "trigger"):
        missing += [f"{kind} {name}" for name in sorted(wanted[kind] - found[kind])]
    counts = row_counts(conn, wanted["rows"])
    for table, expected in sorted(wanted["rows"].items()):
        if counts.get(table) != expected:
            missing.append(f"{expected} rows in {table} (has {counts.get(table, 'no such table')})")
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
    file the tracks record is not run: the objects and seed rows its manifest names must already exist (``missing_objects``) or the whole run stops and
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
                manifest = manifest_path(path)
                if not manifest.is_file():
                    raise MissingObjects(f"Refusing to record {name} without running it; {manifest.name} is missing beside it")
                missing = missing_objects(conn, manifest.read_text())
                if missing:
                    shown = ", ".join(missing[:12]) + (f" and {len(missing) - 12} more" if len(missing) > 12 else "")
                    raise MissingObjects(f"Refusing to record {name} without running it; the database lacks {shown}")
                announce(f"Recorded {name} without running it")
            else:
                conn.execute(path.read_text())
                announce(f"Applied {name}")
            conn.execute("INSERT INTO schema_migration (name) VALUES (%s)", (name,))
        added.append(name)
    return added
