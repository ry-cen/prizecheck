"""Full-rebuild latency of the stored Format Standing (app redesign #172, spec "Stored Format Standing": "A full rebuild is
one pass over the catalog. Its latency budget is set by a load test in this work").

The catalog holds ``PRINTINGS`` Card Printings, about the size of the English TCGdex catalog. The real importer would
take minutes for that many, so a small real import supplies template Printings (their attributes and Reprint Groups come
from the real rules) and SQL copies each template into new Card Identities, Printings, active-generation rows, derived
attributes and Reprint Groups (each copy of Rare Candy me01-125 and sv01-191 shares a group, as the templates do).

Each rebuild is ``ensure_current`` for all three Formats, timed with a real clock:

- cold: no standings stored, so every row is inserted (the first build after migration 042);
- warm: after the attribute revision moves with no attribute change, so every row is recomputed and none is written
  (the rebuild after an attribute decision or import that changes few cards).

Budgets: ``COLD_BUDGET_S`` for the cold build and ``WARM_BUDGET_S`` for each warm rebuild, recorded in the ticket's
evidence with the measured times (format-standing-latency-metrics.log in TEST_LOG_DIR).
"""
import json
import math
import os
import time
from datetime import date
from pathlib import Path

import pytest

from app.main import connect
from app import format_evaluator as evaluator
from app import format_standing
from test_card_attributes import ACE_SPEC_BW, BULBASAUR_ME, ENERGY_SV, EX_BW, SWITCH_ME
from test_catalog import reset_catalog
from test_catalog_metadata import Records
from test_catalog_reconciliation import run
from test_deck_format_checks import DELTA_POKEMON
from test_expanded_format_checks import NET_REPRINT, SCOOP_UP_NET
from test_reprint_groups import CANDY_ME, CANDY_SV

AS_OF = date(2026, 10, 11)
PRINTINGS = 25_000
COLD_BUDGET_S = 6.0     # measured 2.2 s on the 2026-10-13 development host while another gate ran
WARM_BUDGET_S = 5.0     # measured 1.6 s on the same host and run
WARM_SAMPLES = 3
TEMPLATES = (BULBASAUR_ME, CANDY_ME, CANDY_SV, SCOOP_UP_NET, NET_REPRINT, DELTA_POKEMON, EX_BW, ACE_SPEC_BW, SWITCH_ME,
             ENERGY_SV)

# Copy k of every template Printing, k = 1..%(copies)s, into the active generation. A copy's Card Identity is shared by
# the copies k of templates that share an identity, and its Reprint Group by the copies k of templates that share a group.
COPY = """
CREATE TEMP TABLE capacity_copy ON COMMIT DROP AS
  SELECT p.id AS template_id,p.identity_id AS template_identity,k,gen_random_uuid() AS printing_id
  FROM catalog_printing p CROSS JOIN generate_series(1,%(copies)s) k WHERE p.source_id=ANY(%(templates)s);
CREATE TEMP TABLE capacity_identity ON COMMIT DROP AS
  SELECT template_identity,k,gen_random_uuid() AS identity_id
  FROM (SELECT DISTINCT template_identity,k FROM capacity_copy) d;
INSERT INTO catalog_identity(id,identity_key,display_name)
  SELECT c.identity_id,i.identity_key||' copy '||c.k,i.display_name||' copy '||c.k
  FROM capacity_identity c JOIN catalog_identity i ON i.id=c.template_identity;
INSERT INTO catalog_printing(id,source,source_id,identity_id)
  SELECT c.printing_id,'tcgdex',p.source_id||'~'||c.k,i.identity_id
  FROM capacity_copy c JOIN catalog_printing p ON p.id=c.template_id
  JOIN capacity_identity i ON i.template_identity=c.template_identity AND i.k=c.k;
INSERT INTO catalog_generation_printing(generation_id,printing_id,source_id,set_id,set_name,collector_number,display_name,
    search_name,image_url,source_fingerprint,basic_energy)
  SELECT gp.generation_id,c.printing_id,gp.source_id||'~'||c.k,gp.set_id,gp.set_name,gp.collector_number,gp.display_name,
    gp.search_name,gp.image_url,gp.source_fingerprint,gp.basic_energy
  FROM capacity_copy c JOIN catalog_state s ON s.singleton
  JOIN catalog_generation_printing gp ON gp.generation_id=s.active_generation AND gp.printing_id=c.template_id;
INSERT INTO catalog_derived_attribute(printing_id,rules_version,regulation_mark,card_kind,basic_energy,types,rule_box,
    ace_spec,radiant,prism_star,basic_pokemon,trainer_type,evolves_from)
  SELECT c.printing_id,d.rules_version,d.regulation_mark,d.card_kind,d.basic_energy,d.types,d.rule_box,d.ace_spec,
    d.radiant,d.prism_star,d.basic_pokemon,d.trainer_type,d.evolves_from
  FROM capacity_copy c JOIN catalog_derived_attribute d ON d.printing_id=c.template_id;
INSERT INTO catalog_derived_reprint_group(printing_id,group_id,text_key,rules_version)
  SELECT c.printing_id,md5(g.group_id::text||'~'||c.k)::uuid,g.text_key,g.rules_version
  FROM capacity_copy c JOIN catalog_derived_reprint_group g ON g.printing_id=c.template_id;
UPDATE catalog_state SET revision=revision+1 WHERE singleton;
SELECT catalog_advance_attribute_revision();
"""


