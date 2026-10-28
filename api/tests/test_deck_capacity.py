"""Deck capacity (ticket 15): one large Deck priced and exported privately and publicly, at the signed HTTP seam.

The gate runs a 1,000-distinct-Edition Deck, far beyond a playable 60-card Deck. The private cost reads its quotes through
the HTTP records relay; publication, the public cost and the public exports use the filesystem adapter over the same
records directory. The gateway-level capacity proof (100 simultaneous callers on two gateways and two APIs) is in
auth/tests/published-cost.test.ts.
"""
from decimal import Decimal
import json
import os
import time
from pathlib import Path
from uuid import uuid4

import psycopg
import pytest

from app.main import app, connect  # noqa: F401
from app import price_launcher, public_catalog
from app.catalog_targets import LIVE, activate_rule
from app.public_projection import FilePublicProjection
from app.public_records import public_record_store
from test_catalog import reset_catalog
from test_catalog_targets import isolated_rules  # noqa: F401  (autouse: clears rule activations)
from test_decks import create
from test_holdings import call, client
from test_prices import headers_for
from test_public_records import start_relay, stop
from test_publications import command

ANON = "anon:" + "c4" * 16
PRICE = Decimal("0.25")


@pytest.fixture(autouse=True)
def store(tmp_path, monkeypatch):
    monkeypatch.setenv("PUBLIC_PROJECTION_DIR", str(tmp_path))
    monkeypatch.setenv("PUBLIC_PROJECTION_ADAPTER", "filesystem")
    with FilePublicProjection().writer(initialize=True):
        pass
    public_record_store().initialize(deadline=time.monotonic() + 5)
    return public_record_store()


@pytest.fixture(autouse=True)
def launches(monkeypatch):
    """No runner is ever started: every row is seeded fresh, so admission has nothing to launch."""
    calls = []
    monkeypatch.setattr(price_launcher, "spawn", lambda slot, owner: calls.append((slot, owner)) or True)
    return calls


def capacity_world(count, owner):
    """``count`` Printings with one verified, Live-eligible Edition each, written set-based (the importer is too slow).

    Edition n (1-based) has its own product and Live identity. Returns the rows in n order, each with its Deck List
    quantity 1 + n % 3 and its held quantity: one copy fewer for every fourth Edition, so those lines each have one copy
    not owned (none of them is held anywhere else)."""
    reset_catalog()
    with connect() as conn:
        conn.execute("INSERT INTO inventory_owner(user_id) VALUES (%s) ON CONFLICT DO NOTHING", (owner,))
        conn.execute("INSERT INTO owner_binding(singleton,user_id) VALUES (true,%s)", (owner,))
    with connect() as conn, conn.transaction():
        activate_rule(conn, LIVE, 1, owner, "https://example.org/rule", "Reviewed against the target")
        live = conn.execute("SELECT activation_id FROM catalog_rule_state WHERE kind='live_derivation'").fetchone()["activation_id"]
        matching = conn.execute("""INSERT INTO catalog_rule_activation(kind,reviewer_id,evidence_url,reason,clock_revision)
          VALUES ('marketplace_matching',%s,'https://example.org/rule','Fixture activation',1) RETURNING id""",
                                (owner,)).fetchone()["id"]
        generation = uuid4()
        conn.execute("""CREATE TEMP TABLE capacity ON COMMIT DROP AS SELECT n, gen_random_uuid() AS identity_id,
          gen_random_uuid() AS printing_id, gen_random_uuid() AS edition_id FROM generate_series(1,%s) n""", (count,))
        conn.execute("""INSERT INTO catalog_identity(id,identity_key,display_name)
          SELECT identity_id,'capacity-'||identity_id,'Capacity Card '||lpad(n::text,5,'0') FROM capacity""")
        conn.execute("""INSERT INTO catalog_printing(id,source,source_id,identity_id)
          SELECT printing_id,'tcgdex','capacity-'||printing_id,identity_id FROM capacity""")
        conn.execute("INSERT INTO catalog_generation(id,source_count,raw_gzip,raw_sha256) VALUES (%s,1,%s,'test')",
                     (generation, b"test"))
        conn.execute("""INSERT INTO catalog_generation_printing(generation_id,printing_id,source_id,set_id,set_name,collector_number,
          display_name,search_name,source_fingerprint,basic_energy,tombstoned)
          SELECT %s,printing_id,'capacity-'||printing_id,'capacity','Capacity Set',n::text,'Capacity Card '||lpad(n::text,5,'0'),
            'capacity card '||n,'seed','not_basic',false FROM capacity""", (generation,))
        conn.execute("""INSERT INTO catalog_edition(id,printing_id,descriptor_key,descriptor)
          SELECT edition_id,printing_id,'normal','{"finish":"normal"}'::jsonb FROM capacity""")
        conn.execute("""INSERT INTO catalog_generation_edition(generation_id,edition_id,printing_id)
          SELECT %s,edition_id,printing_id FROM capacity""", (generation,))
        conn.execute("UPDATE catalog_state SET active_generation=%s,revision=revision+1 WHERE singleton", (generation,))
        conn.execute("""UPDATE catalog_edition_metadata m SET mapping_state='verified',mapping_reason=NULL,product_id=900000+c.n,
          quote_variant='normal',mapping_basis='matching_rule',matching_activation_id=%s,auto_closed=true
          FROM capacity c WHERE m.edition_id=c.edition_id""", (matching,))
        conn.execute("""UPDATE catalog_printing_metadata m SET live_state='eligible',live_reason=NULL,live_basis='rule',
          live_identity=jsonb_build_object('category','Pokemon','name','Capacity Card '||lpad(c.n::text,5,'0'),'set_code','CAP',
            'number',c.n::text),live_activation_id=%s,live_auto_closed=true
          FROM capacity c WHERE m.printing_id=c.printing_id""", (live,))
        rows = conn.execute("""SELECT c.n,c.edition_id AS id,e.public_ref,m.mapping_revision,'capacity-'||c.printing_id AS source_id
          FROM capacity c JOIN catalog_edition e ON e.id=c.edition_id JOIN catalog_edition_metadata m ON m.edition_id=c.edition_id
          ORDER BY c.n""").fetchall()
    return [{**row, "quantity": 1 + row["n"] % 3, "held": 1 + row["n"] % 3 - (row["n"] % 4 == 0)} for row in rows]


