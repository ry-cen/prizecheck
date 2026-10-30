"""The scheduled catalog change check (app.games.pokemon.catalog.catalog_refresh) against a disposable PostgreSQL database.

TCGdex is a fake list (the fakes of test_catalog.py); the pull the check starts runs in process through a fake child whose
wait() claims the reserved run and executes it, like the detached importer would."""
import io
from unittest.mock import patch
from uuid import UUID, uuid4

import httpx
import pytest

from app.games.pokemon.catalog.catalog import CatalogError, TCGdexSource, claim_run, execute_run, user_agent
from app.games.pokemon.catalog.catalog_refresh import main, record_index, run_check
from app.games.pokemon.prices.catalog_targets import LIVE, MATCHING, activate_rule
from app.main import connect
from test_catalog import Source, reset_catalog
from test_catalog_excluded_series import PHYSICAL, PocketSource
from test_catalog_excluded_series import run as import_run

SEED = ("test-1", "test-2")


@pytest.fixture(autouse=True)
def active_rules():
    """Both catalog rules active, as the check requires; a test can clear them. Cleared again afterwards."""
    user = f"owner-{uuid4()}"
    with connect() as conn, conn.transaction():
        conn.execute("INSERT INTO inventory_owner(user_id) VALUES (%s)", (user,))
        for kind in (LIVE, MATCHING):
            activate_rule(conn, kind, 1, user, "https://example.org/rule", "Reviewed against the target")
    yield
    with connect() as conn:
        conn.execute("UPDATE catalog_rule_state SET activation_id=NULL")


class Listed(Source):
    """A TCGdex list (and, as the importer's source, a fetcher) with no excluded series."""
    excluded_ids = frozenset()


class Child:
    def __init__(self, action):
        self.action, self.waited = action, False

    def wait(self):
        self.waited = True
        self.action()
        return 0


def launcher(source=None, finish=True):
    """A stand-in for launch_import: the child imports `source` into the reserved run, or does nothing (finish=False)."""
    children = []

    def launch(run_id):
        def action():
            if not finish:
                return
            with connect() as conn:
                assert claim_run(conn, run_id) == run_id
                try:
                    execute_run(conn, run_id, source)
                except Exception:
                    pass  # recorded on the run row, like the detached importer
        children.append(Child(action))
        return children[-1]

    launch.children = children
    return launch


def seed(ids=SEED):
    reset_catalog()
    import_run(Listed(ids=ids))


def check(source, pull=None):
    """One check with `pull` as the launched importer; returns (exit code, stdout, the check row, launch stub)."""
    out, pull = io.StringIO(), pull or launcher(Listed(ids=("test-1", "test-2", "test-3")))
    with connect() as conn, patch("app.games.pokemon.catalog.catalog_dispatch.launch_import", pull):
        code = run_check(conn, source, out=out)
    with connect() as conn:
        row = conn.execute("SELECT * FROM catalog_check ORDER BY started_at DESC, id LIMIT 1").fetchone()
    return code, out.getvalue(), row, pull


def runs():
    with connect() as conn:
        return conn.execute("SELECT count(*) AS n FROM catalog_run").fetchone()["n"]


def run_row(run_id):
    with connect() as conn:
        return conn.execute("SELECT * FROM catalog_run WHERE id=%s", (run_id,)).fetchone()


def failing_pull():
    return launcher(Listed(ids=("test-1", "test-2", "test-3"), fail="test-3"))


def test_agreeing_lists_record_no_change_and_start_nothing():
    seed()
    before = runs()
    code, out, row, pull = check(Listed(ids=SEED))
    assert code == 0 and not pull.children and runs() == before
    assert out == f"catalog_check_id={row['id']}\n"
    assert (row["outcome"], row["new_count"], row["removed_count"], row["catalog_run_id"]) == ("no_change", 0, 0, None)
    assert row["finished_at"] is not None and row["started_at"] <= row["finished_at"]