def metric(line):
    """Measurements for the evidence record: stdout, plus format-standing-latency-metrics.log in TEST_LOG_DIR."""
    print(f"[format-standing-latency] {line}")
    if os.environ.get("TEST_LOG_DIR"):
        with open(Path(os.environ["TEST_LOG_DIR"]) / "format-standing-latency-metrics.log", "a") as log:
            log.write(f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} {line}\n")


def timed_rebuild():
    started = time.perf_counter()
    state = format_standing.ensure_current()
    elapsed = time.perf_counter() - started
    assert state.rebuilt == evaluator.FORMATS
    return elapsed


def stale():
    with connect() as conn:
        conn.execute("SELECT catalog_advance_attribute_revision()")


@pytest.mark.serial(reason="wall-clock: asserts the full rebuild's latency budget")
@pytest.mark.slow(reason="capacity: a 25,000-Printing catalog")
def test_a_full_rebuild_of_a_catalog_sized_catalog_meets_its_budget(monkeypatch):
    monkeypatch.setattr(format_standing, "today", lambda: AS_OF)
    reset_catalog()
    run(Records(*TEMPLATES))
    started = time.monotonic()
    with connect() as conn, conn.transaction():
        params = {"copies": math.ceil(PRINTINGS / len(TEMPLATES)) - 1,
                  "templates": [record["id"] for record in TEMPLATES]}
        for statement in filter(str.strip, COPY.split(";\n")):
            conn.execute(statement, params)
        conn.execute("ANALYZE")
    with connect() as conn:
        printings = conn.execute("SELECT count(*) AS n FROM catalog_printing").fetchone()["n"]
        conn.execute("TRUNCATE catalog_format_standing")
        conn.execute("DELETE FROM catalog_format_standing_key")
    assert printings >= PRINTINGS
    metric(f"catalog of {printings} Printings built by SQL in {time.monotonic() - started:.1f} s")

    cold = timed_rebuild()
    warm = []
    for _ in range(WARM_SAMPLES):
        stale()
        warm.append(timed_rebuild())
    with connect() as conn:
        rows = conn.execute("SELECT count(*) AS n FROM catalog_format_standing").fetchone()["n"]
        # Each copy is judged like its template: copies of sv01-191 are Standard-legal through their own group, and
        # copies of swsh2-165 are banned in Expanded (bans name a set and number, which the copies keep).
        found = {(row["source_id"], row["format"]): row["standings"] for row in conn.execute(
            """SELECT split_part(p.source_id,'~',1) AS source_id,fs.format,array_agg(DISTINCT fs.standing) AS standings
               FROM catalog_format_standing fs JOIN catalog_printing p ON p.id=fs.printing_id
               WHERE (split_part(p.source_id,'~',1),fs.format) IN (('sv01-191','standard'),('swsh2-165','expanded'))
               GROUP BY 1,2""").fetchall()}
    assert rows == len(evaluator.FORMATS) * printings
    assert found == {("sv01-191", "standard"): ["legal"], ("swsh2-165", "expanded"): ["not_legal"]}
    metric(json.dumps({"printings": printings, "formats": len(evaluator.FORMATS), "cold_s": round(cold, 2),
                       "warm_s": [round(value, 2) for value in warm], "cold_budget_s": COLD_BUDGET_S,
                       "warm_budget_s": WARM_BUDGET_S}, sort_keys=True))
    assert cold < COLD_BUDGET_S, cold
    assert max(warm) < WARM_BUDGET_S, warm