def seed_price_rows(editions):
    """The private readers' data: a $0.25 market price and a binding for every Edition but each tenth, which is bound to a
    product that has no price row. Set-based."""
    priced = [edition for edition in editions if edition["n"] % 10 != 0]
    with connect() as conn, conn.transaction():
        conn.execute("DELETE FROM tcgplayer_price")
        conn.execute("""INSERT INTO tcgplayer_price(product_id,sub_type_name,market_price,seen_at,source_updated_at)
          SELECT 900000+n,'Normal',%s,now(),now()-interval '1 day' FROM unnest(%s::int[]) n""",
                     (PRICE, [edition["n"] for edition in priced]))
        conn.execute("""INSERT INTO edition_price_binding(edition_id,product_id,mapping_revision,sub_type_name)
          SELECT id,900000+n,rev,'Normal' FROM unnest(%s::uuid[],%s::int[],%s::bigint[]) AS t(id,n,rev)
          ON CONFLICT (edition_id) DO UPDATE SET product_id=EXCLUDED.product_id,mapping_revision=EXCLUDED.mapping_revision,
            sub_type_name='Normal',reason=NULL""",
                     ([e["id"] for e in editions], [e["n"] for e in editions], [e["mapping_revision"] for e in editions]))


def seed_quotes(store, editions):
    """The PostgreSQL half (the private readers), then the public ``price:`` records the Published Deck readers read, published
    against the test's store. Every tenth Edition has no market price, so it stays unpriced."""
    from app.public_prices import publish
    seed_price_rows(editions)
    with connect() as conn:
        publish(conn, store)


def timed(function):
    started = time.monotonic()
    value = function()
    return value, round(time.monotonic() - started, 3)


def directory_bytes(path):
    return sum(item.stat().st_size for item in Path(path).rglob("*") if item.is_file())


def anonymous(path):
    """A public call with PostgreSQL forbidden, signed as the gateway signs an anonymous caller's budget."""
    def forbidden(*args, **kwargs):
        raise AssertionError("a public route opened a PostgreSQL connection")
    headers = headers_for(b"", method="GET", path=path, user=None, caller=ANON)
    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(psycopg, "connect", forbidden)
        patch.setenv("DATABASE_URL", "postgresql://unreachable:1/private")
        return client.get(path, headers=headers)