@pytest.mark.parametrize("cleared", [LIVE, MATCHING])
def test_an_inactive_rule_fails_the_check_and_starts_nothing(cleared):
    seed()
    before = runs()
    with connect() as conn:
        conn.execute("UPDATE catalog_rule_state SET activation_id=NULL WHERE kind=%s", (cleared,))
    # Every id would look new against a catalog without its rules; the check must not start a pull on it.
    code, out, row, pull = check(Listed(ids=("test-1", "test-2", "test-3")))
    assert code == 2 and not pull.children and runs() == before
    assert out == f"catalog_check_id={row['id']}\n"
    assert (row["outcome"], row["error_code"], row["catalog_run_id"]) == ("failed", "CATALOG_RULES_INACTIVE", None)
    assert row["finished_at"] is not None


def test_both_rules_deactivated_fail_the_check():
    seed()
    with connect() as conn:
        conn.execute("UPDATE catalog_rule_state SET activation_id=NULL")
    code, _, row, pull = check(Listed(ids=SEED))
    assert code == 2 and not pull.children
    assert (row["outcome"], row["error_code"]) == ("failed", "CATALOG_RULES_INACTIVE")


def test_new_ids_start_a_pull_and_the_check_waits_for_it():
    seed()
    code, out, row, pull = check(Listed(ids=("test-1", "test-2", "test-3")))
    assert code == 0 and len(pull.children) == 1 and pull.children[0].waited
    assert (row["outcome"], row["new_count"], row["removed_count"], row["error_code"]) == ("pull_started", 1, 0, None)
    assert run_row(row["catalog_run_id"])["outcome"] == "succeeded" and row["finished_at"] is not None
    with connect() as conn:
        assert conn.execute("SELECT count(*) AS n FROM catalog_printing WHERE source_id='test-3'").fetchone()["n"] == 1


def test_ids_the_source_dropped_are_counted_as_removed():
    ids = [f"test-{n}" for n in range(1, 121)]
    seed(ids)
    # One of 120 stays under the importer's 1% drop guard.
    code, _, row, pull = check(Listed(ids=ids[:-1]), launcher(Listed(ids=ids[:-1])))
    assert code == 0
    assert (row["outcome"], row["new_count"], row["removed_count"]) == ("pull_started", 0, 1)
    with connect() as conn:
        assert conn.execute("""SELECT tombstoned FROM catalog_generation_printing gp JOIN catalog_state s
          ON s.active_generation=gp.generation_id WHERE gp.source_id='test-120'""").fetchone()["tombstoned"] is True


def test_excluded_tombstoned_and_manual_printings_never_count():
    reset_catalog()
    import_run(PocketSource(PHYSICAL + ["A1-1"]))
    import_run(PocketSource(PHYSICAL, excluded_ids={"A1-1"}))  # A1-1 is now tombstoned
    with connect() as conn:
        identity = conn.execute("INSERT INTO catalog_identity(identity_key,display_name) VALUES ('manual-key','Manual') RETURNING id").fetchone()["id"]
        manual = conn.execute("INSERT INTO catalog_printing(source,identity_id) VALUES ('manual',%s) RETURNING id", (identity,)).fetchone()["id"]
        conn.execute("""INSERT INTO catalog_generation_printing(generation_id,printing_id,source_id,set_id,set_name,collector_number,
          display_name,search_name,source_fingerprint,basic_energy) SELECT active_generation,%s,'manual-1','m','M','1','Manual',
          'manual','x','not_basic' FROM catalog_state""", (manual,))
    source = PocketSource(PHYSICAL, excluded_ids={"A1-1"})
    code, _, row, pull = check(source)
    assert code == 0 and not pull.children
    assert (row["outcome"], row["new_count"], row["removed_count"]) == ("no_change", 0, 0)
    # Even a catalog that still lists an excluded id does not read as removed.
    with connect() as conn:
        conn.execute("UPDATE catalog_generation_printing SET tombstoned=false WHERE source_id='A1-1'")
    assert check(source)[2]["outcome"] == "no_change"


def test_a_pull_already_running_is_recorded_and_nothing_starts():
    seed()
    with connect() as conn:
        active = conn.execute("INSERT INTO catalog_run DEFAULT VALUES RETURNING id").fetchone()["id"]
    before = runs()
    code, _, row, pull = check(Listed(ids=("test-1", "test-2", "test-3")))
    assert code == 0 and not pull.children and runs() == before
    assert (row["outcome"], row["new_count"], row["catalog_run_id"]) == ("pull_running", 1, None)
    assert run_row(active)["outcome"] is None


