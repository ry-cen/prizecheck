"""TCGplayer fallback art for Printings without a TCGdex image (ticket P7, design 4.8)."""
import json
import time
from uuid import uuid4

import pytest

from app import card_art, price_import
from app.art_urls import art_version
from app.catalog_targets import MATCHING  # noqa: F401  (imported so the rule tables exist in the schema under test)
from app.db import connect
from app.public_catalog import drain
from app.public_projection import FilePublicProjection, public_record_store
from app.public_records import catalog_printing_key
from test_catalog import reset_catalog
from test_catalog_search import client, headers, promote, search
from test_price_import import Tcgcsv, product, price

LOW = "https://tcgplayer-cdn.tcgplayer.com/product/{}_200w.jpg"
HIGH = "https://tcgplayer-cdn.tcgplayer.com/product/{}_400w.jpg"
NORMAL = {"type": "normal"}


@pytest.fixture(autouse=True)
def world(tmp_path, monkeypatch):
    monkeypatch.setenv("PUBLIC_PROJECTION_DIR", str(tmp_path))
    with FilePublicProjection().writer(initialize=True):
        pass
    public_record_store().initialize(deadline=time.monotonic() + 5)
    owner = f"owner-{uuid4()}"
    # card-1 has a TCGdex image, card-2 has none.
    promote({"card-1": "Pikachu", "card-2": "Raichu"})
    with connect() as conn:
        conn.execute("TRUNCATE tcgplayer_product, tcgplayer_price, price_import, catalog_printing_fallback_art RESTART IDENTITY")
        conn.execute("INSERT INTO inventory_owner(user_id) VALUES (%s)", (owner,))
        activation = conn.execute("""INSERT INTO catalog_rule_activation(kind,reviewer_id,evidence_url,reason,clock_revision)
          VALUES ('marketplace_matching',%s,'https://example.org/rule','Fixture activation',1) RETURNING id""",
                                  (owner,)).fetchone()["id"]
    yield activation
    with connect() as conn:
        conn.execute("TRUNCATE tcgplayer_product, tcgplayer_price, price_import, catalog_printing_fallback_art RESTART IDENTITY")


def printing(source_id):
    with connect() as conn:
        return conn.execute("SELECT id, public_ref FROM catalog_printing WHERE source_id=%s", (source_id,)).fetchone()


def add_edition(activation, source_id, descriptor, product_id, verified=True):
    pid = printing(source_id)["id"]
    with connect() as conn, conn.transaction():
        edition = conn.execute("INSERT INTO catalog_edition(printing_id,descriptor_key,descriptor) VALUES (%s,%s,%s) RETURNING id",
                               (pid, f"d-{uuid4()}", json.dumps(descriptor))).fetchone()["id"]
        if verified:
            conn.execute("""UPDATE catalog_edition_metadata SET mapping_state='verified',mapping_reason=NULL,product_id=%s,
              mapping_basis='matching_rule',matching_activation_id=%s,auto_closed=true,mapping_revision=mapping_revision+1
              WHERE edition_id=%s""", (product_id, activation, edition))
    return edition


def stock(product_id, images=1):
    with connect() as conn:
        conn.execute("""INSERT INTO tcgplayer_product(product_id,group_id,name,number,number_key,image_count,seen_at,source_updated_at)
          VALUES (%s,1,'Card','2','2',%s,now(),now()) ON CONFLICT (product_id) DO UPDATE SET image_count=EXCLUDED.image_count""",
                     (product_id, images))


def refresh():
    with connect() as conn:
        return card_art.refresh_fallbacks(conn)


def art(source_id):
    with connect() as conn:
        return conn.execute("SELECT a.* FROM catalog_printing_art a JOIN catalog_printing p ON p.id=a.printing_id "
                            "WHERE p.source_id=%s", (source_id,)).fetchone()


def chosen():
    with connect() as conn:
        return {r["source_id"]: r["product_id"] for r in conn.execute(
            "SELECT p.source_id, f.product_id FROM catalog_printing_fallback_art f JOIN catalog_printing p ON p.id=f.printing_id")}


def outbox(printing_id):
    with connect() as conn:
        return [r["revision"] for r in conn.execute("SELECT revision FROM catalog_public_outbox WHERE target_kind='printing' "
                                                    "AND target_id=%s ORDER BY revision", (printing_id,))]


def test_a_printing_with_a_verified_product_that_has_images_gets_both_cdn_sizes(world):
    stock(500)
    add_edition(world, "card-2", NORMAL, 500)
    assert refresh() == 1
    row = art("card-2")
    assert (row["low_image_url"], row["high_image_url"], row["tcgdex_url"]) == (LOW.format(500), HIGH.format(500), None)


def test_a_product_without_images_or_without_a_verified_edition_gives_no_art(world):
    stock(500, images=0)
    stock(501)
    add_edition(world, "card-2", NORMAL, 500)
    add_edition(world, "card-2", {"type": "holo"}, 501, verified=False)
    assert refresh() == 0
    row = art("card-2")
    assert (row["low_image_url"], row["high_image_url"]) == (None, None)


