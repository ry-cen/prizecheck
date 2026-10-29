"""The printed set code in the catalog (WP-C1): ``catalog_set_code`` holds exactly the rows of set_codes.tsv, and the view
``catalog_printing_set_code`` gives every Printing ``set_codes.code_for(coalesce(pd.set_id, ''))`` once."""
from uuid import uuid4

from app.games.pokemon.catalog import set_codes
from app.main import connect
from want_list_swap_fixtures import seed_swap_catalog


def view_rows(conn):
    return conn.execute("""SELECT v.printing_id, pd.set_id, v.set_code FROM catalog_printing_set_code v
      LEFT JOIN catalog_printing_display pd ON pd.printing_id = v.printing_id""").fetchall()


def test_the_table_equals_the_tsv_exactly():
    with connect() as conn:
        rows = conn.execute("SELECT set_id, code FROM catalog_set_code").fetchall()
    assert len(rows) == len(set_codes.CODES)
    assert {row["set_id"]: row["code"] for row in rows} == set_codes.CODES


def test_the_view_has_one_row_per_printing_with_the_code_every_reader_computes():
    seed_swap_catalog()
    with connect() as conn:
        printings = conn.execute("SELECT count(*) AS n FROM catalog_printing").fetchone()["n"]
        rows = view_rows(conn)
    assert printings > 0 and len(rows) == printings == len({row["printing_id"] for row in rows})
    for row in rows:
        assert row["set_code"] == set_codes.code_for(row["set_id"] or ""), row
    assert {"PAL", "sve"} <= {row["set_code"] for row in rows}


def test_an_unmapped_set_and_a_printing_without_display_data_fall_back_as_code_for_does():
    assert set_codes.code_for("fixture") == "fixture"
    identity, mapped, unmapped, bare = (uuid4() for _ in range(4))
    with connect() as conn:
        conn.execute("INSERT INTO catalog_identity(id, identity_key, display_name) VALUES (%s, %s, 'Set code card')",
                     (identity, f"set-code-{identity}"))
        for printing in (mapped, unmapped, bare):
            conn.execute("INSERT INTO catalog_printing(id, source, source_id, identity_id) VALUES (%s, 'tcgdex', %s, %s)",
                         (printing, f"set-code-{printing}", identity))
        for printing, set_id in ((mapped, "sv02"), (unmapped, "fixture")):
            conn.execute("""INSERT INTO catalog_printing_display(printing_id, display_name, set_id, set_name, collector_number)
              VALUES (%s, 'Set code card', %s, 'Set', '1')""", (printing, set_id))
        try:
            got = {row["printing_id"]: row["set_code"] for row in view_rows(conn)}
            assert (got[mapped], got[unmapped], got[bare]) == ("PAL", "fixture", "")
        finally:
            conn.execute("DELETE FROM catalog_printing WHERE identity_id = %s", (identity,))
            conn.execute("DELETE FROM catalog_identity WHERE id = %s", (identity,))