def test_a_promotion_committing_reads_as_pull_running():
    seed()
    with connect() as holder:
        holder.execute("SELECT pg_advisory_lock(914703)")
        try:
            code, _, row, pull = check(Listed(ids=("test-1", "test-2", "test-3")))
        finally:
            holder.execute("SELECT pg_advisory_unlock(914703)")
    assert code == 0 and not pull.children and row["outcome"] == "pull_running"


def test_a_generation_promoted_during_the_check_starts_no_redundant_pull():
    from app.games.pokemon.catalog.catalog_dispatch import dispatch_import_detailed
    seed()

    def promoted_first(*args, **kwargs):
        import_run(Listed(ids=("test-1", "test-2", "test-3")))  # an owner pull lands after the first comparison
        return dispatch_import_detailed(*args, **kwargs)

    before = runs()
    with patch("app.games.pokemon.catalog.catalog_refresh.dispatch_import_detailed", promoted_first):
        code, _, row, pull = check(Listed(ids=("test-1", "test-2", "test-3")))
    assert code == 0 and not pull.children and runs() == before + 1  # only the owner's run
    assert (row["outcome"], row["new_count"], row["removed_count"], row["catalog_run_id"]) == ("no_change", 0, 0, None)


def test_tcgdex_failure_and_invalid_lists_fail_without_a_run():
    seed()
    before = runs()

    class Broken(Listed):
        def __init__(self, error=None, ids=SEED):
            super().__init__(ids=ids)
            self.error = error

        def enumerate(self):
            if self.error:
                raise CatalogError(self.error)
            return set()

    for source, error_code in ((Broken("TCGdex request failed"), "TCGDEX_UNAVAILABLE"),
                               (Broken("Duplicate English source ID"), "TCGDEX_INVALID_LIST"),
                               (Broken("Invalid English source ID"), "TCGDEX_INVALID_LIST"),
                               (Broken(None), "TCGDEX_INVALID_LIST")):  # an empty list is not "everything removed"
        code, out, row, pull = check(source)
        assert code == 2 and not pull.children and runs() == before
        assert (row["outcome"], row["error_code"], row["catalog_run_id"]) == ("failed", error_code, None)
        assert out.startswith("catalog_check_id=")
    with connect() as conn:
        assert conn.execute("SELECT count(*) AS n FROM catalog_generation_printing WHERE NOT tombstoned").fetchone()["n"] == 2


def test_retries_are_bounded_and_requests_carry_the_user_agent(monkeypatch):
    seed()
    monkeypatch.setenv("SCANNER_INDEX_CONTACT", "ops@example.test")
    seen = []

    def handler(request):
        seen.append(request)
        return httpx.Response(503)

    source = TCGdexSource(attempts=3, max_backoff=1)
    source.client = httpx.Client(transport=httpx.MockTransport(handler), headers=source.client.headers)
    with patch("app.games.pokemon.catalog.catalog.time.sleep") as sleep:
        code, _, row, pull = check(source)
    assert code == 2 and row["error_code"] == "TCGDEX_UNAVAILABLE" and not pull.children
    assert len(seen) == 3 and sleep.call_count == 2
    assert {request.headers["user-agent"] for request in seen} == {"PrizeCheck-catalog/1 (+ops@example.test)"}


def test_user_agent_contact_falls_back_to_the_owner_email(monkeypatch):
    monkeypatch.delenv("SCANNER_INDEX_CONTACT", raising=False)
    monkeypatch.setenv("OWNER_EMAIL", "owner@example.test")
    assert user_agent() == "PrizeCheck-catalog/1 (+owner@example.test)"
    assert TCGdexSource().client.headers["user-agent"] == user_agent()
    monkeypatch.setenv("SCANNER_INDEX_CONTACT", "ops@example.test")
    assert user_agent() == "PrizeCheck-catalog/1 (+ops@example.test)"


def test_a_failed_pull_exits_4_and_the_next_check_starts_again():
    seed()
    wanted = Listed(ids=("test-1", "test-2", "test-3"))
    code, _, row, pull = check(wanted, failing_pull())
    assert code == 4 and pull.children[0].waited
    assert (row["outcome"], row["error_code"]) == ("pull_started", "CATALOG_PULL_FAILED")
    assert run_row(row["catalog_run_id"])["outcome"] == "failed"
    assert run_row(row["catalog_run_id"])["error"] == "TCGdex request failed"  # the sentence stays on the run
    code, _, again, _ = check(wanted, failing_pull())
    assert code == 4 and again["catalog_run_id"] != row["catalog_run_id"]