def test_an_edition_without_a_stamp_wins_then_the_lowest_product_id(world):
    for product_id in (300, 400, 500, 600):
        stock(product_id)
    add_edition(world, "card-2", {"type": "normal", "stamp": ["staff"]}, 300)
    add_edition(world, "card-2", {"type": "holo"}, 600)
    add_edition(world, "card-2", {"type": "reverse"}, 500)
    refresh()
    assert chosen() == {"card-2": 500}
    add_edition(world, "card-2", {"type": "holo", "foil": "cosmos"}, 400)
    refresh()
    assert chosen() == {"card-2": 400}


def test_only_stamped_candidates_choose_the_lowest_product_id(world):
    stock(300), stock(200)
    add_edition(world, "card-2", {"type": "normal", "stamp": ["staff"]}, 300)
    add_edition(world, "card-2", {"type": "holo", "stamp": ["prerelease"]}, 200)
    refresh()
    assert chosen() == {"card-2": 200}


def test_a_printing_with_a_tcgdex_image_never_gets_fallback_art(world):
    stock(500)
    add_edition(world, "card-1", NORMAL, 500)
    assert refresh() == 0
    assert art("card-1")["low_image_url"] == "https://assets.tcgdex.net/en/fixture/card-1/low.webp"


def test_a_new_generation_image_shows_at_once_and_the_next_refresh_drops_the_row(world):
    stock(500)
    add_edition(world, "card-2", NORMAL, 500)
    refresh()
    target = printing("card-2")["id"]
    before = outbox(target)
    with connect() as conn:
        conn.execute("UPDATE catalog_generation_printing SET image_url='https://assets.tcgdex.net/en/fixture/card-2' "
                     "WHERE printing_id=%s", (target,))
    assert art("card-2")["low_image_url"] == "https://assets.tcgdex.net/en/fixture/card-2/low.webp"
    assert refresh() == 0 and chosen() == {}
    assert outbox(target)[-1] > before[-1]


def test_changed_printings_are_enqueued_and_the_public_record_carries_the_fallback_url(world):
    stock(500)
    add_edition(world, "card-2", NORMAL, 500)
    target = printing("card-2")
    with connect() as conn:
        drain(conn)
    key = catalog_printing_key(target["public_ref"])
    assert public_record_store().read_records([key], deadline=time.monotonic() + 5).records[key].value["image_url"] is None
    before = outbox(target["id"])
    refresh()
    assert outbox(target["id"])[-1] > before[-1]
    with connect() as conn:
        drain(conn)
    assert public_record_store().read_records([key], deadline=time.monotonic() + 5).records[key].value["image_url"] == LOW.format(500)
    # A refresh that changes nothing enqueues nothing.
    after = outbox(target["id"])
    refresh()
    assert outbox(target["id"]) == after


def test_catalog_search_and_detail_serve_the_fallback_urls(world):
    stock(500)
    add_edition(world, "card-2", NORMAL, 500)
    refresh()
    found = search(name="Raichu").json()["printings"][0]
    # Signed-in reads get route URLs (ADR 0020), one version for both sizes; the view keeps the source URLs.
    version = art_version(LOW.format(500))
    assert (found["low_image_url"], found["high_image_url"]) == (
        f"/api/art/{found['id']}/small?v={version}", f"/api/art/{found['id']}/large?v={version}")
    assert (art("card-2")["low_image_url"], art("card-2")["high_image_url"]) == (LOW.format(500), HIGH.format(500))
    path = f'/api/catalog/printings/{found["id"]}'
    detail = client.get(path, headers=headers("catalog-reader", "GET", path)).json()["printing"]
    assert detail["high_image_url"] == f"/api/art/{found['id']}/large?v={version}"


def test_the_import_row_counts_the_fallback_table(world, monkeypatch):
    monkeypatch.setattr(price_import, "sleep", lambda seconds: None)
    fake = Tcgcsv()
    fake.products = {1: [product(701, "Raichu", "2", images=1), product(702, "Other", "3", images=0)], 2: []}
    fake.prices = {1: [price(701, "Normal", 1.5), price(702, "Normal", 1.0)], 2: []}
    add_edition(world, "card-2", NORMAL, 701)
    with connect(autocommit=True) as conn:
        price_import.run(conn, fake.client())
        row = conn.execute("SELECT fallback_art FROM price_import ORDER BY id DESC LIMIT 1").fetchone()
        total = conn.execute("SELECT count(*) AS n FROM catalog_printing_fallback_art").fetchone()["n"]
    assert row["fallback_art"] == total == 1


def test_a_failing_refresh_never_fails_the_import(world, monkeypatch):
    monkeypatch.setattr(price_import, "sleep", lambda seconds: None)
    monkeypatch.setattr(card_art, "refresh_fallbacks", lambda conn: 1 / 0)
    fake = Tcgcsv()
    with connect(autocommit=True) as conn:
        result = price_import.run(conn, fake.client())
        row = conn.execute("SELECT outcome, fallback_art FROM price_import ORDER BY id DESC LIMIT 1").fetchone()
    assert result.outcome == "imported" and row["outcome"] == "imported" and row["fallback_art"] is None
