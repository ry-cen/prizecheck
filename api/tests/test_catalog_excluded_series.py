"""Digital-only TCG Pocket cards are withdrawn from the catalog without touching inventory."""
import json
from uuid import uuid4

import pytest

from app.games.pokemon.catalog.catalog import CatalogError, claim_run, execute_run
from app.main import connect
from test_catalog import Source, reset_catalog
from test_catalog_search import search
from test_holdings import add, call
from test_moves import commit, leaf, selected, stage, start

PHYSICAL = [f"test-{n}" for n in range(1, 10)]


class PocketSource(Source):
    """A1-* cards belong to the Pocket set A1; the excluded attributes mirror TCGdexSource after enumerate."""

    def __init__(self, ids, excluded_ids=(), excluded_sets=None):
        super().__init__(ids=ids)
        self.excluded_ids = frozenset(excluded_ids)
        self.excluded_sets = frozenset({"A1"} if excluded_sets is None and excluded_ids else excluded_sets or ())

    def fetch(self, source_id):
        card = super().fetch(source_id)
        if source_id.startswith("A1-"):
            card.update(name="Bulbasaur", category="Pokemon", energyType=None,
                        set={"id": "A1", "name": "Genetic Apex"})
        return card


def run(source):
    with connect() as conn:
        run_id = conn.execute("INSERT INTO catalog_run DEFAULT VALUES RETURNING id").fetchone()["id"]
        conn.commit()
        assert claim_run(conn, run_id) == run_id
        execute_run(conn, run_id, source)
    return run_id


def pocket_state(printing):
    with connect() as conn:
        return conn.execute("""SELECT gp.tombstoned, bool_or(ge.active) AS any_active
          FROM catalog_state cs JOIN catalog_generation_printing gp ON gp.generation_id=cs.active_generation
          JOIN catalog_generation_edition ge ON ge.generation_id=gp.generation_id AND ge.printing_id=gp.printing_id
          WHERE gp.printing_id=%s GROUP BY gp.tombstoned""", (printing,)).fetchone()


def test_excluded_series_is_tombstoned_and_owned_copies_stay_movable():
    reset_catalog()
    run(PocketSource(PHYSICAL + ["A1-1"]))
    owner = f"collector-{uuid4()}"
    with connect() as conn:
        conn.execute("INSERT INTO inventory_owner(user_id) VALUES (%s)", (owner,))
        printing, edition = conn.execute("""SELECT p.id, e.id AS edition FROM catalog_printing p
          JOIN catalog_edition e ON e.printing_id=p.id WHERE p.source_id='A1-1'""").fetchone().values()
        # A maintainer-approved extra Edition on the Pocket Printing.
        generation = conn.execute("SELECT active_generation FROM catalog_state").fetchone()["active_generation"]
        approved = conn.execute("""INSERT INTO catalog_edition(printing_id,descriptor_key,descriptor)
          VALUES (%s,'stamped','{"stamp":"fixture"}') RETURNING id""", (printing,)).fetchone()["id"]
        conn.execute("INSERT INTO catalog_generation_edition(generation_id,edition_id,printing_id) VALUES (%s,%s,%s)",
                     (generation, approved, printing))
        report = conn.execute("""INSERT INTO missing_card_report(reporter_id,kind,status,printing_id,descriptor)
          VALUES (%s,'edition','approved',%s,'{"stamp":"fixture"}') RETURNING id""", (owner, printing)).fetchone()["id"]
        conn.execute("""INSERT INTO catalog_override(report_id,printing_id,edition_id,revision,reviewer_id,evidence_url,reason,action)
          VALUES (%s,%s,%s,%s,%s,'https://example.test/evidence','fixture','approve_edition')""",
                     (report, printing, approved, uuid4().int % 2**62, owner))
        review = conn.execute("""INSERT INTO catalog_review(printing_id,source_id,kind,source_fingerprint,detail,candidate)
          VALUES (%s,'A1-1','variant_ambiguity','fixture','fixture','{"fixture":true}') RETURNING *""", (printing,)).fetchone()
    binder = leaf(owner)
    added = add(owner, binder, str(edition), "2")
    assert added.status_code == 200, added.text
    assert search(name="Bulb").json()["printings"]

    # One of ten tcgdex Printings disappears: far over the 1% drop guard, but it is an excluded series.
    run(PocketSource(PHYSICAL, excluded_ids={"A1-1"}))
    assert pocket_state(printing) == {"tombstoned": True, "any_active": False}
    assert search(name="Bulb").json()["printings"] == []
    assert add(owner, binder, str(edition), "1").json()["detail"]["code"] == "EDITION_UNAVAILABLE"
    with connect() as conn:
        assert conn.execute("SELECT count(*) AS n FROM catalog_override WHERE edition_id=%s", (approved,)).fetchone()["n"] == 1
        # Pending reviews for the withdrawn source are left for a maintainer.
        assert conn.execute("SELECT * FROM catalog_review WHERE id=%s", (review["id"],)).fetchone() == review
    held = call("GET", f"/api/holdings/{binder}", owner).json()["holdings"]
    assert [(row["printing_name"], row["quantity"]) for row in held] == [("Bulbasaur", "2")]

    destination = leaf(owner, "Box")
    manifest = start(owner, binder)
    assert stage(owner, manifest, [selected(str(edition), 2, added.json()["version"])]).status_code == 200
    moved = commit(owner, manifest, destination)
    assert moved.status_code == 200, moved.text
    assert [row["quantity"] for row in call("GET", f"/api/holdings/{destination}", owner).json()["holdings"]] == ["2"]

    # Later imports keep the Pocket Printing withdrawn.
    run(PocketSource(PHYSICAL, excluded_ids={"A1-1"}))
    assert pocket_state(printing) == {"tombstoned": True, "any_active": False}


def test_unexcluded_drop_still_trips_the_guard():
    reset_catalog()
    run(PocketSource(PHYSICAL + ["A1-1"]))
    with pytest.raises(CatalogError, match="more than 1%"):
        run(PocketSource(PHYSICAL))
    # The exemption covers only the excluded IDs, not a physical card dropped beside them.
    with pytest.raises(CatalogError, match="more than 1%"):
        run(PocketSource(PHYSICAL[:-1], excluded_ids={"A1-1"}))


def test_excluded_series_record_outside_its_set_listing_fails_the_run():
    reset_catalog()
    first = run(PocketSource(PHYSICAL))
    with pytest.raises(CatalogError, match="Excluded-series record"):
        run(PocketSource(PHYSICAL + ["A1-1"], excluded_sets={"A1"}))
    with connect() as conn:
        assert conn.execute("SELECT active_generation FROM catalog_state").fetchone()["active_generation"] == first