def counted(body, total, priced, amount, *, complete, public=False):
    """Every copy is counted. ``complete`` demands the exact numeric answer; otherwise an answer may instead be the
    labelled incomplete one, with no coverage and no amount (and the total withheld only by a failed final check).
    ``public`` is a Published Deck's cost, which sends no price age."""
    if complete or body["status"] != "incomplete":
        assert (body["status"], body["total_copies"], body["priced_copies"], body["amount"]) == \
            ("priced", str(total), str(priced), format(amount.normalize(), "f")), body
        if public:
            # No price age is sent publicly (#183): the age and cached-fallback counts stay private.
            assert not {"stale_copies", "unknown_age_copies", "fallback_copies"} & set(body), body
        else:
            assert (body["stale_copies"], body["unknown_age_copies"], body["fallback_copies"]) == ("0", "0", "0"), body
    else:
        assert body["reason"] in ("deadline", "store_unavailable", "validation_unavailable"), body
        assert (body["priced_copies"], body["amount"], body["display_amount"]) == (None, None, None), body
        assert body["total_copies"] in (str(total), None), body
    return [body["status"], body["reason"]]


def exercise(count, store, tmp_path, monkeypatch, *, complete, accesses):
    """Builds, prices and exports one ``count``-Edition Deck, asserting every copy is counted; returns the measurements."""
    owner = f"capacity-{uuid4()}"
    editions, build = timed(lambda: capacity_world(count, owner))
    deck = create(owner).json()["location"]["id"]
    with connect() as conn, conn.transaction():
        conn.execute("""INSERT INTO holding(owner_id,location_id,edition_id,quantity,version)
          SELECT %s,%s,q.id,q.quantity,1 FROM unnest(%s::uuid[],%s::bigint[]) AS q(id,quantity)""",
                     (owner, deck, [e["id"] for e in editions if e["held"]], [e["held"] for e in editions if e["held"]]))
        conn.execute("UPDATE inventory_owner SET revision=revision+1 WHERE user_id=%s", (owner,))
        # The Deck List lines, above the Holdings that already extended it. Publication freezes these lines.
        conn.execute("""INSERT INTO deck_list_line(owner_id,deck_id,edition_id,quantity)
          SELECT %s,%s,q.id,q.quantity FROM unnest(%s::uuid[],%s::bigint[]) AS q(id,quantity)
          ON CONFLICT (owner_id,deck_id,edition_id) DO UPDATE SET quantity=EXCLUDED.quantity""",
                     (owner, deck, [e["id"] for e in editions], [e["quantity"] for e in editions]))
        conn.execute("UPDATE deck_list SET revision=revision+1 WHERE owner_id=%s AND deck_id=%s", (owner, deck))
    with connect() as conn:
        delivered, deliver = timed(lambda: public_catalog.drain(conn))
    assert delivered.state == "delivered", delivered
    _, seeding = timed(lambda: seed_quotes(store, editions))
    total = sum(e["quantity"] for e in editions)
    priced = sum(e["quantity"] for e in editions if e["n"] % 10)
    amount = PRICE * priced
    # The top-level figures cost the Holdings; deck_list_cost every line; cost_to_complete the not-owned copies.
    held = sum(e["held"] for e in editions)
    held_priced = sum(e["held"] for e in editions if e["n"] % 10)
    missing = sum(e["quantity"] - e["held"] for e in editions)
    missing_priced = sum(e["quantity"] - e["held"] for e in editions if e["n"] % 10)

    # Private cost: its quotes are read through the HTTP records relay over the same directory.
    private = []
    relay, url = start_relay({"adapter": "filesystem", "directory": str(tmp_path)})
    try:
        with monkeypatch.context() as patch:
            patch.setenv("PUBLIC_PROJECTION_ADAPTER", "http")
            patch.setenv("PUBLIC_PROJECTION_URL", url)
            patch.setenv("PUBLIC_PROJECTION_TOKEN", "conformance-secret")
            path = f"/api/decks/{deck}/cost"
            for _ in range(accesses):
                response, seconds = timed(lambda: client.get(path, headers=headers_for(b"", method="GET", path=path, user=owner)))
                assert response.status_code == 200, response.text
                body = response.json()
                private.append(counted(body, held, held_priced, PRICE * held_priced, complete=complete)
                               + counted(body["deck_list_cost"], total, priced, amount, complete=complete)
                               + counted(body["cost_to_complete"], missing, missing_priced, PRICE * missing_priced,
                                         complete=complete) + [seconds])
    finally:
        stop(relay)

    live, private_live = timed(lambda: call("GET", f"/api/decks/{deck}/exports/live", owner))
    assert live.status_code == 200, live.text
    live = live.json()
    assert (live["status"], live["total_copies"], live["blockers"]) == ("ok", str(total), [])
    live_text = live["text"] if live["inline"] else call(
        "GET", f"/api/decks/{deck}/exports/live.txt?owner_revision={live['owner_revision']}", owner).text
    lines = live_text.split("\n")
    assert lines[0] == f"Pokémon: {total}" and len(lines) == count + 1 and len(live_text.encode()) == live["byte_length"]

    mass, private_mass = timed(lambda: call("GET", f"/api/decks/{deck}/exports/tcgplayer?scope=deck_list", owner))
    assert mass.status_code == 200, mass.text
    mass = mass.json()
    assert (mass["status"], mass["url"], mass["fallback_reason"], mass["line_count"], mass["total_copies"]) == \
        ("text", None, "encoded_length", count, str(total))
    mass_text = mass["text"] if mass["inline"] else call(
        "GET", f"/api/decks/{deck}/exports/tcgplayer.txt?owner_revision={mass['owner_revision']}&scope=deck_list", owner).text
    assert sum(int(line.split(" ", 1)[0]) for line in mass_text.split("\n")) == total

    published, publish = timed(lambda: command(owner, deck))
    assert published.status_code == 200, published.text
    base = f"/api/public/decks/{published.json()['token']}/versions/1"
    public = []
    for _ in range(accesses):
        response, seconds = timed(lambda: anonymous(base + "/cost"))
        assert response.status_code == 200, response.text
        public.append(counted(response.json(), total, priced, amount, complete=complete, public=True) + [seconds])
    public_live, public_live_seconds = timed(lambda: anonymous(base + "/exports/live"))
    assert public_live.status_code == 200, public_live.text
    assert (public_live.json()["status"], public_live.json()["total_copies"]) == ("ok", str(total))
    public_mass, public_mass_seconds = timed(lambda: anonymous(base + "/exports/tcgplayer"))
    assert public_mass.status_code == 200, public_mass.text
    assert (public_mass.json()["status"], public_mass.json()["fallback_reason"], public_mass.json()["total_copies"]) == \
        ("text", "encoded_length", str(total))
    directory = Path(os.environ["PUBLIC_PROJECTION_DIR"])
    return {
        "editions": count, "copies": total, "priced_copies": priced, "held_copies": held, "missing_copies": missing,
        # [status, reason] of the Holdings cost, deck_list_cost and cost_to_complete, then seconds, per access
        "private_cost": private, "public_cost": public,  # public: [status, reason, seconds] per access
        "seconds": {"build": build, "deliver": deliver, "seed_quotes": seeding, "private_live": private_live,
                    "private_mass_entry": private_mass, "publish": publish, "public_live": public_live_seconds,
                    "public_mass_entry": public_mass_seconds},
        "bytes": {"records_directory": directory_bytes(directory / "records"),
                  "manifest": (directory / "current.json").stat().st_size,
                  "live_text": live["byte_length"], "mass_entry_text": mass["byte_length"]},
        "inline": {"live": live["inline"], "mass_entry": mass["inline"]},
    }


def metric(line):
    """Measurements for the evidence record: stdout, plus deck-capacity-metrics.log in TEST_LOG_DIR when the gate sets it."""
    print(f"[deck-capacity] {line}")
    if os.environ.get("TEST_LOG_DIR"):
        with open(Path(os.environ["TEST_LOG_DIR"]) / "deck-capacity-metrics.log", "a") as log:
            log.write(f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} {line}\n")


@pytest.mark.slow(reason="capacity: builds, prices and exports a 1,000-Edition Deck")
def test_a_1000_edition_deck_is_priced_and_exported_completely_privately_and_publicly(store, tmp_path, monkeypatch):
    metric(json.dumps(exercise(1000, store, tmp_path, monkeypatch, complete=True, accesses=1), sort_keys=True))