def test_the_drop_guard_failure_is_a_failed_pull():
    ids = [f"test-{n}" for n in range(1, 11)]
    seed(ids)
    code, _, row, _ = check(Listed(ids=ids[:5]), launcher(Listed(ids=ids[:5])))
    assert code == 4 and row["error_code"] == "CATALOG_PULL_FAILED"
    assert "more than 1%" in run_row(row["catalog_run_id"])["error"]


def test_a_child_that_exits_without_finishing_its_run_is_interrupted():
    seed()
    code, _, row, pull = check(Listed(ids=("test-1", "test-2", "test-3")), launcher(finish=False))
    assert code == 4 and row["error_code"] == "CATALOG_PULL_INTERRUPTED"
    assert run_row(row["catalog_run_id"])["outcome"] == "failed"


def test_a_launch_failure_is_a_failed_pull_that_stays_attributable():
    seed()

    def broken(run_id):
        raise OSError("secret credential")

    code, _, row, _ = check(Listed(ids=("test-1", "test-2", "test-3")), broken)
    assert code == 4 and (row["outcome"], row["error_code"]) == ("pull_started", "CATALOG_DISPATCH_FAILED")
    assert run_row(row["catalog_run_id"])["error"] == "CATALOG_DISPATCH_FAILED"
    assert "secret" not in str(row)


def test_three_failed_check_pulls_pause_and_a_success_clears_the_pause():
    seed()
    wanted = Listed(ids=("test-1", "test-2", "test-3"))
    for _ in range(3):
        assert check(wanted, failing_pull())[0] == 4
    before = runs()
    code, _, row, pull = check(wanted)
    assert code == 0 and not pull.children and runs() == before
    assert (row["outcome"], row["error_code"], row["catalog_run_id"]) == ("paused", "CATALOG_PULL_FAILED", None)
    # An owner-started failure changes nothing; an owner-started success clears the pause.
    with connect() as conn:
        conn.execute("INSERT INTO catalog_run(phase,outcome,error,finished_at) VALUES ('failed','failed','owner failure',now())")
    assert check(wanted)[2]["outcome"] == "paused"
    import_run(Listed(ids=("test-1", "test-2", "test-3")))
    code, _, row, _ = check(Listed(ids=("test-1", "test-2", "test-3", "test-4")), launcher(Listed(ids=("test-1", "test-2", "test-3", "test-4"))))
    assert code == 0 and row["outcome"] == "pull_started"


def test_a_check_started_success_clears_the_count():
    seed()
    wanted = Listed(ids=("test-1", "test-2", "test-3"))
    for _ in range(2):
        assert check(wanted, failing_pull())[0] == 4
    assert check(wanted)[0] == 0  # the third pull succeeds (and so clears the two failures)
    wider = Listed(ids=("test-1", "test-2", "test-3", "test-4"))
    for _ in range(2):
        code, _, row, _ = check(wider, launcher(Listed(ids=wider.ids, fail="test-4")))
        assert code == 4 and row["outcome"] == "pull_started"
    code, _, row, _ = check(wider, launcher(Listed(ids=wider.ids, fail="test-4")))
    assert code == 4 and row["outcome"] == "pull_started"  # only now is it the third failure since the success
    assert check(wider)[2]["outcome"] == "paused"


def test_an_owner_failure_does_not_count_toward_the_pause():
    seed()
    wanted = Listed(ids=("test-1", "test-2", "test-3"))
    for _ in range(2):
        assert check(wanted, failing_pull())[0] == 4
    with connect() as conn:
        conn.execute("INSERT INTO catalog_run(phase,outcome,error,finished_at) VALUES ('failed','failed','owner failure',now())")
    assert check(wanted, failing_pull())[2]["outcome"] == "pull_started"


