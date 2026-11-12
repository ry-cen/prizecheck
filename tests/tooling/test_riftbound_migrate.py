"""DB-free wiring and plan proof; the disposable migration proof is api/tests/test_riftbound_migrate.py.

Neither suite settles IM-14's default multi-game test topology, separate-role permissions, cross-game isolation or hosting
readiness. The 16 omitted catalog foreign keys await Riftbound's catalog track; the schema remains incomplete.
"""
import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
import migration_tracks  # noqa: E402
from migration_tracks import Track  # noqa: E402


def load(filename):
    flag = sys.dont_write_bytecode
    spec = importlib.util.spec_from_file_location(filename, ROOT / "scripts" / f"{filename}.py")
    entry = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(entry)
    finally:
        sys.dont_write_bytecode = flag
    return entry


class RiftboundEntryTest(unittest.TestCase):
    def test_tracks_run_core_whole_then_riftbound_and_never_record_without_running(self):
        entry = load("migrate_riftbound")
        self.assertEqual(entry.TRACKS, (Track("core"), Track("riftbound")))
        self.assertEqual(migration_tracks.recorded_names(entry.TRACKS), set())
        plan = migration_tracks.planned(ROOT / "migrations", entry.TRACKS)
        self.assertEqual([name for name, _ in plan], [f"core/{path.name}" for path in sorted((ROOT / "migrations/core").glob("*.sql"))] + ["riftbound/001_catalog.sql", "riftbound/002_core_references.sql", "riftbound/003_set_codes.sql", "riftbound/004_writer_state.sql"])

    def test_each_entry_excludes_the_other_game_even_when_both_have_pending_files(self):
        pokemon, riftbound = load("migrate"), load("migrate_riftbound")
        with tempfile.TemporaryDirectory() as folder:
            tree = Path(folder)
            for name in ("001_pokemon.sql", "163_pokemon_tail.sql", "core/000_baseline.sql", "core/001_zip_centroids.sql",
                         "core/002_tail.sql", "riftbound/001_game.sql"):
                path = tree / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.touch()
            pokemon_plan = [name for name, _ in migration_tracks.planned(tree, pokemon.TRACKS)]
            riftbound_plan = [name for name, _ in migration_tracks.planned(tree, riftbound.TRACKS)]
        self.assertEqual(pokemon_plan, ["001_pokemon.sql", "core/000_baseline.sql", "core/001_zip_centroids.sql", "core/002_tail.sql", "163_pokemon_tail.sql"])
        self.assertEqual(riftbound_plan, ["core/000_baseline.sql", "core/001_zip_centroids.sql", "core/002_tail.sql", "riftbound/001_game.sql"])

    def test_missing_or_empty_own_setting_refuses_before_connect_even_with_database_url(self):
        entry = load("migrate_riftbound")
        for own in (None, ""):
            env = {"DATABASE_URL": "must-not-be-read"}
            if own is not None:
                env["RIFTBOUND_DATABASE_URL"] = own
            with mock.patch.dict(os.environ, env, clear=True), mock.patch.object(entry.psycopg, "connect") as connect:
                with self.assertRaisesRegex(SystemExit, "RIFTBOUND_DATABASE_URL must be set"):
                    entry.main()
                connect.assert_not_called()

    def test_main_reads_only_its_own_connection_setting_and_passes_its_explicit_tracks(self):
        entry = load("migrate_riftbound")
        env = mock.Mock()
        env.get.return_value = "riftbound-test-connection"
        with mock.patch.object(entry.os, "environ", env), mock.patch.object(entry.psycopg, "connect") as connect, \
                mock.patch.object(entry.migration_tracks, "apply") as apply:
            entry.main()
            self.assertEqual(env.mock_calls, [mock.call.get("RIFTBOUND_DATABASE_URL")])
            connect.assert_called_once_with("riftbound-test-connection")
            apply.assert_called_once_with(connect.return_value.__enter__.return_value, ROOT / "migrations", entry.TRACKS)


if __name__ == "__main__":
    unittest.main()