def test_a_changed_existing_card_still_goes_to_review():
    seed()

    class Ambiguous(Listed):
        def fetch(self, source_id):
            card = super().fetch(source_id)
            if source_id == "test-2":
                card["variants"] = {"normal": True, "firstEdition": True}
            return card

    ids = ("test-1", "test-2", "test-3")
    assert check(Listed(ids=ids), launcher(Ambiguous(ids=ids)))[0] == 0
    with connect() as conn:
        assert conn.execute("SELECT count(*) AS n FROM catalog_review WHERE kind='variant_ambiguity'").fetchone()["n"] == 1


def test_record_index_writes_the_exit_code_on_the_check_row(capsys):
    seed()
    row = check(Listed(ids=SEED))[2]
    assert main(["--record-index", str(row["id"]), "3"]) == 0
    with connect() as conn:
        assert conn.execute("SELECT index_exit_code FROM catalog_check WHERE id=%s", (row["id"],)).fetchone()["index_exit_code"] == 3
        assert record_index(conn, uuid4(), 0) == 1
    with pytest.raises(SystemExit):
        main(["--record-index", "not-a-uuid", "0"])
    with pytest.raises(SystemExit):
        main(["--record-index", str(row["id"]), "300"])
    assert capsys.readouterr().out == ""  # logs go to stderr, stdout only carries the check id line


def test_the_check_row_is_unfinished_until_the_check_ends():
    seed()
    seen = {}

    class Peek(Listed):
        def enumerate(self):
            with connect() as conn:
                seen["row"] = conn.execute("SELECT outcome, finished_at FROM catalog_check").fetchone()
            return super().enumerate()

    check(Peek(ids=SEED))
    assert seen["row"] == {"outcome": None, "finished_at": None}


def unfinished_check_run(lease="-1 minute"):
    """A check-started run left unfinished with an expired lease (its check's container died)."""
    with connect() as conn:
        run_id = conn.execute("""INSERT INTO catalog_run(phase,started_at,lease_until) VALUES
          ('fetching',now(),now()+%s::interval) RETURNING id""", (lease,)).fetchone()["id"]
        conn.execute("INSERT INTO catalog_check(outcome,catalog_run_id,finished_at) VALUES ('pull_started',%s,NULL)", (run_id,))
    return run_id


def test_an_unfinished_run_counts_only_when_no_live_runner_holds_the_lock():
    from app.games.pokemon.catalog.catalog_refresh import pause_failures
    seed()
    run_id = unfinished_check_run()
    with connect() as holder, connect() as conn:
        holder.execute("SELECT pg_advisory_lock(914703)")
        try:
            assert pause_failures(conn) == []  # a runner is alive: an expired lease alone is not a failure
        finally:
            holder.execute("SELECT pg_advisory_unlock(914703)")
        assert [row["id"] for row in pause_failures(conn)] == [run_id]
    # A healthy lease never counts either.
    seed()
    unfinished_check_run(lease="+1 minute")
    with connect() as conn:
        assert pause_failures(conn) == []


def test_a_check_row_rewritten_to_failed_still_counts_toward_the_pause():
    from app.games.pokemon.catalog.catalog_refresh import pause_failures
    seed()
    with connect() as conn:
        run_id = conn.execute("""INSERT INTO catalog_run(phase,outcome,error,finished_at) VALUES
          ('failed','failed','boom',now()) RETURNING id""").fetchone()["id"]
        conn.execute("INSERT INTO catalog_check(outcome,catalog_run_id,finished_at,error_code) VALUES ('failed',%s,now(),'CATALOG_CHECK_ERROR')", (run_id,))
        assert [row["id"] for row in pause_failures(conn)] == [run_id]


def test_an_unexpected_error_records_catalog_check_error_and_exits_2():
    seed()

    def explode(*args, **kwargs):
        raise RuntimeError("payload fragment")

    with patch("app.games.pokemon.catalog.catalog_refresh.dispatch_import_detailed", explode):
        code, out, row, pull = check(Listed(ids=("test-1", "test-2", "test-3")))
    assert code == 2 and not pull.children and out.startswith("catalog_check_id=")
    assert (row["outcome"], row["error_code"]) == ("failed", "CATALOG_CHECK_ERROR")
    assert "payload" not in str(row)


def test_a_failing_on_reserved_keeps_the_check_attributable_to_the_run(monkeypatch):
    seed()
    from app.games.pokemon.catalog import catalog_dispatch
    real = catalog_dispatch.dispatch_import_detailed

    def failing_reservation(conn, on_reserved=None, guard=None):
        def broken(c, run_id):
            on_reserved(c, run_id)
            raise RuntimeError("after the association")
        return real(conn, on_reserved=broken, guard=guard)

    with patch("app.games.pokemon.catalog.catalog_refresh.dispatch_import_detailed", failing_reservation):
        code, _, row, pull = check(Listed(ids=("test-1", "test-2", "test-3")))
    assert code == 4 and not pull.children
    assert (row["outcome"], row["error_code"]) == ("pull_started", "CATALOG_DISPATCH_FAILED")
    assert row["catalog_run_id"] is not None and run_row(row["catalog_run_id"])["outcome"] == "failed"


def test_the_check_builds_its_source_with_the_bounded_retry_budget():
    from app.games.pokemon.catalog.catalog_refresh import CHECK_ATTEMPTS, CHECK_MAX_BACKOFF
    seed()
    with patch("app.games.pokemon.catalog.catalog_refresh.TCGdexSource", return_value=Listed(ids=SEED)) as factory:
        out = io.StringIO()
        with connect() as conn:
            assert run_check(conn, out=out) == 0
    factory.assert_called_once_with(attempts=CHECK_ATTEMPTS, max_backoff=CHECK_MAX_BACKOFF)
    assert CHECK_ATTEMPTS < 12


@pytest.mark.parametrize("body", ["[]", '[{"id": "test-1"}, {"id": "test-1"}]'])
def test_an_empty_or_duplicate_json_list_fails_the_check(body):
    seed()
    source = TCGdexSource(attempts=3, max_backoff=1)
    source.client = httpx.Client(transport=httpx.MockTransport(lambda request: httpx.Response(200, content=body)))
    before = runs()
    code, _, row, pull = check(source)
    assert code == 2 and not pull.children and runs() == before
    assert (row["outcome"], row["error_code"]) == ("failed", "TCGDEX_INVALID_LIST")


def test_a_stopped_pull_and_two_failures_pause_with_the_interrupted_code():
    seed()
    wanted = Listed(ids=("test-1", "test-2", "test-3"))
    for _ in range(2):
        assert check(wanted, failing_pull())[0] == 4
    stopped = unfinished_check_run()  # a deploy stopped this one's container: unfinished, expired, nobody holds the lock
    before = runs()
    code, _, row, pull = check(wanted)
    assert code == 0 and not pull.children and runs() == before
    assert (row["outcome"], row["error_code"], row["catalog_run_id"]) == ("paused", "CATALOG_PULL_INTERRUPTED", None)
    assert run_row(stopped)["outcome"] is None


def test_a_stopped_pull_is_marked_interrupted_and_the_next_check_starts_a_new_one():
    seed()
    stopped = unfinished_check_run()
    code, _, row, pull = check(Listed(ids=("test-1", "test-2", "test-3")))
    assert code == 0 and len(pull.children) == 1
    old = run_row(stopped)
    assert (old["outcome"], old["error"]) == ("failed", "Catalog import interrupted; start a new pull")
    assert row["outcome"] == "pull_started" and row["catalog_run_id"] != stopped
    assert run_row(row["catalog_run_id"])["outcome"] == "succeeded"


def test_a_run_that_finishes_while_it_is_being_marked_interrupted_keeps_its_real_outcome():
    from app.games.pokemon.catalog.catalog_refresh import _wait_for_pull
    seed()
    with connect() as conn:
        run_id = conn.execute("INSERT INTO catalog_run(phase) VALUES ('promoting') RETURNING id").fetchone()["id"]

    class Racing:
        """Lets the run succeed (on another connection) just before the interrupted-mark UPDATE."""
        def __init__(self, conn):
            self.conn = conn

        def execute(self, sql, *args):
            if sql.lstrip().startswith("UPDATE catalog_run"):
                with connect() as other:
                    other.execute("UPDATE catalog_run SET phase='complete',outcome='succeeded',finished_at=now() WHERE id=%s", (run_id,))
            return self.conn.execute(sql, *args)

        def __getattr__(self, name):
            return getattr(self.conn, name)

    with connect() as conn:
        assert _wait_for_pull(Racing(conn), run_id, None) == ("succeeded", None)
    assert run_row(run_id)["outcome"] == "succeeded" and run_row(run_id)["error"] is None
