"""Reviewed Live and Marketplace target state: rules, precedence, quarantine and commit-ordered revisions."""
import copy
import inspect
import json
import re
import threading
from pathlib import Path
from dataclasses import replace
from uuid import uuid4

import psycopg
import pytest

from app.catalog_targets import (LIVE, LIVE_RULES, MATCHING, MATCHING_RULES, REGISTRIES, EditionState, Failure,
                                 LiveRulesV1, MatchingRulesV1, MatchingRulesV2, MatchingRulesV3, MatchingRulesV4, MatchingRulesV5, MatchingRulesV6, PrintingState, TargetContext, activate_rule,
                                 code_digest, complete_quote_variant, rematch_promos, edition_state, edition_targets, evaluate_edition, normalized_name,
                                 evaluate_printing, fingerprint, load_active, printing_live, refresh_printing)
from app.main import connect
from test_catalog import reset_catalog
from test_catalog_metadata import Records, by_type, editions, furret, owner, printing_rows, reviews
from test_catalog_reconciliation import run, seed_manual


class InjectedLive(LiveRulesV1):
    """Test-only rule version: the shipped reviewed set table is empty, so qualification needs an injected table."""
    SET_CODES = {"swsh3": "DAA", "swsh3b": "DAA", "swsh4": "VIV"}


@pytest.fixture(autouse=True)
def isolated_rules(monkeypatch):
    monkeypatch.setitem(LIVE_RULES, 99, InjectedLive)
    yield
    with connect() as conn:
        conn.execute("UPDATE catalog_rule_state SET activation_id=NULL")


def activate(kind, version):
    user = owner()
    with connect() as conn, conn.transaction():
        return activate_rule(conn, kind, version, user, "https://example.org/rule", "Reviewed against the target")


def card(number=1, **changes):
    """A distinct card with its own product so verification never collides across Printings."""
    record = furret(**{"id": f"meta-{number}", "localId": str(number), **changes})
    for variant in record["variants_detailed"]:
        for block in variant["pricing"]["tcgplayer"].values():
            if isinstance(block, dict):
                block["productId"] = 1000 + number
    return record


def metadata(source_id="meta-1"):
    with connect() as conn:
        printing = conn.execute("SELECT * FROM catalog_printing_metadata m JOIN catalog_printing p ON p.id=m.printing_id "
                                "WHERE p.source_id=%s", (source_id,)).fetchone()
        rows = conn.execute("""SELECT e.id,e.descriptor,m.* FROM catalog_edition e JOIN catalog_edition_metadata m ON m.edition_id=e.id
          WHERE e.printing_id=%s ORDER BY e.descriptor_key""", (printing["printing_id"],)).fetchall()
    return printing, {(row["descriptor"].get("type") or row["descriptor"].get("finish") or row["descriptor"]["kind"]): row for row in rows}


def outbox(target_id):
    with connect() as conn:
        return conn.execute("SELECT revision,priority FROM catalog_public_outbox WHERE target_id=%s ORDER BY revision", (target_id,)).fetchall()


# ------------------------------------------------------------------ rules in code


def test_shipped_live_rule_has_no_invented_set_codes_and_derives_only_from_reviewed_inputs():
    assert LiveRulesV1.SET_CODES == {}
    export = {"name": "Furret", "category": "Pokemon", "set": {"id": "swsh3", "name": "X", "tcgOnline": "DAA"}, "localId": "136"}
    assert LiveRulesV1.derive_source(export) == Failure("rule_uncovered")  # tcgOnline is never guessed
    inputs = {"category": "Pokemon", "name": "Furret", "set_code": "DAA", "collector_number": "136"}
    assert LiveRulesV1.derive_reviewed(inputs) == {"category": "Pokemon", "name": "Furret", "set_code": "DAA", "number": "136"}
    for bad in ({**inputs, "set_code": None}, {**inputs, "set_code": "daa"}, {**inputs, "category": "Mystery"},
                {**inputs, "name": " "}, {**inputs, "collector_number": ""}, {k: v for k, v in inputs.items() if k != "name"}):
        assert LiveRulesV1.derive_reviewed(bad) == Failure("missing_input")


def test_matching_rule_product_and_variant_are_separate_checks():
    block = lambda **keys: {"pricing": {"tcgplayer": {"unit": "USD", **keys}}}
    assert MatchingRulesV1.products(block(normal={"productId": 7})) == (None, {"normal": 7})
    assert MatchingRulesV1.products(block(normal={"productId": 7}, holofoil={"productId": 8}))[0] == "conflict"
    assert MatchingRulesV1.products(block(normal={"productId": 0}))[0] == "conflict"
    assert MatchingRulesV1.products({"pricing": {"tcgplayer": {"unit": "USD"}}})[0] == "no_product"
    assert MatchingRulesV1.products({**block(normal={"productId": 7}), "thirdParty": {"tcgplayer": 9}})[0] == "conflict"
    assert MatchingRulesV1.variant({"type": "normal", "size": "standard"}, "normal") == "normal"
    assert MatchingRulesV1.variant({"type": "reverse"}, "reverse-holofoil") == "reverse-holofoil"
    assert MatchingRulesV1.variant({"type": "normal"}, "holofoil") is None
    assert MatchingRulesV1.variant({"type": "normal", "stamp": "x"}, "normal") is None
    assert MatchingRulesV1.variant({"kind": "unspecified", "label": "Unspecified Variant"}, "normal") is None


def repeated_block(number=1, third_party=False):
    """The live TCGdex shape: every variant repeats the card's whole TCGplayer block, one entry per finish.

    Live variants also carry their ``thirdParty`` IDs, which reach the Edition descriptor (``third_party=True``).
    """
    record = card(number)
    block = {"unit": "USD", "updated": "2026-10-07T22:55:02Z",
             "normal": {"productId": 1000 + number, "marketPrice": 0.25},
             "reverse-holofoil": {"productId": 1000 + number, "marketPrice": 0.43}}
    for variant in record["variants_detailed"]:
        variant["pricing"] = {"tcgplayer": copy.deepcopy(block)}
        if third_party:
            variant["thirdParty"] = {"tcgplayer": 1000 + number, "cardmarket": 2000 + number}
    return record


def test_matching_rule_v2_reads_a_repeated_block_through_the_finish_table():
    block = lambda **keys: {"pricing": {"tcgplayer": {"unit": "USD", **keys}}}
    both = block(normal={"productId": 7}, **{"reverse-holofoil": {"productId": 8}})
    assert MatchingRulesV2.products(MatchingRulesV2.narrow(both, "normal")) == (None, {"normal": 7})
    assert MatchingRulesV2.products(MatchingRulesV2.narrow(both, "reverse-holofoil")) == (None, {"reverse-holofoil": 8})
    assert MatchingRulesV2.finish_key({"type": "reverse", "size": "standard"}) == "reverse-holofoil"
    # Uncovered finishes, extra facets and missing keys leave the block as it is, so V1's one-product check fails it.
    for descriptor in ({"type": "holo"}, {"type": "normal", "stamp": "x"}, {"kind": "unspecified", "label": "Unspecified Variant"}):
        assert MatchingRulesV2.narrow(both, MatchingRulesV2.finish_key(descriptor)) is both
    # The thirdParty ID is still checked against the selected product.
    assert MatchingRulesV2.products(MatchingRulesV2.narrow({**both, "thirdParty": {"tcgplayer": 8}}, "normal"))[0] == "conflict"
    single = block(normal={"productId": 7})
    assert MatchingRulesV2.narrow(single, "reverse-holofoil") is single


def test_v1_refuses_a_repeated_block_and_activating_v2_verifies_it():
    reset_catalog()
    activate(MATCHING, 1)
    run(Records(repeated_block(1)))
    assert {(row["mapping_state"], row["mapping_reason"]) for row in metadata()[1].values()} == {("unverified", "rule_failed")}
    assert activate(MATCHING, 2) == {"printings": 0, "editions": 2}
    assert {key: (row["mapping_state"], row["product_id"], row["quote_variant"]) for key, row in metadata()[1].items()} == {
        "normal": ("verified", 1001, "normal"), "reverse": ("verified", 1001, "reverse-holofoil")}


def test_v2_misses_a_descriptor_carrying_third_party_ids_and_activating_v3_verifies_it():
    reset_catalog()
    run(Records(repeated_block(1, third_party=True)))
    assert all("thirdParty" in row["descriptor"] for row in metadata()[1].values())  # the live descriptor shape
    activate(MATCHING, 2)
    assert {(row["mapping_state"], row["mapping_reason"]) for row in metadata()[1].values()} == {("unverified", "rule_failed")}
    assert activate(MATCHING, 3) == {"printings": 0, "editions": 2}
    assert sorted((row["mapping_state"], row["product_id"], row["quote_variant"]) for row in metadata()[1].values()) == [
        ("verified", 1001, "normal"), ("verified", 1001, "reverse-holofoil")]


def card_level_block(number=1):
    """The other live TCGdex shape: the TCGplayer block sits on the card, and the variants list none."""
    record = repeated_block(number, third_party=True)
    record["pricing"] = record["variants_detailed"][0]["pricing"]
    for variant in record["variants_detailed"]:
        del variant["pricing"]
    return record


def test_a_variant_without_a_block_is_matched_through_the_cards_block_at_its_finish():
    reset_catalog()
    activate(MATCHING, 3)
    run(Records(card_level_block(1)))
    assert sorted((row["mapping_state"], row["product_id"], row["quote_variant"]) for row in metadata()[1].values()) == [
        ("verified", 1001, "normal"), ("verified", 1001, "reverse-holofoil")]
    # A card block without the variant's finish is printing-level evidence only: the variant borrows nothing.
    record = card_level_block(2)
    del record["pricing"]["tcgplayer"]["reverse-holofoil"]
    run(Records(card_level_block(1), record))
    assert {key: (row["mapping_state"], row["mapping_reason"]) for key, row in metadata("meta-2")[1].items()} == {
        "normal": ("verified", None), "reverse": ("unverified", "rule_failed")}


def test_stamped_and_contending_variants_borrow_nothing_from_the_cards_block():
    reset_catalog()
    activate(MATCHING, 3)
    record = card_level_block(1)
    record["variants_detailed"].append({**record["variants_detailed"][0], "stamp": ["set-logo"], "variantId": "s-1"})
    run(Records(record))
    with connect() as conn:
        stamped = conn.execute("""SELECT m.* FROM catalog_edition e JOIN catalog_edition_metadata m ON m.edition_id=e.id
          JOIN catalog_printing p ON p.id=e.printing_id WHERE p.source_id='meta-1' AND e.descriptor ? 'stamp'""").fetchall()
    assert [(row["mapping_state"], row["product_id"]) for row in stamped] == [("unverified", None)]
    assert stamped[0]["mapping_candidate"]["candidate"].get("pricing") is None
    # Two variants that read as the same plain finish once thirdParty is set aside contend for one entry: neither borrows.
    record = card_level_block(2)
    record["variants_detailed"] = [{**variant, "thirdParty": {"cardmarket": 2000 + number}}
                                   for number, variant in enumerate([record["variants_detailed"][0]] * 2)]
    record["variants_detailed"][1]["variantId"] = "n-2"
    run(Records(card_level_block(1), record))
    with connect() as conn:
        contending = conn.execute("""SELECT m.* FROM catalog_edition e JOIN catalog_edition_metadata m ON m.edition_id=e.id
          JOIN catalog_printing p ON p.id=e.printing_id WHERE p.source_id='meta-2'""").fetchall()
    assert [(row["mapping_state"], row["mapping_reason"]) for row in contending] == [("unverified", "rule_failed")] * 2
    assert all(row["mapping_candidate"]["candidate"].get("pricing") is None for row in contending)


def test_a_card_block_entry_without_a_product_is_not_borrowed():
    card = {"tcgplayer": {"normal": {"marketPrice": 1}, "reverse-holofoil": {"productId": 9}}}
    normal = {"type": "normal", "size": "standard"}
    assert MatchingRulesV3.borrowed_block(card, normal, [normal]) is None
    assert MatchingRulesV3.borrowed_block(card, {"type": "reverse", "size": "standard"},
                                          [normal, {"type": "reverse", "size": "standard"}]) == card["tcgplayer"]


def test_activating_v3_names_the_quote_variant_of_an_edition_v1_verified_without_one():
    reset_catalog()
    activate(MATCHING, 1)
    record = card(1)
    for variant in record["variants_detailed"]:
        variant["thirdParty"] = {"tcgplayer": 1001}
    run(Records(record))
    before = metadata()[1]
    assert {key: (row["mapping_state"], row["product_id"], row["quote_variant"]) for key, row in before.items()} == {
        "normal": ("verified", 1001, None), "reverse": ("verified", 1001, None)}
    assert activate(MATCHING, 3) == {"printings": 0, "editions": 2}
    after = metadata()[1]
    assert {key: (row["mapping_state"], row["product_id"], row["quote_variant"]) for key, row in after.items()} == {
        "normal": ("verified", 1001, "normal"), "reverse": ("verified", 1001, "reverse-holofoil")}
    assert all(after[key]["mapping_revision"] == before[key]["mapping_revision"] for key in after)
    assert len({row["matching_activation_id"] for row in after.values()} | {before["normal"]["matching_activation_id"]}) == 2
    assert activate(MATCHING, 3) == {"printings": 0, "editions": 0}


def test_completing_a_quote_variant_needs_the_accepted_candidate_and_the_same_product():
    active = type("Active", (), {"rule": MatchingRulesV3, "activation_id": "a-3"})()
    current = EditionState(state="verified", product_id=7, basis="matching_rule", accepted_fingerprint="fp", activation_id="a-1")
    facts = {"fingerprint": "fp", "correspondence": "source_candidate", "source": "tcgdex", "source_id": "x",
             "lookup": {"pricing": {"tcgplayer": {"normal": {"productId": 7}}}},
             "descriptor": {"type": "normal", "size": "standard", "thirdParty": {"tcgplayer": 7}},
             "source_record": {"set": {"id": "s"}, "localId": "1", "name": "Furret"},
             "display": {"set_id": "s", "collector_number": "1", "display_name": normalized_name("Furret")}}
    free = lambda *_: False
    assert complete_quote_variant(current, facts, active, free) == replace(current, quote_variant="normal", activation_id="a-3")
    for changed in ({"fingerprint": "other"}, {"lookup": {"pricing": {"tcgplayer": {"normal": {"productId": 8}}}}},
                    {"descriptor": {"type": "normal", "size": "standard", "stamp": ["x"]}}):
        assert complete_quote_variant(current, {**facts, **changed}, active, free) == current
    for state in (replace(current, basis="maintainer"), replace(current, state="quarantined"), replace(current, quote_variant="normal")):
        assert complete_quote_variant(state, facts, active, free) == state
    assert complete_quote_variant(current, facts, None, free) == current


def test_v3_sets_aside_only_third_party_and_still_checks_it_against_the_product():
    lookup = {"pricing": {"tcgplayer": {"normal": {"productId": 7}, "reverse-holofoil": {"productId": 8}}},
              "thirdParty": {"tcgplayer": 7}}
    facts = {"correspondence": "source_candidate", "source": "tcgdex", "source_id": "x", "lookup": lookup,
             "source_record": {"set": {"id": "s"}, "localId": "1", "name": "Furret"},
             "display": {"set_id": "s", "collector_number": "1", "display_name": normalized_name("Furret")}}
    descriptor = lambda **extra: {"type": "normal", "size": "standard", "thirdParty": {"tcgplayer": 7}, **extra}
    evaluate = lambda rule, d: rule.evaluate({**facts, "descriptor": d}, lambda *_: False)
    assert evaluate(MatchingRulesV2, descriptor()) == Failure("conflict")
    assert evaluate(MatchingRulesV3, descriptor()) == (7, "normal")
    # Other facets still name no finish, and the lookup's thirdParty ID must still be the selected product.
    assert evaluate(MatchingRulesV3, descriptor(stamp="x")) == Failure("conflict")
    assert evaluate(MatchingRulesV3, {**descriptor(), "type": "reverse"}) == Failure("conflict")


def load_active_version():
    with connect() as conn:
        return load_active(conn, MATCHING).version


def test_rule_activation_fails_closed_when_the_approved_code_is_gone_or_changed(monkeypatch):
    reset_catalog()
    activate(LIVE, 99)
    with connect() as conn:
        assert load_active(conn, LIVE).version == 99
    # The approved digest covers the reviewed table: a later edit makes the rule inactive, not wrong.
    approved = InjectedLive.SET_CODES
    monkeypatch.setattr(InjectedLive, "SET_CODES", {"swsh3": "ZZZ"})
    with connect() as conn:
        assert load_active(conn, LIVE) is None
    monkeypatch.setattr(InjectedLive, "SET_CODES", approved)
    with connect() as conn:
        assert load_active(conn, LIVE).version == 99
    del LIVE_RULES[99]  # the fixture's monkeypatch restores the registry afterwards
    with connect() as conn:
        assert load_active(conn, LIVE) is None  # unknown version: imports must not crash
    run(Records(furret()))
    printing, _ = metadata()
    assert (printing["live_state"], printing["live_reason"]) == ("unsupported", "no_active_rule")


def test_code_digest_covers_the_reviewed_table():
    assert code_digest(LIVE, 99) != code_digest(LIVE, 1)
    assert len(code_digest(MATCHING, 1)) == 64


# ------------------------------------------------------------------ marketplace matching (AC3)


def test_without_an_active_rule_nothing_verifies_and_unspecified_is_labelled():
    reset_catalog()
    legacy = furret()
    del legacy["variants_detailed"]
    run(Records(furret(), {**legacy, "id": "meta-2", "localId": "137", "variants": {}}))
    for source_id in ("meta-1", "meta-2"):
        _, rows = metadata(source_id)
        assert all(row["mapping_state"] != "verified" and row["product_id"] is None for row in rows.values())
    assert {row["mapping_reason"] for row in metadata("meta-1")[1].values()} == {"no_matching_rule"}
    assert {row["mapping_reason"] for row in metadata("meta-2")[1].values()} == {"unspecified_variant"}


def test_active_rule_verifies_only_an_exact_variant_and_names_the_quote_variant():
    reset_catalog()
    activate(MATCHING, 1)
    run(Records(card(1)))
    _, rows = metadata()
    assert {key: (row["mapping_state"], row["product_id"], row["quote_variant"], row["mapping_basis"])
            for key, row in rows.items()} == {"normal": ("verified", 1001, "normal", "matching_rule"),
                                              "reverse": ("verified", 1001, "reverse-holofoil", "matching_rule")}
    assert all(row["matching_activation_id"] and row["auto_closed"] and row["mapping_reason"] is None for row in rows.values())
    with connect() as conn:
        targets = edition_targets(conn, [row["id"] for row in rows.values()])
    normal = targets[rows["normal"]["id"]]
    assert (normal.state, normal.product_id, normal.quote_lookup) == ("verified", 1001,
                                                                      {"source": "tcgdex", "card": "meta-1", "variant": "normal"})


def test_product_pass_with_variant_failure_is_verified_but_unpriced():
    reset_catalog()
    activate(MATCHING, 1)
    record = card(1)
    record["variants_detailed"] = [{"type": "normal", "size": "standard", "variantId": "n-1",
                                    "pricing": {"tcgplayer": {"unit": "USD", "holofoil": {"productId": 55}}}}]
    run(Records(record))
    _, rows = metadata()
    assert (rows["normal"]["mapping_state"], rows["normal"]["product_id"], rows["normal"]["quote_variant"]) == ("verified", 55, None)
    with connect() as conn:
        target = edition_targets(conn, [rows["normal"]["id"]])[rows["normal"]["id"]]
    assert target.product_id == 55 and target.quote_lookup is None


def test_printing_level_correspondence_name_mismatch_and_duplicate_products_never_verify():
    reset_catalog()
    activate(MATCHING, 1)
    printing_level = card(2)
    del printing_level["variants_detailed"]
    printing_level["thirdParty"] = {"tcgplayer": 1002}
    duplicate = card(3)
    for variant in duplicate["variants_detailed"]:
        for block in variant["pricing"]["tcgplayer"].values():
            if isinstance(block, dict):
                block["productId"] = 1001  # the product meta-1 holds
    run(Records(card(1), printing_level, duplicate))
    assert {row["mapping_state"] for row in metadata("meta-1")[1].values()} == {"verified"}
    assert {(row["mapping_state"], row["mapping_reason"]) for row in metadata("meta-2")[1].values()} == {("unverified", "rule_failed")}
    assert {(row["mapping_state"], row["mapping_reason"]) for row in metadata("meta-3")[1].values()} == {("unverified", "duplicate_mapping")}


def test_unspecified_variants_never_verify_under_either_descriptor_shape():
    reset_catalog()
    activate(MATCHING, 1)
    record = furret()
    del record["variants_detailed"]
    record["variants"] = {}
    run(Records(record))
    _, rows = metadata()
    [imported] = rows.values()
    assert imported["descriptor"]["kind"] == "unspecified" and imported["mapping_state"] == "unverified"
    manual_printing, manual_edition = seed_manual()
    with connect() as conn:
        manual_shape = conn.execute("""INSERT INTO catalog_edition(printing_id,descriptor_key,descriptor)
          VALUES (%s,'unspecified','{"label":"Unspecified Variant"}') RETURNING id""", (manual_printing,)).fetchone()["id"]
    for edition in (imported["id"], manual_shape):
        with connect() as conn, pytest.raises(psycopg.errors.RaiseException, match="Unspecified Variant"):
            conn.execute("""UPDATE catalog_edition_metadata SET mapping_state='verified',product_id=5,mapping_basis='matching_rule',
              matching_activation_id=(SELECT activation_id FROM catalog_rule_state WHERE kind='marketplace_matching'),
              auto_closed=true WHERE edition_id=%s""", (edition,))


def test_activating_a_rule_after_import_verifies_unverified_editions_once():
    reset_catalog(); run(Records(card(1)))
    assert {row["mapping_state"] for row in metadata()[1].values()} == {"unverified"}
    before = {key: row["mapping_revision"] for key, row in metadata()[1].items()}
    assert activate(MATCHING, 1) == {"printings": 0, "editions": 2}
    rows = metadata()[1]
    assert {row["mapping_state"] for row in rows.values()} == {"verified"}
    assert {key: row["mapping_revision"] for key, row in rows.items()} == {key: value + 1 for key, value in before.items()}


def test_changed_mapping_quarantines_immediately_and_never_auto_reverifies():
    reset_catalog(); activate(MATCHING, 1); activate(LIVE, 99)
    run(Records(card(1)))
    before_printing, before = metadata()
    assert before_printing["live_state"] == "eligible"
    changed = card(1)
    changed["variants_detailed"][0]["pricing"]["tcgplayer"]["normal"]["productId"] = 999
    run(Records(changed))
    printing, rows = metadata()
    assert (rows["normal"]["mapping_state"], rows["normal"]["mapping_reason"]) == ("quarantined", "candidate_changed")
    assert rows["normal"]["mapping_revision"] == before["normal"]["mapping_revision"] + 2  # lookup change plus leaving verified
    assert rows["reverse"]["mapping_state"] == "verified" and rows["reverse"]["mapping_revision"] == before["reverse"]["mapping_revision"]
    assert rows["normal"]["public_revision"] > before["normal"]["public_revision"]
    with connect() as conn:
        targets = edition_targets(conn, [rows["normal"]["id"], rows["reverse"]["id"]])
        live = printing_live(conn, [printing["printing_id"]])[printing["printing_id"]]
    quarantined = targets[rows["normal"]["id"]]
    assert (quarantined.state, quarantined.reason, quarantined.product_id, quarantined.quote_lookup) == (
        "quarantined", "candidate_changed", None, None)
    assert targets[rows["reverse"]["id"]].product_id == 1001
    assert live.state == "eligible" and live.identity["set_code"] == "DAA"  # independent valid Live eligibility remains
    # The source reverting, repeating, or a fresh rule activation never clears the quarantine.
    for source in (card(1), changed, card(1)):
        run(Records(source))
    activate(MATCHING, 1)
    assert metadata()[1]["normal"]["mapping_state"] == "quarantined"
    [urgent] = [row for row in outbox(rows["normal"]["id"]) if row["revision"] == rows["normal"]["public_revision"]]
    assert urgent["priority"] == 0


def test_contradiction_reasons_distinguish_physical_duplicate_and_conflicting_candidates():
    reset_catalog(); activate(MATCHING, 1)
    run(Records(card(1), card(2), card(3), card(4)))
    # meta-2 now claims meta-1's product, meta-3 advertises two products, meta-4's physical name drifts.
    second = card(2)
    second["variants_detailed"][0]["pricing"]["tcgplayer"]["normal"]["productId"] = 1001
    third = card(3)
    third["variants_detailed"][0]["pricing"]["tcgplayer"]["holofoil"] = {"productId": 4242}
    run(Records(card(1), second, third, card(4, name="Furret Delta")))
    assert metadata("meta-2")[1]["normal"]["mapping_reason"] == "duplicate_mapping"
    assert metadata("meta-3")[1]["normal"]["mapping_reason"] == "candidate_conflict"
    assert {row["mapping_reason"] for row in metadata("meta-4")[1].values()} == {"physical_conflict"}
    assert {row["mapping_state"] for row in metadata("meta-4")[1].values()} == {"quarantined"}
    assert {row["mapping_state"] for row in metadata("meta-1")[1].values()} == {"verified"}


def decide_mapping(edition_id, source_candidate, product_id, variant):
    """Stand in for a maintainer decision (written by the review API): reviewed value beats the source."""
    user = owner()
    with connect() as conn, conn.transaction():
        revision = conn.execute("SELECT catalog_begin_correction() AS r").fetchone()["r"]
        printing = conn.execute("SELECT printing_id FROM catalog_edition WHERE id=%s", (edition_id,)).fetchone()["printing_id"]
        decision = conn.execute("""INSERT INTO catalog_metadata_decision(target,printing_id,edition_id,decision,reviewed_value,
          source_fingerprint,basis_revision,evidence_url,reason,reviewer_id,clock_revision)
          VALUES ('marketplace',%s,%s,'correct',%s,%s,1,'https://example.org/e','Checked the card',%s,%s) RETURNING id""",
                                (printing, edition_id, json.dumps({"product_id": product_id, "quote_variant": variant}),
                                 fingerprint(source_candidate), user, revision)).fetchone()["id"]
        conn.execute("INSERT INTO catalog_metadata_rejection VALUES ('marketplace',%s,%s,%s,%s)",
                     (printing, edition_id, fingerprint(source_candidate), decision))
        conn.execute("""UPDATE catalog_edition_metadata SET mapping_state='verified',mapping_reason=NULL,product_id=%s,
          quote_variant=%s,mapping_basis='maintainer',mapping_decision_id=%s,accepted_fingerprint=%s,auto_closed=true,
          mapping_revision=mapping_revision+1 WHERE edition_id=%s""",
                     (product_id, variant, decision, fingerprint(source_candidate), edition_id))


def test_reviewed_correction_outranks_a_repeated_rejected_source_value_but_not_a_new_one():
    reset_catalog(); activate(MATCHING, 1)
    run(Records(card(1)))
    changed = card(1)
    changed["variants_detailed"][0]["pricing"]["tcgplayer"]["normal"]["productId"] = 999
    run(Records(changed))
    _, rows = metadata()
    assert rows["normal"]["mapping_state"] == "quarantined"
    source_candidate = rows["normal"]["mapping_candidate"]
    decide_mapping(rows["normal"]["id"], source_candidate, 4321, "normal")
    corrected = metadata()[1]["normal"]
    assert (corrected["mapping_state"], corrected["product_id"], corrected["mapping_basis"]) == ("verified", 4321, "maintainer")
    run(Records(changed))  # the rejected value repeats: no quarantine, no revision, no public change
    repeated = metadata()[1]["normal"]
    assert (repeated["mapping_state"], repeated["mapping_revision"], repeated["public_revision"]) == (
        "verified", corrected["mapping_revision"], corrected["public_revision"])
    newer = card(1)
    newer["variants_detailed"][0]["pricing"]["tcgplayer"]["normal"]["productId"] = 777
    run(Records(newer))
    final = metadata()[1]["normal"]
    assert final["mapping_state"] == "quarantined" and final["product_id"] == 4321
    assert final["mapping_revision"] == repeated["mapping_revision"] + 2
    with connect() as conn:
        assert edition_targets(conn, [final["id"]])[final["id"]].product_id is None


# ------------------------------------------------------------------ Live (AC4)


def test_without_an_active_rule_or_with_the_empty_shipped_table_nothing_is_live_eligible():
    reset_catalog(); run(Records(furret()))
    printing, _ = metadata()
    assert (printing["live_state"], printing["live_reason"], printing["live_identity"]) == ("unsupported", "no_active_rule", None)
    activate(LIVE, 1)
    printing, _ = metadata()
    assert (printing["live_state"], printing["live_reason"]) == ("unsupported", "rule_uncovered")


def test_uncontested_printing_auto_qualifies_under_an_active_rule_with_rule_basis():
    reset_catalog(); run(Records(furret()))
    activate(LIVE, 99)
    printing, _ = metadata()
    assert printing["live_state"] == "eligible" and printing["live_basis"] == "rule" and printing["live_decision_id"] is None
    assert printing["live_identity"] == {"category": "Pokemon", "name": "Furret", "set_code": "DAA", "number": "136"}
    with connect() as conn:
        live = printing_live(conn, [printing["printing_id"]])[printing["printing_id"]]
    assert (live.state, live.rule_version, live.identity["set_code"]) == ("eligible", 99, "DAA")
    with connect() as conn:  # no per-card Live identifier column exists anywhere in the catalog schema
        columns = {row["column_name"] for row in conn.execute("""SELECT column_name FROM information_schema.columns
          WHERE table_name LIKE 'catalog\\_%' AND (column_name LIKE '%live%' OR column_name LIKE '%tcg_online%')""")}
    assert {name for name in columns if name.endswith("_id")} == {"live_decision_id", "live_activation_id"}


def test_missing_input_is_unsupported_and_rule_uncovered_sets_stay_unsupported():
    reset_catalog(); activate(LIVE, 99)
    no_category = furret(id="meta-2", localId="2")
    del no_category["category"]
    uncovered = furret(id="meta-3", localId="3", set={"id": "unknown", "name": "Unknown"})
    run(Records(no_category, uncovered))
    assert (metadata("meta-2")[0]["live_state"], metadata("meta-2")[0]["live_reason"]) == ("unsupported", "missing_input")
    assert (metadata("meta-3")[0]["live_state"], metadata("meta-3")[0]["live_reason"]) == ("unsupported", "rule_uncovered")


def test_a_rule_input_change_suspends_only_the_affected_printing_and_its_marketplace_state_is_untouched():
    reset_catalog(); activate(MATCHING, 1); activate(LIVE, 99)
    run(Records(card(1), card(2)))
    before_one, editions_one = metadata("meta-1")
    before_two, _ = metadata("meta-2")
    changed = card(1)
    changed["category"] = "Trainer"  # an input the Live rule reads
    run(Records(changed, card(2)))
    one, rows_one = metadata("meta-1")
    two, _ = metadata("meta-2")
    assert (one["live_state"], one["live_reason"], one["live_identity"]) == ("suspended", "source_changed", None)
    assert one["live_revision"] == before_one["live_revision"] + 1 and one["live_auto_closed"]
    assert two["live_state"] == "eligible" and two["public_revision"] == before_two["public_revision"]
    assert {row["mapping_state"] for row in rows_one.values()} == {"verified"}
    assert {key: row["public_revision"] for key, row in rows_one.items()} == {
        key: row["public_revision"] for key, row in editions_one.items()}
    assert [row["priority"] for row in outbox(one["printing_id"]) if row["revision"] == one["public_revision"]] == [0]
    with connect() as conn:
        assert printing_live(conn, [one["printing_id"]])[one["printing_id"]].identity is None
    # Independent revisions: Live moved, marketplace did not.
    assert {row["mapping_revision"] for row in rows_one.values()} == {2}


def test_source_enrichment_the_rules_never_read_closes_nothing_and_republishes_only_format_facts():
    reset_catalog(); activate(MATCHING, 1); activate(LIVE, 99)
    run(Records(card(1)))
    before, rows = metadata()
    assert before["live_state"] == "eligible" and {row["mapping_state"] for row in rows.values()} == {"verified"}
    enriched = card(1)
    enriched["regulationMark"] = "E"                                  # Live export candidate, not a Live rule input
    enriched["set"] = {**enriched["set"], "tcgOnline": "DAA"}
    enriched["variants_detailed"][0]["variantId"] = "n-2"
    enriched["variants_detailed"][0]["pricing"]["cardmarket"] = {"productId": 4242, "avg": 1.0}  # a Cardmarket ID the TCGplayer rule never reads
    run(Records(enriched))
    after, rows_after = metadata()
    assert (after["live_state"], after["live_reason"]) == ("eligible", None)
    # The regulation mark is a derived card attribute and so a public format fact (Deck Lists 18): the Printing is
    # re-stamped once with its Live state unchanged. Its Editions and their mapping revisions do not move.
    assert after["public_revision"] > before["public_revision"]
    assert after["export_candidate"] != before["export_candidate"]
    assert after["live_accepted_fingerprint"] == fingerprint(after["export_candidate"])  # silently moved to the new source state
    for key in rows:
        assert rows_after[key]["mapping_state"] == "verified"
        assert (rows_after[key]["mapping_revision"], rows_after[key]["public_revision"]) == (
            rows[key]["mapping_revision"], rows[key]["public_revision"]), key  # quotes keyed on the revision stay valid
        assert outbox(rows[key]["id"]) == outbox_before(rows, key)
    assert rows_after["normal"]["mapping_candidate"] != rows["normal"]["mapping_candidate"]
    assert rows_after["normal"]["accepted_fingerprint"] == fingerprint(rows_after["normal"]["mapping_candidate"])
    assert [row["revision"] for row in outbox(after["printing_id"]) if row["revision"] > before["public_revision"]] == [
        after["public_revision"]]
    # A later change to an input the rules do read still closes the target.
    conflicting = card(1)
    conflicting["variants_detailed"][0]["pricing"]["tcgplayer"]["holofoil"] = {"productId": 9999}
    run(Records(conflicting))
    _, closed = metadata()
    assert (closed["normal"]["mapping_state"], closed["normal"]["mapping_reason"]) == ("quarantined", "candidate_conflict")


def outbox_before(rows, key):
    return [row for row in outbox(rows[key]["id"]) if row["revision"] <= rows[key]["public_revision"]]


def settle(source_id="meta-1", status="retained"):
    with connect() as conn:
        conn.execute("UPDATE catalog_review SET status=%s WHERE source_id=%s AND status='pending'", (status, source_id))


def test_contested_then_uncontested_eligible_printing_stays_suspended_across_imports():
    reset_catalog(); run(Records(furret())); activate(LIVE, 99)
    assert metadata()[0]["live_state"] == "eligible"
    renamed = furret(name="Furret Delta")
    run(Records(renamed))
    printing, _ = metadata()
    assert (printing["live_state"], printing["live_reason"]) == ("suspended", "identity_review_pending")
    settle()
    for source in (renamed, renamed, furret(), furret()):
        run(Records(source))
        printing, _ = metadata()
        assert (printing["live_state"], printing["live_reason"], printing["live_auto_closed"]) == (
            "suspended", "identity_review_pending", True)
    activate(LIVE, 99)  # re-activation never re-qualifies a suspended Printing
    assert metadata()[0]["live_state"] == "suspended"
    assert printing_rows()["live_state"] == "suspended"


def test_never_eligible_contested_printing_waits_and_then_qualifies_once_uncontested():
    reset_catalog(); run(Records(furret()))
    ambiguous = furret()
    ambiguous["variants_detailed"][1]["unclassifiedFacet"] = "galaxy"
    run(Records(ambiguous))
    assert [row["kind"] for row in reviews()] == ["variant_ambiguity"]
    activate(LIVE, 99)
    printing, _ = metadata()
    assert (printing["live_state"], printing["live_reason"], printing["live_auto_closed"]) == (
        "unsupported", "identity_review_pending", False)
    run(Records(ambiguous))
    assert metadata()[0]["live_state"] == "unsupported"
    settle("meta-1")
    run(Records(ambiguous))
    printing, _ = metadata()
    assert printing["live_state"] == "eligible" and printing["live_basis"] == "rule"


def test_live_identity_collisions_leave_neither_printing_eligible():
    reset_catalog(); activate(LIVE, 99)
    twin = furret(id="meta-2", set={"id": "swsh3b", "name": "Other Set"})  # same number, same derived Live set code
    run(Records(furret(), twin))
    for source_id in ("meta-1", "meta-2"):
        printing, _ = metadata(source_id)
        assert (printing["live_state"], printing["live_reason"]) == ("unsupported", "conflicting_input")
    run(Records(furret(), twin))
    assert {metadata(source_id)[0]["live_state"] for source_id in ("meta-1", "meta-2")} == {"unsupported"}


def test_a_later_collision_suspends_the_previously_eligible_printing():
    reset_catalog(); activate(LIVE, 99)
    run(Records(furret()))
    assert metadata()[0]["live_state"] == "eligible"
    twin = furret(id="meta-2", set={"id": "swsh3b", "name": "Other Set"})
    run(Records(furret(), twin))
    first, second = metadata("meta-1")[0], metadata("meta-2")[0]
    assert (first["live_state"], first["live_reason"], first["live_auto_closed"]) == ("suspended", "conflicting_input", True)
    assert (second["live_state"], second["live_reason"]) == ("unsupported", "conflicting_input")
    assert [row["priority"] for row in outbox(first["printing_id"]) if row["revision"] == first["public_revision"]] == [0]
    # Removing the cause never restores the earlier Printing automatically.
    run(Records(furret(), furret(id="meta-2", set={"id": "swsh4", "name": "Third"})))
    assert metadata("meta-1")[0]["live_state"] == "suspended"


def decide_live(printing_id, inputs, fingerprint_value):
    user = owner()
    with connect() as conn, conn.transaction():
        revision = conn.execute("SELECT catalog_begin_correction() AS r").fetchone()["r"]
        decision = conn.execute("""INSERT INTO catalog_metadata_decision(target,printing_id,decision,reviewed_value,source_fingerprint,
          basis_revision,evidence_url,reason,reviewer_id,clock_revision)
          VALUES ('live',%s,'correct',%s,%s,1,'https://example.org/e','Checked the card',%s,%s) RETURNING id""",
                                (printing_id, json.dumps(inputs), fingerprint_value, user, revision)).fetchone()["id"]
        conn.execute("UPDATE catalog_printing_metadata SET live_inputs=%s,live_decision_id=%s WHERE printing_id=%s",
                     (json.dumps(inputs), decision, printing_id))
        refresh_printing(conn, TargetContext(conn), printing_id, reviewed=True)


def test_only_a_maintainer_decision_lifts_a_suspension_and_it_needs_an_active_rule():
    reset_catalog(); run(Records(furret())); activate(LIVE, 99)
    run(Records(furret(category="Trainer")))
    printing, _ = metadata()
    assert printing["live_state"] == "suspended"
    inputs = {"category": "Pokemon", "name": "Furret", "set_code": "DAB", "collector_number": "136"}
    with connect() as conn:
        export = conn.execute("SELECT export_candidate FROM catalog_printing_metadata WHERE printing_id=%s",
                              (printing["printing_id"],)).fetchone()["export_candidate"]
    decide_live(printing["printing_id"], inputs, fingerprint(export))
    printing, _ = metadata()
    assert (printing["live_state"], printing["live_basis"]) == ("eligible", "maintainer")
    assert printing["live_decision_id"] and printing["live_identity"]["set_code"] == "DAB"
    with connect() as conn, pytest.raises(psycopg.errors.CheckViolation):
        conn.execute("UPDATE catalog_printing_metadata SET live_activation_id=NULL WHERE printing_id=%s", (printing["printing_id"],))


def test_eligible_live_rows_require_activation_and_decision_only_for_maintainer_basis():
    reset_catalog(); run(Records(furret()))
    printing, _ = metadata()
    identity = json.dumps({"category": "Pokemon", "name": "Furret", "set_code": "DAA", "number": "136"})
    activate(LIVE, 99)
    with connect() as conn:
        activation = conn.execute("SELECT activation_id FROM catalog_rule_state WHERE kind='live_derivation'").fetchone()["activation_id"]
    attempts = [
        ("rule", None, None),            # no activation
        ("maintainer", activation, None),  # maintainer basis without a decision
        (None, activation, None),        # no basis
    ]
    for basis, act, decision in attempts:
        with connect() as conn, pytest.raises(psycopg.errors.CheckViolation):
            conn.execute("""UPDATE catalog_printing_metadata SET live_state='eligible',live_reason=NULL,live_identity=%s,live_basis=%s,
              live_activation_id=%s,live_decision_id=%s,live_auto_closed=true WHERE printing_id=%s""",
                         (identity, basis, act, decision, printing["printing_id"]))
    with connect() as conn, pytest.raises(psycopg.errors.CheckViolation):  # suspension requires the closed flag
        conn.execute("UPDATE catalog_printing_metadata SET live_state='suspended',live_reason='source_changed',live_identity=NULL,"
                     "live_auto_closed=false WHERE printing_id=%s", (printing["printing_id"],))


# ------------------------------------------------------------------ pure state machine


def facts(**changes):
    value = {"fingerprint": "f" * 64, "correspondence": "source_candidate", "lookup": {}, "descriptor": {"type": "normal"},
             "source": "tcgdex", "source_id": "x", "source_record": {}, "display": None}
    return {**value, **changes}


def test_quarantine_is_sticky_for_pure_edition_evaluation():
    quarantined = EditionState(state="quarantined", reason="candidate_changed", product_id=3, auto_closed=True)
    assert evaluate_edition(quarantined, facts(), set(), None, lambda product: False) is quarantined
    unmapped = EditionState(reason="reviewed_unmapped", auto_closed=True)
    assert evaluate_edition(unmapped, facts(), set(), None, lambda product: False).state == "unverified"


def test_pure_live_evaluation_honours_rejections_and_the_closed_flag():
    from app.catalog_targets import ActiveRule
    active = ActiveRule(LIVE, 99, uuid4(), InjectedLive)
    export = {"name": "Furret", "category": "Pokemon", "set": {"id": "swsh3"}, "localId": "136"}
    never = PrintingState()
    qualified = evaluate_printing(never, export, lambda: False, set(), active, lambda claim: False)
    assert (qualified.state, qualified.basis, qualified.auto_closed) == ("eligible", "rule", True)
    # A source value the maintainer rejected never qualifies by rule.
    rejected = evaluate_printing(never, export, lambda: False, {fingerprint(export)}, active, lambda claim: False)
    assert (rejected.state, rejected.reason) == ("unsupported", "reviewed_unsupported")
    # Suspended and reviewed-unsupported results are final until a maintainer decision.
    assert evaluate_printing(rejected, export, lambda: False, set(), active, lambda claim: False) is rejected
    suspended = evaluate_printing(qualified, {**export, "localId": "137"}, lambda: False, set(), active, lambda claim: False)
    assert (suspended.state, suspended.reason, suspended.identity) == ("suspended", "source_changed", None)
    assert evaluate_printing(suspended, export, lambda: False, set(), active, lambda claim: False) is suspended
    # The reviewed flag (a decision) is the only way back, and it still refuses collisions.
    assert evaluate_printing(suspended, export, lambda: False, set(), active, lambda claim: False, reviewed=True).state == "eligible"
    collided = evaluate_printing(suspended, export, lambda: False, set(), active, lambda claim: True, reviewed=True)
    assert (collided.state, collided.reason) == ("suspended", "conflicting_input")
    # Losing the rule suspends an eligible Printing rather than quietly downgrading it.
    assert evaluate_printing(qualified, export, lambda: False, set(), None, lambda claim: False).state == "suspended"


# ------------------------------------------------------------------ outbox and ordering


def test_every_catalog_row_is_enqueued_in_its_own_transaction_and_rollback_leaves_nothing():
    reset_catalog(); run(Records(furret()))
    printing, rows = metadata()
    for row in [printing, *rows.values()]:
        target = row.get("edition_id") or row["printing_id"]
        assert outbox(target)[-1]["revision"] == row["public_revision"]
    with connect() as conn:
        before = conn.execute("SELECT count(*) AS n FROM catalog_public_outbox").fetchone()["n"]
        conn.execute("UPDATE catalog_edition_metadata SET mapping_reason='rule_failed' WHERE edition_id=%s",
                     (next(iter(rows.values()))["id"],))
        assert conn.execute("SELECT count(*) AS n FROM catalog_public_outbox").fetchone()["n"] == before + 1
        conn.rollback()
        assert conn.execute("SELECT count(*) AS n FROM catalog_public_outbox").fetchone()["n"] == before


def test_quote_only_changes_enqueue_nothing():
    reset_catalog(); run(Records(furret()))
    with connect() as conn:
        before = conn.execute("SELECT count(*) AS n, max(revision) AS top FROM catalog_public_outbox").fetchone()
    repriced = furret()
    repriced["variants_detailed"][0]["pricing"]["tcgplayer"]["normal"]["marketPrice"] = 9.99
    run(Records(repriced))
    with connect() as conn:
        assert conn.execute("SELECT count(*) AS n, max(revision) AS top FROM catalog_public_outbox").fetchone() == before


def test_clock_revisions_follow_commit_order_not_allocation_order():
    first, second = connect(), connect()
    try:
        r1 = first.execute("SELECT catalog_begin_correction() AS r").fetchone()["r"]
        assert first.execute("SELECT catalog_begin_correction() AS r").fetchone()["r"] == r1  # once per transaction
        second.execute("SET lock_timeout='200ms'")
        with pytest.raises(psycopg.errors.LockNotAvailable):
            second.execute("SELECT catalog_begin_correction()")
        second.rollback()
        first.commit()
        r2 = second.execute("SELECT catalog_begin_correction() AS r").fetchone()["r"]
        assert r2 == r1 + 1
        second.rollback()
        with connect() as check:
            assert check.execute("SELECT revision FROM catalog_public_clock").fetchone()["revision"] == r1
    finally:
        first.close(); second.close()


def test_import_takes_the_clock_before_touching_metadata_and_blocks_behind_an_earlier_correction():
    reset_catalog()
    holder = connect()
    reached = threading.Event()
    result = {}
    try:
        held = holder.execute("SELECT catalog_begin_correction() AS r").fetchone()["r"]

        def importer():
            try:
                with connect() as conn:
                    run_id = conn.execute("INSERT INTO catalog_run DEFAULT VALUES RETURNING id").fetchone()["id"]
                    conn.commit()
                    from app.catalog import claim_run, execute_run
                    claim_run(conn, run_id)
                    execute_run(conn, run_id, Records(furret()), before_promotion=reached.set)
            except BaseException as exc:  # surfaced below
                result["error"] = exc

        thread = threading.Thread(target=importer)
        thread.start()
        assert not reached.wait(1.0), "promotion advanced past the clock held by an earlier correction"
        with connect() as watcher:
            waiting = watcher.execute("""SELECT count(*) AS n FROM pg_stat_activity WHERE wait_event_type='Lock'
              AND datname=current_database() AND query LIKE '%catalog_begin_correction%'""").fetchone()["n"]
        assert waiting == 1
        holder.commit()
        thread.join(30)
        assert not thread.is_alive() and "error" not in result, result
    finally:
        holder.close()
    printing, rows = metadata()
    assert {printing["public_revision"], *[row["public_revision"] for row in rows.values()]} == {held + 1}


def test_activations_and_decisions_are_append_only():
    reset_catalog(); activate(LIVE, 99)
    with connect() as conn, pytest.raises(psycopg.errors.RaiseException, match="append-only"):
        conn.execute("UPDATE catalog_rule_activation SET reason='changed'")
    with connect() as conn, pytest.raises(psycopg.errors.RaiseException, match="append-only"):
        conn.execute("DELETE FROM catalog_rule_activation")


# ------------------------------------------------------------------ manual overrides and retired records (AC7)


def test_manual_printing_has_metadata_but_only_a_maintainer_can_map_it():
    reset_catalog(); activate(MATCHING, 1); activate(LIVE, 99)
    run(Records(furret()))
    printing, edition = seed_manual()
    with connect() as conn:
        row = conn.execute("""SELECT m.live_state,m.live_reason,em.mapping_state,em.mapping_reason,p.source_id
          FROM catalog_printing p JOIN catalog_printing_metadata m ON m.printing_id=p.id
          JOIN catalog_edition_metadata em ON em.edition_id=%s WHERE p.id=%s""", (edition, printing)).fetchone()
    assert row == {"live_state": "unsupported", "live_reason": "no_active_rule", "mapping_state": "unverified",
                   "mapping_reason": "no_matching_rule", "source_id": None}
    activate(MATCHING, 1)
    with connect() as conn:
        assert conn.execute("SELECT mapping_state FROM catalog_edition_metadata WHERE edition_id=%s", (edition,)).fetchone()[
            "mapping_state"] == "unverified"  # no source candidate: the rule has nothing to prove
    decide_mapping(edition, {"manual": True}, 6006, None)
    with connect() as conn:
        mapped = edition_targets(conn, [edition])[edition]
        assert conn.execute("SELECT source_id FROM catalog_printing WHERE id=%s", (printing,)).fetchone()["source_id"] is None
    assert (mapped.state, mapped.product_id, mapped.quote_lookup) == ("verified", 6006, None)


def test_retired_source_record_keeps_reviewed_meaning_without_changing_identity():
    reset_catalog(); activate(MATCHING, 1); activate(LIVE, 99)
    records = [card(number) for number in range(1, 102)]
    run(Records(*records))
    before_printing, before_rows = metadata("meta-101")
    assert before_printing["live_state"] == "eligible"
    with connect() as conn:
        snapshot = conn.execute("""SELECT e.id,e.descriptor,e.public_ref,e.printing_id FROM catalog_edition e
          JOIN catalog_printing p ON p.id=e.printing_id WHERE p.source_id='meta-101' ORDER BY e.id""").fetchall()
    run(Records(*records[:100]))  # meta-101 disappears from the source
    after_printing, after_rows = metadata("meta-101")
    with connect() as conn:
        tombstoned = conn.execute("""SELECT tombstoned FROM catalog_generation_printing gp JOIN catalog_state s
          ON s.active_generation=gp.generation_id WHERE gp.source_id='meta-101'""").fetchone()["tombstoned"]
        assert snapshot == conn.execute("""SELECT e.id,e.descriptor,e.public_ref,e.printing_id FROM catalog_edition e
          JOIN catalog_printing p ON p.id=e.printing_id WHERE p.source_id='meta-101' ORDER BY e.id""").fetchall()
    assert tombstoned
    assert (after_printing["live_state"], after_printing["live_identity"], after_printing["public_revision"]) == (
        "eligible", before_printing["live_identity"], before_printing["public_revision"])
    assert {key: (row["mapping_state"], row["product_id"], row["public_revision"]) for key, row in after_rows.items()} == {
        key: (row["mapping_state"], row["product_id"], row["public_revision"]) for key, row in before_rows.items()}


def test_manual_approval_takes_the_clock_before_writing_metadata_and_orders_behind_an_earlier_correction():
    import test_missing_cards as cards
    reset_catalog(); run(Records(furret()))
    with connect() as conn:
        for user in (cards.OWNER, cards.REPORTER):
            conn.execute("INSERT INTO inventory_owner(user_id) VALUES (%s) ON CONFLICT DO NOTHING", (user,))
        conn.execute("INSERT INTO owner_binding(singleton,user_id) VALUES (true,%s)", (cards.OWNER,))
    report_id = cards.printing_report()
    holder = connect()
    outcome = {}
    try:
        held = holder.execute("SELECT catalog_begin_correction() AS r").fetchone()["r"]
        thread = threading.Thread(target=lambda: outcome.update(response=cards.approve(report_id)))
        thread.start()
        thread.join(1.0)
        assert thread.is_alive(), "approval wrote metadata without waiting for the earlier correction"
        holder.commit()
        thread.join(30)
        assert not thread.is_alive() and outcome["response"].status_code == 200, outcome
    finally:
        holder.close()
    approved = outcome["response"].json()
    with connect() as conn:
        row = conn.execute("""SELECT m.public_revision,m.live_state,e.mapping_state,e.public_revision AS edition_revision
          FROM catalog_printing_metadata m JOIN catalog_edition_metadata e ON e.edition_id=%s
          WHERE m.printing_id=%s""", (approved["approved_edition_id"], approved["approved_printing_id"])).fetchone()
    assert row["public_revision"] == row["edition_revision"] == held + 1
    assert (row["live_state"], row["mapping_state"]) == ("unsupported", "unverified")


def test_decisions_are_append_only_and_independent_of_catalog_revision():
    reset_catalog(); run(Records(furret()))
    printing, _ = metadata()
    with connect() as conn:
        revision = conn.execute("SELECT revision FROM catalog_state").fetchone()["revision"]
    decide_live(printing["printing_id"], {"category": "Pokemon", "name": "Furret", "set_code": "DAA", "collector_number": "136"}, "0" * 64)
    with connect() as conn:
        assert conn.execute("SELECT revision FROM catalog_state").fetchone()["revision"] == revision  # cursors encode it
    with connect() as conn, pytest.raises(psycopg.errors.RaiseException, match="append-only"):
        conn.execute("UPDATE catalog_metadata_decision SET reason='rewritten'")
    with connect() as conn, pytest.raises(psycopg.errors.RaiseException, match="append-only"):
        conn.execute("DELETE FROM catalog_metadata_decision")


def test_sibling_editions_sharing_a_quote_variant_never_both_verify():
    reset_catalog(); activate(MATCHING, 1)
    record = card(1)
    # Two physical Editions whose finish table maps to the same variant key of one product.
    record["variants_detailed"] = [
        {"type": "normal", "size": "standard", "variantId": "a", "pricing": {"tcgplayer": {"unit": "USD", "normal": {"productId": 77}}}},
        {"finish": "normal", "size": "standard", "variantId": "b", "pricing": {"tcgplayer": {"unit": "USD", "normal": {"productId": 77}}}},
    ]
    run(Records(record))
    with connect() as conn:
        rows = conn.execute("""SELECT m.edition_id,m.mapping_state,m.mapping_reason,m.quote_variant FROM catalog_edition_metadata m
          JOIN catalog_edition e ON e.id=m.edition_id JOIN catalog_printing p ON p.id=e.printing_id
          WHERE p.source_id='meta-1' ORDER BY m.mapping_state DESC""").fetchall()
    assert [row["mapping_state"] for row in rows] == ["verified", "unverified"]
    assert rows[1]["mapping_reason"] == "duplicate_mapping"
    # The database backstop refuses a second verified Edition in the same price slot.
    with connect() as conn, pytest.raises(psycopg.errors.UniqueViolation):
        conn.execute("""UPDATE catalog_edition_metadata SET mapping_state='verified',product_id=77,quote_variant='normal',
          mapping_basis='matching_rule',matching_activation_id=(SELECT activation_id FROM catalog_rule_state WHERE kind='marketplace_matching'),
          auto_closed=true WHERE edition_id=%s""", (rows[1]["edition_id"],))


def test_a_price_slot_belongs_to_one_edition_of_a_printing_whatever_the_product():
    """The public quote lookup names the Printing's source card and variant key, not the product."""
    from app.catalog_targets import verified_elsewhere
    reset_catalog(); activate(MATCHING, 1)
    run(Records(card(1)))
    printing, rows = metadata()
    normal, reverse = rows["normal"], rows["reverse"]
    assert (normal["mapping_state"], normal["quote_variant"], reverse["quote_variant"]) == ("verified", "normal", "reverse-holofoil")
    with connect() as conn:
        held = verified_elsewhere(conn, printing["printing_id"], reverse["id"])
        assert held(2002, "normal")        # the sibling's slot, even for another product
        assert not held(2002, None)        # unpriced siblings never share a slot
        assert not held(1001, "reverse-holofoil")  # its own slot is its own
        assert not held(2002, "holofoil")  # an unheld slot
    with connect() as conn, pytest.raises(psycopg.errors.UniqueViolation):  # the database refuses it as well
        conn.execute("UPDATE catalog_edition_metadata SET product_id=2002,quote_variant='normal' WHERE edition_id=%s", (reverse["id"],))
    # Another Printing may use the same variant key.
    run(Records(card(1), card(2)))
    _, other = metadata("meta-2")
    assert (other["normal"]["mapping_state"], other["normal"]["quote_variant"]) == ("verified", "normal")


def test_a_deprecated_edition_releases_its_product_and_price_slot_to_its_replacement():
    from test_catalog_reconciliation import shown
    from test_holdings import call
    reset_catalog()
    run(Records(card(1), card(2)))
    _, old_rows = metadata("meta-1")
    _, new_rows = metadata("meta-2")
    old, new = old_rows["normal"], new_rows["normal"]
    decide_mapping(old["id"], old["mapping_candidate"], 5000, "normal")  # a maintainer verified the old Edition
    with pytest.raises(psycopg.errors.UniqueViolation):  # another Printing cannot take its price slot meanwhile
        decide_mapping(new["id"], new["mapping_candidate"], 5000, "normal")
    user = owner()
    with connect() as conn:
        review = conn.execute("""INSERT INTO catalog_review(printing_id,source_id,kind,source_fingerprint,detail)
          VALUES (%s,'meta-1','variant_ambiguity','correction','Finish correction') RETURNING id""", (old["printing_id"],)).fetchone()["id"]
        before = conn.execute("SELECT mapping_revision,public_revision FROM catalog_edition_metadata WHERE edition_id=%s", (old["id"],)).fetchone()
    response = call("POST", f"/api/admin/catalog-reviews/{review}/decision", user, {
        "decision": "deprecate_edition", "reason": "Same physical card, corrected edition", "evidence_url": "https://example.org/e",
        "edition_id": str(old["id"]), "replacement_edition_id": str(new["id"]), "evidence_digest": shown(user, review)})
    assert response.status_code == 200, response.text
    with connect() as conn:
        released = conn.execute("SELECT * FROM catalog_edition_metadata WHERE edition_id=%s", (old["id"],)).fetchone()
        pending = conn.execute("SELECT priority FROM catalog_public_outbox WHERE target_id=%s AND revision=%s",
                               (old["id"], released["public_revision"])).fetchall()
    assert (released["mapping_state"], released["mapping_reason"], released["product_id"], released["quote_variant"]) == (
        "unverified", "reviewed_unmapped", None, None)
    assert released["mapping_revision"] == before["mapping_revision"] + 1 and released["public_revision"] > before["public_revision"]
    assert released["mapping_decision_id"] is None and released["accepted_fingerprint"] is None and pending  # published as unmapped
    decide_mapping(new["id"], new["mapping_candidate"], 5000, "normal")  # the replacement can now take the slot
    assert metadata("meta-2")[1]["normal"]["mapping_state"] == "verified"
    run(Records(card(1), card(2)))  # imports never re-verify the released Edition
    assert metadata("meta-1")[1]["normal"]["mapping_state"] == "unverified"


PINNED_DIGESTS = {
    (LIVE, 1): "79ed62c768325f3dc0d378e0f8128251c6f8ef4a778b6351c4097c9ec1235084",
    (MATCHING, 1): "5367c25316bea657d01a044af5a175dfe66dab656d36f82bcc16bb060dfb25d6",
    (MATCHING, 2): "6994b033232a73138f83cda642e97edc8e75e692e9bba29a3704b913eb7a6eef",
    (MATCHING, 3): "60e02ce648ea81e2177124c2f4a5740897e5481dbecfa20a1a1395dddf184c5e",
    (MATCHING, 4): "6a6b62a2081d42185309a4ba389cd1260409e018c1449de20eb1e0feb797b57a",
    (MATCHING, 5): "6a870e3f61697fe0a35009951889d6a83a74f3c2f33b7af0c840d4d5c8240106",
    (MATCHING, 6): "ed8cafaf8481c43926c4914babfbb155058a6f65d323a225508200e03495e121",
}


def test_registered_rule_digests_are_pinned():
    """Any edit to a shipped rule's source or table changes its digest and silently deactivates the approved rule.

    A new Live set code ships as ``LiveRulesV2`` (a new registered version), never as an edit of V1. If this
    fails after a deliberate change, ship the change as a new rule version and pin that version here.
    """
    registered = {(kind, version): code_digest(kind, version)
                  for kind, registry in REGISTRIES.items() for version in registry if version != 99}  # 99 is the test-injected table
    assert registered == PINNED_DIGESTS


# ------------------------------------------------------------------ matching rule v4


def promo(source_id, number, set_id="svp", name="Pikachu", variants=None):
    """A TCGdex card whose variants carry only thirdParty IDs (or none): no pricing block anywhere."""
    record = furret(**{"id": source_id, "name": name, "localId": number, "set": {"id": set_id, "name": set_id, "cardCount": {"official": 1, "total": 1}}})
    del record["card_pricing"]
    record["variants_detailed"] = variants or [{"type": "holo", "size": "standard"}]
    return record


def listing(product_id, name, number, group, conn=None):
    from app.catalog_targets import number_key
    with connect() as connection:
        connection.execute("""INSERT INTO tcgplayer_product(product_id,group_id,name,number,number_key,seen_at,source_updated_at)
          VALUES (%s,%s,%s,%s,%s,now(),now())""", (product_id, group, name, number, number_key(number)))


@pytest.fixture
def tcgplayer_products():
    with connect() as conn:
        conn.execute("TRUNCATE tcgplayer_product, tcgplayer_price")
    yield
    with connect() as conn:
        conn.execute("TRUNCATE tcgplayer_product, tcgplayer_price")


def states(source_id):
    return sorted((row["mapping_state"], row["mapping_reason"], row["product_id"], row["quote_variant"])
                  for row in metadata(source_id)[1].values())


def test_v4_takes_the_variants_own_tcgdex_id_where_v3_finds_no_product():
    reset_catalog()
    run(Records(promo("svp-1", "1", variants=[{"type": "holo", "size": "standard", "thirdParty": {"tcgplayer": 477184}}])))
    activate(MATCHING, 3)
    assert states("svp-1") == [("unverified", "rule_failed", None, None)]
    assert activate(MATCHING, 4) == {"printings": 0, "editions": 1}
    assert states("svp-1") == [("verified", None, 477184, "holofoil")]


def test_v4_verifies_base1_4s_three_variants_and_siblings_may_share_a_product():
    reset_catalog()
    run(Records(promo("base1-4", "4", "base1", "Charizard", [
        {"type": "holo", "subtype": "unlimited", "size": "standard", "thirdParty": {"tcgplayer": 42382}},
        {"type": "holo", "subtype": "shadowless", "stamp": ["1st-edition"], "size": "standard", "thirdParty": {"tcgplayer": 106999}},
        {"type": "holo", "subtype": "shadowless", "size": "standard", "thirdParty": {"tcgplayer": 106999}}])))
    activate(MATCHING, 4)
    with connect() as conn:
        rows = conn.execute("""SELECT e.descriptor,m.mapping_state,m.product_id FROM catalog_edition e
          JOIN catalog_edition_metadata m ON m.edition_id=e.id""").fetchall()
    assert sorted((row["descriptor"].get("subtype"), "stamp" in row["descriptor"], row["mapping_state"], row["product_id"])
                  for row in rows) == [("shadowless", False, "verified", 106999), ("shadowless", True, "verified", 106999),
                                               ("unlimited", False, "verified", 42382)]


def test_a_tcgdex_id_verified_on_another_printing_is_a_duplicate_and_v3_conflicts_stay_conflicts():
    reset_catalog()
    shared = [{"type": "holo", "size": "standard", "thirdParty": {"tcgplayer": 777}}]
    run(Records(promo("svp-1", "1", variants=shared), promo("svp-2", "2", name="Raichu", variants=shared)))
    activate(MATCHING, 4)
    assert sorted(states("svp-1") + states("svp-2")) == [("unverified", "duplicate_mapping", None, None), ("verified", None, 777, "holofoil")]
    reset_catalog()
    clash = card(1)
    for variant in clash["variants_detailed"]:
        variant["thirdParty"] = {"tcgplayer": 5}  # the block says 1001
    run(Records(clash))
    activate(MATCHING, 4)
    assert {row["mapping_reason"] for row in metadata()[1].values()} == {"rule_failed"}


def test_the_promo_path_is_a_card_number_and_exact_name_match(tcgplayer_products):
    reset_catalog()
    listing(900, "Chespin - XY01", "XY01", 1451)
    listing(901, "Tepig (BW02)", "BW02", 1407)
    run(Records(promo("xyp-1", "XY01", "xyp", "Chespin"), promo("bwp-2", "BW02", "bwp", "Tepig")))
    activate(MATCHING, 3)
    assert states("xyp-1") == [("unverified", "rule_failed", None, None)]
    activate(MATCHING, 4)
    assert states("xyp-1") == [("verified", None, 900, "holofoil")]
    assert states("bwp-2") == [("verified", None, 901, "holofoil")]


def test_a_set_outside_the_table_and_a_card_with_a_tcgdex_id_never_take_the_number_path(tcgplayer_products):
    reset_catalog()
    listing(900, "Chespin", "XY01", 1451)
    listing(901, "Furret", "136", 1451)
    run(Records(promo("other-1", "XY01", "swsh3", "Chespin"),
                promo("xyp-9", "XY01", "xyp", "Chespin", [{"type": "holo", "size": "standard", "thirdParty": {"tcgplayer": 12}}])))
    activate(MATCHING, 4)
    assert states("other-1") == [("unverified", "rule_failed", None, None)]
    assert states("xyp-9") == [("verified", None, 12, "holofoil")]  # its own id, never product 900


def candidates(*names, number="XY01"):
    return [{"product_id": 100 + index, "name": name, "number": number} for index, name in enumerate(names)]


def promo_facts(name="Chespin", number="XY01", set_id="xyp", descriptor=None, lookup=None, found=()):
    return facts(descriptor=descriptor or {"type": "holo", "size": "standard"}, lookup=lookup or {},
                 source_record={"set": {"id": set_id}, "localId": number, "name": name},
                 display={"set_id": set_id, "collector_number": number, "display_name": name}, tcgplayer_candidates=list(found))


def evaluate_v4(**changes):
    return MatchingRulesV4.evaluate(promo_facts(**changes), lambda product, variant: False)


def test_v4_name_rule_removes_one_qualifier_for_the_cards_own_number_only():
    for name, number, product in (("Chespin", "XY01", "Chespin - XY01"), ("Tepig", "BW02", "Tepig (BW02)"), ("Tepig", "BW02", "TEPIG  (bw002)")):
        assert evaluate_v4(name=name, number=number, found=candidates(product, number=number)) == (100, "holofoil"), product
    for name, number, product in (("Torterra", "DP09", "Torterra LV.X - DP09"), ("Minccino", "BW13", "Minccino - BW13 (Cosmos Holo)"),
                                  ("Dragalge", "XY10", "Dragalge - XY10 (Prerelease)"), ("Dragalge", "XY10", "Dragalge Spirit"),
                                  ("Tepig", "BW02", "Tepig (BW03)"), ("Tepig", "BW02", "Tepig - BW02 - BW02")):
        assert evaluate_v4(name=name, number=number, found=candidates(product, number=number)) == Failure("no_product"), product


def test_v4_collisions_need_exactly_one_exact_name_and_a_non_special_edition():
    found = candidates("Chespin [Staff]", "Chespin - XY01", "Chespin (Prerelease)")
    assert evaluate_v4(found=found) == (101, "holofoil")
    assert evaluate_v4(found=found, descriptor={"type": "holo", "stamp": ["staff"]}) == Failure("no_product")
    assert evaluate_v4(found=candidates("Chespin", "Chespin - XY01")) == Failure("no_product")  # two exact matches
    assert evaluate_v4(found=candidates("Chespin [Staff]")) == Failure("no_product")
    assert evaluate_v4(found=[]) == Failure("no_product")
    for descriptor in ({"type": "holo", "foil": "x"}, {"type": "holo", "subtype": "other"}, {"type": "holo", "size": "jumbo"}):
        assert evaluate_v4(found=candidates("Chespin"), descriptor=descriptor) == Failure("no_product")
    assert evaluate_v4(found=candidates("Chespin"), descriptor={"type": "holo", "stamp": ["1st-edition"]}) == (100, None)


def test_v4_number_path_has_its_own_duplicate_check_and_matched_by_number_follows_the_rule():
    assert MatchingRulesV4.evaluate(promo_facts(found=candidates("Chespin")), lambda product, variant: product == 100) == Failure("duplicate")
    assert MatchingRulesV4.matched_by_number(promo_facts())
    assert not MatchingRulesV4.matched_by_number(promo_facts(set_id="swsh3"))
    for lookup in ({"thirdParty": {"tcgplayer": 5}}, {"pricing": {"tcgplayer": {"normal": {"productId": 5}}}}):
        assert not MatchingRulesV4.matched_by_number(promo_facts(lookup=lookup))
    assert evaluate_v4(found=candidates("Chespin"), lookup={"thirdParty": {"tcgplayer": "5"}}) == Failure("no_product")  # an unusable id is still an id


def test_v4_number_path_never_applies_when_a_sibling_or_the_card_carries_a_tcgdex_id():
    """"No TCGdex id anywhere" covers the whole Printing, not only this Edition's own variant."""
    plain = {"type": "holo", "size": "standard"}
    sibling = {"type": "reverse", "size": "standard", "thirdParty": {"tcgplayer": 77}}
    records = ({"variants_detailed": [plain, sibling]},
               {"pricing": {"tcgplayer": {"holofoil": {"productId": 77}}}, "variants_detailed": [plain]},
               {"variants_detailed": [plain, {"type": "reverse", "pricing": {"tcgplayer": {"reverseHolofoil": {"productId": 78}}}}]})
    for extra in records:
        record = {"set": {"id": "xyp"}, "localId": "XY01", "name": "Chespin", **extra}
        given = promo_facts(found=candidates("Chespin"))
        given["source_record"] = record
        assert not MatchingRulesV4.matched_by_number(given), extra
        assert MatchingRulesV4.evaluate(given, lambda product, variant: False) == Failure("no_product"), extra
    clean = promo_facts(found=candidates("Chespin"))
    clean["source_record"] = {**clean["source_record"], "variants_detailed": [plain, {"type": "reverse", "size": "standard"}]}
    assert MatchingRulesV4.matched_by_number(clean)
    assert MatchingRulesV4.evaluate(clean, lambda product, variant: False) == (100, "holofoil")


@pytest.mark.parametrize("given,key", [("DP05", "DP5"), ("SWSH001", "SWSH1"), ("001", "1"), ("XY01", "XY1"), ("12/102", "12")])
def test_v4_number_key(given, key):
    assert MatchingRulesV4.number_key(given) == key


def test_v4_table_names_exactly_the_reviewed_groups():
    assert MatchingRulesV4.TCGPLAYER_GROUPS == {"basep": 1418, "np": 1423, "dpp": 1421, "hgssp": 1453, "bwp": 1407, "xyp": 1451,
                                                "smp": 1861, "swshp": 2545, "svp": 22872, "mep": 24451}


def test_activating_v4_re_evaluates_only_unverified_open_editions(tcgplayer_products):
    reset_catalog()
    listing(900, "Chespin", "XY01", 1451)
    activate(MATCHING, 3)
    run(Records(promo("xyp-1", "XY01", "xyp", "Chespin"), repeated_block(2), repeated_block(3)))
    with connect() as conn:
        conn.execute("""UPDATE catalog_edition_metadata SET mapping_state='quarantined',mapping_reason='candidate_changed',auto_closed=true
          WHERE edition_id IN (SELECT e.id FROM catalog_edition e JOIN catalog_printing p ON p.id=e.printing_id WHERE p.source_id='meta-2')""")
        conn.execute("""UPDATE catalog_edition_metadata SET mapping_state='unverified',mapping_reason='reviewed_unmapped',auto_closed=true
          WHERE edition_id IN (SELECT e.id FROM catalog_edition e JOIN catalog_printing p ON p.id=e.printing_id WHERE p.source_id='meta-3')""")
    before = {source: states(source) for source in ("meta-2", "meta-3")}
    activate(MATCHING, 4)
    assert {source: states(source) for source in ("meta-2", "meta-3")} == before
    assert states("xyp-1") == [("verified", None, 900, "holofoil")]


def test_an_activation_the_code_lacks_verifies_nothing_new_and_unmatches_nothing(monkeypatch):
    class Newer(MatchingRulesV4):
        pass
    reset_catalog()
    monkeypatch.setitem(MATCHING_RULES, 99, Newer)
    activate(MATCHING, 4)
    run(Records(card(1)))
    assert states("meta-1") == [("verified", None, 1001, "normal"), ("verified", None, 1001, "reverse-holofoil")] or \
        {row["mapping_state"] for row in metadata("meta-1")[1].values()} == {"verified"}
    activate(MATCHING, 99)
    del MATCHING_RULES[99]  # older code, after v99 was activated
    with connect() as conn:
        assert load_active(conn, MATCHING) is None
    run(Records(card(1), card(2)))
    assert {row["mapping_state"] for row in metadata("meta-1")[1].values()} == {"verified"}
    assert {(row["mapping_state"], row["mapping_reason"]) for row in metadata("meta-2")[1].values()} == {("unverified", "no_matching_rule")}


# ------------------------------------------------------------------ --rematch


def rematched():
    with connect() as conn:
        return rematch_promos(conn)


def test_rematch_verifies_an_edition_whose_product_appeared_later_and_touches_nothing_else(tcgplayer_products):
    reset_catalog()
    activate(MATCHING, 4)
    run(Records(promo("svp-1", "9", "svp", "Pikachu"), promo("xyp-27", "XY27", "xyp", "Zorua"), promo("xyp-28", "XY28", "xyp", "Zoroark"),
                promo("other-1", "5", "swsh3", "Nope"), repeated_block(3)))
    assert rematched() == 0  # no tcgplayer_product rows at all: everything stays rule_failed
    assert states("svp-1") == [("unverified", "rule_failed", None, None)]
    listing(910, "Pikachu", "009", 22872)
    listing(911, "Zorua - XY27", "XY27", 1451)
    listing(912, "Zorua [Staff]", "XY27", 1451)
    listing(913, "Zoroark", "XY28", 1451)
    listing(914, "Zoroark - XY28", "XY28", 1451)  # two exact matches
    listing(915, "Nope", "5", 1451)
    before = {source: metadata(source)[1] for source in ("other-1", "meta-3")}
    with connect() as conn:
        conn.execute("UPDATE catalog_edition_metadata SET mapping_reason='reviewed_unmapped' WHERE edition_id IN "
                     "(SELECT e.id FROM catalog_edition e JOIN catalog_printing p ON p.id=e.printing_id WHERE p.source_id='xyp-28')")
    assert rematched() == 2  # svp-1 and xyp-27
    assert states("svp-1") == [("verified", None, 910, "holofoil")]
    assert states("xyp-27") == [("verified", None, 911, "holofoil")]
    assert states("xyp-28")[0][1] == "reviewed_unmapped"
    assert states("other-1") == [("unverified", "rule_failed", None, None)]
    assert {source: metadata(source)[1] for source in ("other-1", "meta-3")} == before
    assert rematched() == 0


def test_rematch_does_nothing_without_an_active_matching_rule(tcgplayer_products):
    reset_catalog()
    listing(910, "Pikachu", "9", 22872)
    activate(MATCHING, 3)
    run(Records(promo("svp-1", "9", "svp", "Pikachu")))
    with connect() as conn:
        conn.execute("UPDATE catalog_rule_state SET activation_id=NULL WHERE kind='marketplace_matching'")
    before = states("svp-1")
    assert rematched() == 0
    assert states("svp-1") == before and before[0][0] == "unverified"


def test_rematch_two_products_on_a_number_stay_rule_failed(tcgplayer_products):
    reset_catalog()
    activate(MATCHING, 4)
    run(Records(promo("xyp-27", "XY27", "xyp", "Zorua")))
    listing(911, "Zorua - XY27", "XY27", 1451)
    listing(912, "Zorua (XY27)", "XY27", 1451)
    assert rematched() == 0
    assert states("xyp-27") == [("unverified", "rule_failed", None, None)]


def test_activate_rule_refuses_deactivation():
    reset_catalog()
    with connect() as conn, conn.transaction(), pytest.raises(ValueError, match="Deactivation was removed"):
        activate_rule(conn, LIVE, None, owner(), "https://example.org/rule", "Reviewed against the target")


# ------------------------------------------------------------------ matching rule v5 (P10 #376, P13 #380)


def with_card_id(record, product):
    record["thirdParty"] = {"tcgplayer": product}
    return record


def v5_facts(**changes):
    return facts(**{"source_record": {"set": {"id": "xy11"}, "localId": "116", "name": "Gardevoir EX"},
                    "display": {"set_id": "xy11", "collector_number": "116", "display_name": "Gardevoir EX"}, **changes})


def evaluate_v5(**changes):
    return MatchingRulesV5.evaluate(v5_facts(**changes), lambda product, variant: False)


def block(*keys, product=10):
    return {"pricing": {"tcgplayer": {"unit": "USD", **{key: {"productId": product} for key in keys}}}, "thirdParty": {"tcgplayer": product}}


def card_level(product, **record):
    return {"source_record": {"set": {"id": "xy11"}, "localId": "116", "name": "Gardevoir EX", "thirdParty": {"tcgplayer": product}, **record},
            "card_tcgplayer": product, "lookup": {"variantId": "generated"}}


def test_v5_table_is_v4s_plus_the_30th_sets_and_registered_as_5():
    assert MatchingRulesV5.TCGPLAYER_GROUPS == {**MatchingRulesV4.TCGPLAYER_GROUPS, "30th": 24722, "30th-c": 24837}
    assert MatchingRulesV5.NAME_ONLY_SETS == frozenset({"30th-c"})
    assert MATCHING_RULES[5] is MatchingRulesV5 and "30th" not in MatchingRulesV4.TCGPLAYER_GROUPS
    assert MatchingRulesV5.table()["name_only_sets"] == ["30th-c"]


def test_v5_card_product_needs_a_plain_edition_and_a_variant_without_a_tcgdex_id():
    assert MatchingRulesV4.evaluate(v5_facts(**card_level(121240)), lambda p, v: False) == Failure("no_product")
    assert evaluate_v5(**card_level(121240)) == (121240, "normal")
    for descriptor in ({"type": "normal", "stamp": ["staff"]}, {"type": "normal", "foil": "cosmos"}, {"type": "normal", "size": "jumbo"},
                       {"type": "normal", "subtype": "other"}):
        assert evaluate_v5(descriptor=descriptor, **card_level(121240)) == Failure("no_product"), descriptor
    assert evaluate_v5(descriptor={"type": "normal", "stamp": ["1st-edition"]}, **card_level(121240)) == (121240, None)
    for bad in (True, "5", 0, -3, 2**31, 1.0, None):
        assert evaluate_v5(**card_level(bad)) == Failure("no_product"), bad
    sibling = {"set": {"id": "xy11"}, "localId": "116", "name": "Gardevoir EX", "thirdParty": {"tcgplayer": 121240},
               "variants_detailed": [{"type": "normal"}, {"type": "reverse", "thirdParty": {"tcgplayer": 9}}]}
    assert evaluate_v5(source_record=sibling, card_tcgplayer=121240, lookup={"variantId": "x"}) == Failure("no_product")  # a sibling has its own id
    assert evaluate_v5(**{**card_level(121240), "lookup": {"thirdParty": {"tcgplayer": 7}}}) == (7, "normal")  # the variant's own id wins
    assert evaluate_v5(**{**card_level(121240), "lookup": {"thirdParty": {"tcgplayer": "x"}}}) == Failure("no_product")
    assert evaluate_v5(**{**card_level(121240), "correspondence": "printing_level"}) == Failure("not_established")
    assert MatchingRulesV5.evaluate(v5_facts(**card_level(121240)), lambda product, variant: product == 121240) == Failure("duplicate")


def test_v5_shared_block_accepts_one_product_under_several_keys_only_when_it_is_the_variants_own_id():
    for keys, descriptor, expected in (
            (("1st-edition", "unlimited"), {"type": "normal"}, (10, "normal")),
            (("1st-edition", "unlimited"), {"type": "normal", "stamp": ["1st-edition"]}, (10, None)),
            (("1st-edition-holofoil", "unlimited-holofoil"), {"type": "holo"}, (10, "holofoil")),
            (("normal", "reverse-holofoil", "holofoil"), {"type": "holo", "subtype": "unlimited"}, (10, None))):
        given = v5_facts(lookup=block(*keys), descriptor=descriptor)
        assert MatchingRulesV4.evaluate(given, lambda p, v: False) == Failure("conflict"), keys
        assert MatchingRulesV5.evaluate(given, lambda p, v: False) == expected, keys
        assert MatchingRulesV5.evaluate(given, lambda p, v: p == 10) == Failure("duplicate"), keys
    two = block("1st-edition", "unlimited")
    two["pricing"]["tcgplayer"]["unlimited"]["productId"] = 11
    different_own = {**block("1st-edition", "unlimited"), "thirdParty": {"tcgplayer": 11}}
    no_own = {"pricing": block("1st-edition", "unlimited")["pricing"]}
    odd = block("1st-edition", "unlimited")
    odd["pricing"]["tcgplayer"]["unlimited"]["productId"] = True
    for lookup in (two, different_own, no_own, odd):
        assert MatchingRulesV5.evaluate(v5_facts(lookup=lookup), lambda p, v: False) == Failure("conflict"), lookup
    # No key fits the Edition's finish (swsh9tg TG24, hgss2-26): TCGdex's id may belong to another card.
    for keys, descriptor in ((("normal", "reverse-holofoil"), {"type": "holo"}), (("holofoil", "reverse-holofoil"), {"type": "normal"}),
                             (("normal", "holofoil"), {"type": "reverse"})):
        assert MatchingRulesV5.evaluate(v5_facts(lookup=block(*keys), descriptor=descriptor), lambda p, v: False) == Failure("conflict"), keys
    for descriptor in ({"type": "reverse", "stamp": ["set-logo"]}, {"type": "normal", "foil": "cosmos"}, {"type": "normal", "stamp": ["staff"]}):
        given = v5_facts(lookup=block("normal", "reverse-holofoil"), descriptor=descriptor)
        assert MatchingRulesV5.evaluate(given, lambda p, v: False) == Failure("conflict"), descriptor


def test_v5_name_only_set_needs_one_exact_numbered_product_and_a_unique_name_in_the_set():
    def classic(name="Charizard", count=1, found=None, **changes):
        found = [{"product_id": 1, "name": "Charizard", "number": "4/102"}] if found is None else found
        return MatchingRulesV5.evaluate(
            facts(**{"source_record": {"set": {"id": "30th-c"}, "localId": "001", "name": name},
                     "display": {"set_id": "30th-c", "collector_number": "001", "display_name": name}, "tcgplayer_candidates": found,
                     "set_name_count": count, "descriptor": {"type": "holo"}, **changes}), lambda p, v: False)
    assert classic() == (1, "holofoil")
    assert classic(count=2) == Failure("no_product")
    assert classic(name="Metagross", found=[{"product_id": 2, "name": "Metagross (Delta Species)", "number": "1/10"}]) == Failure("no_product")
    assert classic(found=[{"product_id": 1, "name": "Charizard", "number": "4/102"},
                          {"product_id": 2, "name": "charizard", "number": "5/102"}]) == Failure("no_product")
    assert classic(found=[{"product_id": 1, "name": "Charizard", "number": None}]) == Failure("no_product")
    assert classic(found=[{"product_id": 1, "name": "Charizard - 001", "number": "001"}]) == Failure("no_product")  # no qualifier is stripped
    assert classic(descriptor={"type": "holo", "stamp": ["staff"]}) == Failure("no_product")
    assert classic(lookup={"thirdParty": {"tcgplayer": 5}}) == (5, "holofoil")  # a TCGdex id never takes the set path


def xy11_116(source_id="xy11-116", number="116", product=121240, variants=None):
    return with_card_id(promo(source_id, number, "xy11", "Gardevoir EX", variants or [{"type": "normal", "size": "standard"}]), product)


def stock_prices(*rows):
    with connect() as conn:
        for product, sub_type in rows:
            conn.execute("INSERT INTO tcgplayer_price(product_id,sub_type_name,market_price,seen_at,source_updated_at) VALUES (%s,%s,1,now(),now())",
                         (product, sub_type))


def bound_sub_types():
    from app.price_binding import rebind
    with connect() as conn:
        rebind(conn)
        return sorted((row["product_id"], row["sub_type_name"]) for row in conn.execute("SELECT * FROM edition_price_binding"))


def test_v5_verifies_a_card_level_id_where_v4_fails_and_the_binding_picks_the_offered_subtype(tcgplayer_products):
    reset_catalog()
    run(Records(xy11_116()))
    activate(MATCHING, 4)
    assert states("xy11-116") == [("unverified", "rule_failed", None, None)]
    assert activate(MATCHING, 5) == {"printings": 0, "editions": 1}
    assert states("xy11-116") == [("verified", None, 121240, "normal")]
    stock_prices((121240, "Holofoil"))
    assert bound_sub_types() == [(121240, "Holofoil")]
    stock_prices((121240, "Normal"))
    assert bound_sub_types() == [(121240, "Normal")]


def test_v5_card_level_id_covers_normal_and_reverse_siblings_but_not_stamped_variants_or_variants_with_their_own_id(tcgplayer_products):
    reset_catalog()
    run(Records(
        xy11_116("two-1", "1", 500, [{"type": "normal", "size": "standard"}, {"type": "reverse", "size": "standard"}]),
        xy11_116("stamp-2", "2", 501, [{"type": "normal", "size": "standard", "stamp": ["staff"]}]),
        xy11_116("own-3", "3", 502, [{"type": "normal", "size": "standard", "thirdParty": {"tcgplayer": 599}}])))
    activate(MATCHING, 5)
    assert states("two-1") == [("verified", None, 500, "normal"), ("verified", None, 500, "reverse-holofoil")]
    assert states("stamp-2") == [("unverified", "rule_failed", None, None)]
    assert states("own-3") == [("verified", None, 599, "normal")]
    stock_prices((500, "Normal"), (500, "Reverse Holofoil"))
    assert [item for item in bound_sub_types() if item[0] == 500] == [(500, "Normal"), (500, "Reverse Holofoil")]


def test_v5_card_level_id_held_by_another_printing_is_a_duplicate(tcgplayer_products):
    reset_catalog()
    run(Records(xy11_116("a-1", "1", 500), xy11_116("b-2", "2", 500)))
    activate(MATCHING, 5)
    assert sorted(states("a-1") + states("b-2")) == [("unverified", "duplicate_mapping", None, None), ("verified", None, 500, "normal")]


def gym(source_id, number, product, variants):
    record = promo(source_id, number, "gym1", "Blaine's Moltres", variants)
    return record


def shared(descriptor, product, *keys, own=None):
    return {**descriptor, "size": "standard", "thirdParty": {"tcgplayer": own or product},
            "pricing": {"tcgplayer": {"unit": "USD", **{key: {"productId": product} for key in keys}}}}


def test_v5_shared_block_binds_unlimited_and_the_first_edition_sibling_and_leaves_other_conflicts(tcgplayer_products):
    reset_catalog()
    keys = ("1st-edition", "unlimited")
    run(Records(
        gym("gym-1", "1", 700, [shared({"type": "normal"}, 700, *keys), shared({"type": "normal", "stamp": ["1st-edition"]}, 700, *keys)]),
        gym("gym-2", "2", 701, [shared({"type": "holo"}, 701, "1st-edition-holofoil", "unlimited-holofoil"),
                                shared({"type": "holo", "stamp": ["1st-edition"]}, 701, "1st-edition-holofoil", "unlimited-holofoil")]),
        gym("gym-3", "3", 702, [shared({"type": "normal"}, 702, *keys, own=9)]),
        gym("gym-4", "4", 703, [shared({"type": "reverse", "stamp": ["set-logo"]}, 703, "normal", "reverse-holofoil")])))
    activate(MATCHING, 4)
    assert {row["mapping_reason"] for source in ("gym-1", "gym-2", "gym-3", "gym-4") for row in metadata(source)[1].values()} == {"rule_failed"}
    activate(MATCHING, 5)
    def by_stamp(source_id):
        with connect() as conn:
            return {"1st-edition" in row["descriptor"].get("stamp", []): (row["mapping_state"], row["product_id"], row["quote_variant"])
                    for row in conn.execute("""SELECT e.descriptor,m.* FROM catalog_edition e JOIN catalog_edition_metadata m ON m.edition_id=e.id
                      JOIN catalog_printing p ON p.id=e.printing_id WHERE p.source_id=%s""", (source_id,))}
    assert by_stamp("gym-1") == {False: ("verified", 700, "normal"), True: ("verified", 700, None)}
    assert by_stamp("gym-2") == {False: ("verified", 701, "holofoil"), True: ("verified", 701, None)}
    assert states("gym-3") == [("unverified", "rule_failed", None, None)]
    assert states("gym-4") == [("unverified", "rule_failed", None, None)]
    stock_prices((700, "1st Edition"), (700, "Unlimited"), (701, "1st Edition Holofoil"), (701, "Unlimited Holofoil"))
    with connect() as conn:
        from app.price_binding import rebind
        rebind(conn)
        rows = conn.execute("""SELECT e.descriptor,b.sub_type_name FROM edition_price_binding b JOIN catalog_edition e ON e.id=b.edition_id""").fetchall()
    assert sorted(("1st-edition" in row["descriptor"].get("stamp", []), row["sub_type_name"]) for row in rows) == [
        (False, "Unlimited"), (False, "Unlimited Holofoil"), (True, "1st Edition"), (True, "1st Edition Holofoil")]


def thirty(source_id, number, name, set_id="30th", **extra):
    return {**promo(source_id, number, set_id, name), **extra}


def thirty_products():
    listing(800, "Greninja ex - 021/128", "021/128", 24722)
    listing(801, "Nidoran F - 087/128", "087/128", 24722)
    with connect() as conn:  # a sealed product: no number, never a candidate
        conn.execute("""INSERT INTO tcgplayer_product(product_id,group_id,name,number,number_key,seen_at,source_updated_at)
          VALUES (809,24722,'Greninja ex',NULL,NULL,now(),now())""")
    listing(810, "Charizard", "4/102", 24837)
    listing(811, "Metagross (Delta Species)", "5/102", 24837)
    listing(812, "Pikachu", "6/102", 24837)
    listing(813, "Pikachu", "7/102", 24837)
    listing(814, "Eevee", "8/102", 24837)


def test_v5_30th_sets_match_by_number_and_name_and_by_name_alone(tcgplayer_products):
    reset_catalog()
    thirty_products()
    run(Records(thirty("th-21", "021", "Greninja ex", image="https://assets.tcgdex.net/en/me/30th/021"),
                thirty("th-87", "087", "Nidoran♀"),
                thirty("c-1", "001", "Charizard", "30th-c"), thirty("c-3", "003", "Metagross", "30th-c"),
                thirty("c-6", "006", "Pikachu", "30th-c"), thirty("c-7", "007", "Eevee", "30th-c"),
                thirty("c-8", "008", "Eevee", "30th-c")))
    activate(MATCHING, 4)
    assert states("th-21") == [("unverified", "rule_failed", None, None)]
    activate(MATCHING, 5)
    assert states("th-21") == [("verified", None, 800, "holofoil")]
    assert states("th-87") == [("unverified", "rule_failed", None, None)]
    assert states("c-1") == [("verified", None, 810, "holofoil")]
    for source in ("c-3", "c-6", "c-7", "c-8"):  # a delta-species name, two products, and two Printings sharing a name
        assert states(source) == [("unverified", "rule_failed", None, None)], source


def test_v5_30th_classic_printing_gets_tcgplayer_art_and_a_30th_printing_keeps_its_tcgdex_image(tcgplayer_products):
    from app import card_art
    reset_catalog()
    thirty_products()
    with connect() as conn:
        conn.execute("UPDATE tcgplayer_product SET image_count=1 WHERE product_id IN (800,810)")
    run(Records(thirty("th-21", "021", "Greninja ex", image="https://assets.tcgdex.net/en/me/30th/021"),
                thirty("c-1", "001", "Charizard", "30th-c")))
    activate(MATCHING, 5)
    with connect() as conn:
        card_art.refresh_fallbacks(conn)
        chosen = {row["source_id"]: row["product_id"] for row in conn.execute(
            "SELECT p.source_id,f.product_id FROM catalog_printing_fallback_art f JOIN catalog_printing p ON p.id=f.printing_id")}
    assert chosen == {"c-1": 810}


def test_v5_rematch_picks_up_a_30th_product_listed_after_activation(tcgplayer_products):
    reset_catalog()
    activate(MATCHING, 5)
    run(Records(thirty("th-21", "021", "Greninja ex"), thirty("c-1", "001", "Charizard", "30th-c")))
    assert rematched() == 0
    assert states("th-21") == [("unverified", "rule_failed", None, None)]
    listing(800, "Greninja ex - 021/128", "021/128", 24722)
    listing(810, "Charizard", "4/102", 24837)
    assert rematched() == 2
    assert states("th-21") == [("verified", None, 800, "holofoil")] and states("c-1") == [("verified", None, 810, "holofoil")]


def test_v5_tables_follow_the_active_rule_and_v4_ignores_the_30th_sets(tcgplayer_products):
    from app.catalog_targets import reviewed_rule, tcgplayer_candidates
    thirty_products()
    with connect() as conn:
        assert reviewed_rule(None) is MatchingRulesV6 and reviewed_rule(load_active(conn, MATCHING)) is MatchingRulesV6
        assert [item["product_id"] for item in tcgplayer_candidates(conn, "30th-c", "001")] == [810, 811, 812, 813, 814]
        assert [item["product_id"] for item in tcgplayer_candidates(conn, "30th", "21")] == [800]
        assert tcgplayer_candidates(conn, "30th", "") == []
    reset_catalog()
    run(Records(thirty("th-21", "021", "Greninja ex")))
    activate(MATCHING, 4)
    assert rematched() == 0 and states("th-21") == [("unverified", "rule_failed", None, None)]


def test_v5_card_level_id_change_quarantines_an_edition_verified_from_it(tcgplayer_products):
    reset_catalog()
    run(Records(xy11_116()))
    activate(MATCHING, 5)
    assert states("xy11-116") == [("verified", None, 121240, "normal")]
    run(Records(xy11_116(product=121241)))
    assert states("xy11-116") == [("quarantined", "candidate_changed", 121240, "normal")]
    reset_catalog()
    run(Records(xy11_116()))
    activate(MATCHING, 5)
    run(Records(with_card_id({**xy11_116(), "rarity": "Rare"}, 121240)))  # an unrelated change is accepted silently
    assert states("xy11-116") == [("verified", None, 121240, "normal")]


def test_v5_name_only_count_folds_case_like_the_name_match(tcgplayer_products):
    reset_catalog()
    thirty_products()
    run(Records(thirty("c-7", "007", "Eevee", "30th-c"), thirty("c-8", "008", "EEVEE", "30th-c")))
    activate(MATCHING, 5)
    assert states("c-7") == [("unverified", "rule_failed", None, None)] == states("c-8")


def test_v5_activation_rechecks_only_unverified_editions_that_are_not_auto_closed(tcgplayer_products):
    reset_catalog()
    run(Records(xy11_116("open-1", "1", 500), xy11_116("closed-2", "2", 501), xy11_116("quarantined-3", "3", 502),
                xy11_116("decided-4", "4", 503)))
    activate(MATCHING, 4)
    with connect() as conn:
        def mark(source, sql):
            conn.execute(f"""UPDATE catalog_edition_metadata SET {sql} WHERE edition_id IN (SELECT e.id FROM catalog_edition e
              JOIN catalog_printing p ON p.id=e.printing_id WHERE p.source_id=%s)""", (source,))
        mark("closed-2", "auto_closed=true")
        mark("quarantined-3", "mapping_state='quarantined',mapping_reason='candidate_changed',auto_closed=true")
        mark("decided-4", "mapping_reason='reviewed_unmapped',auto_closed=true")
    before = {source: states(source) for source in ("closed-2", "quarantined-3", "decided-4")}
    assert activate(MATCHING, 5) == {"printings": 0, "editions": 1}
    assert states("open-1") == [("verified", None, 500, "normal")]
    assert {source: states(source) for source in before} == before


def strip_card_field(source_id):
    """Rewrite an Edition's stored candidate to the shape written before the card-level ID was kept."""
    with connect() as conn:
        conn.execute("""UPDATE catalog_edition_metadata SET mapping_candidate=mapping_candidate-'card_tcgplayer' WHERE edition_id IN
          (SELECT e.id FROM catalog_edition e JOIN catalog_printing p ON p.id=e.printing_id WHERE p.source_id=%s)""", (source_id,))


def accepted_projection_of(source_id):
    with connect() as conn:
        return conn.execute("""SELECT m.accepted_fingerprint,m.accepted_projection,m.mapping_revision FROM catalog_edition_metadata m
          JOIN catalog_edition e ON e.id=m.edition_id JOIN catalog_printing p ON p.id=e.printing_id WHERE p.source_id=%s""",
                            (source_id,)).fetchone()


def test_v5_over_candidates_stored_before_the_card_field_never_quarantines_on_the_next_import(tcgplayer_products):
    reset_catalog()
    run(Records(xy11_116()))
    strip_card_field("xy11-116")  # stored before the field existed
    activate(MATCHING, 5)  # the rollout applies v5 before any import: nothing in the candidate names the card's product yet
    assert states("xy11-116") == [("unverified", "rule_failed", None, None)]
    run(Records(xy11_116()))  # the next import writes the field and the rule can now verify
    assert states("xy11-116") == [("verified", None, 121240, "normal")]
    run(Records(xy11_116()))
    assert states("xy11-116") == [("verified", None, 121240, "normal")]


def test_v5_a_gained_card_field_is_enrichment_and_a_later_change_or_removal_quarantines(tcgplayer_products):
    reset_catalog()
    run(Records(xy11_116()))
    activate(MATCHING, 5)
    assert states("xy11-116") == [("verified", None, 121240, "normal")]
    strip_card_field("xy11-116")
    with connect() as conn:  # the accepted projection a v5 activation over the old candidate shape would have stored
        from app.catalog_targets import fingerprint, rule_projection
        row = conn.execute("""SELECT m.edition_id,m.mapping_candidate FROM catalog_edition_metadata m JOIN catalog_edition e ON e.id=m.edition_id
          JOIN catalog_printing p ON p.id=e.printing_id WHERE p.source_id='xy11-116'""").fetchone()
        conn.execute("UPDATE catalog_edition_metadata SET accepted_fingerprint=%s,accepted_projection=%s WHERE edition_id=%s",
                     (fingerprint(row["mapping_candidate"]), fingerprint(rule_projection(row["mapping_candidate"])), row["edition_id"]))
    revision = accepted_projection_of("xy11-116")["mapping_revision"]
    run(Records(xy11_116()))
    assert states("xy11-116") == [("verified", None, 121240, "normal")]
    after = accepted_projection_of("xy11-116")
    with connect() as conn:
        stored = conn.execute("SELECT mapping_candidate FROM catalog_edition_metadata WHERE edition_id=%s",
                              (row["edition_id"],)).fetchone()["mapping_candidate"]
    assert stored["card_tcgplayer"] == 121240 and after["mapping_revision"] == revision
    assert after["accepted_projection"] == fingerprint(rule_projection(stored)) and after["accepted_fingerprint"] == fingerprint(stored)
    run(Records(xy11_116(product=121241)))
    assert states("xy11-116") == [("quarantined", "candidate_changed", 121240, "normal")]
    reset_catalog()
    run(Records(xy11_116()))
    activate(MATCHING, 5)
    removed = xy11_116()
    del removed["thirdParty"]  # the card-level id is removed
    run(Records(removed))
    assert states("xy11-116") == [("quarantined", "candidate_changed", 121240, "normal")]


# ------------------------------------------------------------------ matching rule v6 (P12 #378)


REPORT = Path(__file__).resolve().parents[2] / "docs/planning/tcgcsv-prices/set-groups-report.md"
SCRIPT = Path(__file__).resolve().parents[2] / "scripts/propose_set_groups.py"


def v6_facts(name="Ampharos δ", number="1", set_id="ex15", descriptor=None, lookup=None, found=(), record=None):
    return facts(descriptor=descriptor or {"type": "holo", "size": "standard"}, lookup=lookup or {},
                 source_record=record or {"set": {"id": set_id}, "localId": number, "name": name},
                 display={"set_id": set_id, "collector_number": number, "display_name": name}, tcgplayer_candidates=list(found))


def evaluate_v6(rule=MatchingRulesV6, **changes):
    return rule.evaluate(v6_facts(**changes), lambda product, variant: False)


def named(*names, number="1"):
    return [{"product_id": 100 + index, "name": name, "number": number} for index, name in enumerate(names)]


def test_v6_is_registered_as_6_and_adds_only_the_reviewed_sets_to_v5s_table():
    assert MATCHING_RULES[6] is MatchingRulesV6
    assert set(MatchingRulesV6.TCGPLAYER_GROUPS) == set(MatchingRulesV5.TCGPLAYER_GROUPS) | set(MatchingRulesV6.TCGPLAYER_SET_GROUPS)
    assert not set(MatchingRulesV5.TCGPLAYER_GROUPS) & set(MatchingRulesV6.TCGPLAYER_SET_GROUPS)
    assert MatchingRulesV6.TCGPLAYER_SET_GROUPS["bw11"] == (1409, 1465) and MatchingRulesV6.TCGPLAYER_SET_GROUPS["g1"] == (1728, 1729)
    assert MatchingRulesV6.TCGPLAYER_SET_GROUPS["sma"] == (2594,)
    assert not {"basep", "svp", "30th", "30th-c"} & set(MatchingRulesV6.TCGPLAYER_SET_GROUPS)
    assert MatchingRulesV6.table()["tcgplayer_set_groups"]["bw11"] == [1409, 1465]
    assert len(MatchingRulesV6.TCGPLAYER_SET_GROUPS) == 50


def report_table():
    """{set id: groups} read from the Summary table of the owner-reviewed report."""
    summary = REPORT.read_text(encoding="utf-8").split("## Summary")[1].split("## Doubtful")[0]
    return {set_id: tuple(int(group.split()[0]) for group in groups.split("; "))
            for set_id, groups in re.findall(r"^\| `([^`]+)` \| [^|]* \| ([^|]*) \|", summary, re.M)}


def load_script():
    import importlib.util
    spec = importlib.util.spec_from_file_location("propose_set_groups", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_v6_set_table_equals_the_sets_the_owner_accepted_in_the_report():
    report = REPORT.read_text(encoding="utf-8")
    assert "## Owner review" in report and "2026-10-27" in report.split("## Summary")[0]
    assert report_table() == MatchingRulesV6.TCGPLAYER_SET_GROUPS
    assert load_script().OWNER_REVIEW in report


EQUIVALENCE_CASES = ["Ampharos δ", "Ampharos (Delta Species)", "Deoxys (Delta Species - Attack Forme)", "Leafeon-GX", "Leafeon GX",
                     "Victini-EX", "Mew-V", "Mew VMAX", "Arceus-VSTAR", "Mew-ex", "Flabébé", "Flabebe", "Farfetch’d", "Farfetch'd",
                     "Gengar (Prime)", "Gengar", "Torterra LV.X", "Poké Ball", "Pokémon Rumble δ", "Ho-Oh", "Porygon-Z", "Mr. Mime",
                     "A-V", "Ex-Man", "Tapu Koko-GX δ", "  Eevee  "]


def test_v6_name_equivalences_agree_with_the_proposal_script():
    script = load_script()
    for name in EQUIVALENCE_CASES:
        folded = MatchingRulesV6.fold(name)
        assert MatchingRulesV6.equivalent(folded) == script.apply_equivalences(folded, script.ALL_EQUIVALENCES)[0], name
        assert MatchingRulesV6.fold(name) == script.fold(name), name
    assert script.DELTA.pattern == MatchingRulesV6.DELTA.pattern
    assert script.HYPHEN_SUFFIX.pattern == MatchingRulesV6.HYPHEN_SUFFIX.pattern
    assert script.CURLY_APOSTROPHES == MatchingRulesV6.CURLY_APOSTROPHES
    assert {"\u2019", "\u2018", "\u02bc", "`"} == {chr(code) for code in MatchingRulesV6.CURLY_APOSTROPHES}
    for code in [*range(0xC0, 0x250), *range(0x300, 0x370), 0xFE0F]:
        char = chr(code)
        assert MatchingRulesV6.strip_accents(char) == script.strip_accents(char), hex(code)
        assert MatchingRulesV6.strip_accents("a" + char + "b") == script.strip_accents("a" + char + "b"), hex(code)
    assert tuple(script.ALL_EQUIVALENCES - script.CORE_EQUIVALENCES) and set(MatchingRulesV6.EQUIVALENCES) == set(script.ALL_EQUIVALENCES)
    for number in ("1", "001", "SV46", "12/102", "", None):
        assert MatchingRulesV6.number_key(number) == script.number_key(number), number
    for product, number in (("Ampharos (Delta Species)", "1"), ("Leafeon GX - SV46", "SV46"), ("Pikachu (12)", "12/102")):
        assert MatchingRulesV6.match_name(product, number) == script.strip_number_qualifier(product, number), product


def test_v6_matches_the_reviewed_name_equivalences_in_a_listed_set():
    assert evaluate_v6(found=named("Ampharos (Delta Species)")) == (100, "holofoil")
    assert evaluate_v6(name="Leafeon-GX", number="SV46", set_id="sma", found=named("Leafeon GX", number="SV46")) == (100, "holofoil")
    assert evaluate_v6(name="Leafeon GX", number="SV46", set_id="sma", found=named("Leafeon-GX - SV46", number="SV46")) == (100, "holofoil")
    assert evaluate_v6(name="Mew-ex", set_id="bw4", found=named("Mew ex")) == (100, "holofoil")
    assert evaluate_v6(name="Farfetch’d", set_id="bw4", found=named("Farfetch'd")) == (100, "holofoil")
    assert evaluate_v6(name="Flabébé", set_id="bw4", found=named("Flabebe")) == (100, "holofoil")
    assert evaluate_v6(name="Flabebe", set_id="bw4", found=named("Flabébé")) == (100, "holofoil")


def test_v6_leaves_everything_else_unfolded():
    assert evaluate_v6(name="Deoxys δ", found=named("Deoxys (Delta Species - Attack Forme)")) == Failure("no_product")
    assert evaluate_v6(name="Gengar", set_id="bw4", found=named("Gengar (Prime)")) == Failure("no_product")
    assert evaluate_v6(name="Torterra", set_id="bw4", found=named("Torterra LV.X")) == Failure("no_product")
    assert evaluate_v6(name="Pikachu", set_id="bw4", found=named("Pikachu [Cosmos Holo]")) == Failure("no_product")
    assert evaluate_v6(found=named("Ampharos")) == Failure("no_product")
    assert evaluate_v6(found=[]) == Failure("no_product")


def test_v6_needs_exactly_one_equivalent_product_across_the_groups_and_never_matches_a_special_edition():
    assert evaluate_v6(found=named("Ampharos (Delta Species)", "Ampharos δ")) == Failure("no_product")  # two products claim it
    two_groups = named("Ampharos (Delta Species)", "Ampharos (Delta Species) [Radiant]")
    assert evaluate_v6(found=two_groups) == (100, "holofoil")
    for descriptor in ({"type": "holo", "stamp": ["staff"]}, {"type": "holo", "subtype": "other"}, {"type": "holo", "size": "jumbo"}):
        assert evaluate_v6(descriptor=descriptor, found=named("Ampharos (Delta Species)")) == Failure("no_product"), descriptor
    assert evaluate_v6(descriptor={"type": "holo", "stamp": ["1st-edition"]}, found=named("Ampharos (Delta Species)")) == (100, None)
    assert MatchingRulesV6.evaluate(v6_facts(found=named("Ampharos (Delta Species)")), lambda product, variant: product == 100) == Failure("duplicate")


def test_v6_a_card_with_any_tcgdex_id_never_takes_the_set_path():
    plain = {"type": "holo", "size": "standard"}
    sibling = {"type": "reverse", "size": "standard", "thirdParty": {"tcgplayer": 77}}
    records = ({"variants_detailed": [plain, sibling]}, {"thirdParty": {"tcgplayer": 77}},
               {"pricing": {"tcgplayer": {"holofoil": {"productId": 77}}}, "variants_detailed": [plain]})
    for extra in records:
        given = v6_facts(found=named("Ampharos (Delta Species)"), record={"set": {"id": "ex15"}, "localId": "1", "name": "Ampharos δ", **extra})
        assert not MatchingRulesV6.matched_by_number(given), extra
        assert MatchingRulesV6.evaluate(given, lambda product, variant: False) != (100, "holofoil"), extra
    assert MatchingRulesV6.evaluate(v6_facts(found=named("Ampharos (Delta Species)"), lookup={"thirdParty": {"tcgplayer": 5}}),
                                    lambda product, variant: False) == (5, "holofoil")
    assert MatchingRulesV6.matched_by_number(v6_facts())
    assert not MatchingRulesV6.matched_by_number(v6_facts(set_id="swsh3"))


def test_v6_does_not_change_v5s_exact_names_in_v5s_sets_and_v5_ignores_the_new_sets():
    assert evaluate_v6(name="Chespin δ", number="XY01", set_id="xyp", found=named("Chespin (Delta Species)", number="XY01")) == Failure("no_product")
    assert evaluate_v6(name="Chespin", number="XY01", set_id="xyp", found=named("Chespin - XY01", number="XY01")) == (100, "holofoil")
    assert evaluate_v6(rule=MatchingRulesV5, found=named("Ampharos (Delta Species)")) == Failure("no_product")


def v6_products():
    listing(1, "Ampharos (Delta Species)", "1/101", 1411)
    listing(2, "Deoxys (Delta Species - Attack Forme)", "3/101", 1411)
    listing(3, "Leafeon GX", "SV46/SV94", 2594)
    listing(4, "Leafeon-GX", "SV46/SV94", 2781)  # Shining Fates: not a group of sma
    listing(5, "Radiant Charizard", "RC1/RC25", 1465)
    listing(6, "Gengar (Prime)", "9/101", 1411)
    listing(7, "Farfetch'd", "5/101", 1411)
    listing(8, "Flabebe", "6/101", 1411)
    listing(9, "Mew", "1/110", 1409)
    listing(10, "Mew", "1/110", 1465)
    listing(11, "Ampharos (Delta Species)", "2/101", 1411)


def v6_cards():
    return Records(promo("ex15-1", "1", "ex15", "Ampharos δ"), promo("ex15-3", "3", "ex15", "Deoxys δ"),
                   promo("sma-46", "SV46", "sma", "Leafeon-GX"), promo("bw11-rc1", "RC1", "bw11", "Radiant Charizard"),
                   promo("ex15-9", "9", "ex15", "Gengar"), promo("ex15-5", "5", "ex15", "Farfetch’d"),
                   promo("ex15-6", "6", "ex15", "Flabébé"),
                   promo("bw11-1", "1", "bw11", "Mew"),  # one Mew on the number in each of bw11's two groups: a collision
                   promo("ex15-id", "2", "ex15", "Ampharos δ", [{"type": "holo", "size": "standard", "thirdParty": {"tcgplayer": 12}}]),
                   promo("swsh9-1", "1", "swsh9", "Ampharos δ"))


def test_v6_verifies_the_reviewed_set_cards_where_v5_fails_and_leaves_the_rest(tcgplayer_products):
    reset_catalog()
    v6_products()
    run(v6_cards())
    activate(MATCHING, 5)
    assert states("ex15-1") == [("unverified", "rule_failed", None, None)]
    activate(MATCHING, 6)
    assert states("ex15-1") == [("verified", None, 1, "holofoil")]
    assert states("sma-46") == [("verified", None, 3, "holofoil")]  # never 4, which sits in Shining Fates' group
    assert states("bw11-rc1") == [("verified", None, 5, "holofoil")]  # its product lives in Radiant Collection 1465
    assert states("ex15-5") == [("verified", None, 7, "holofoil")] and states("ex15-6") == [("verified", None, 8, "holofoil")]
    assert states("bw11-1") == [("unverified", "rule_failed", None, None)]  # Mew is on the number in both groups
    for source in ("ex15-3", "ex15-9", "swsh9-1"):  # forme qualifier, (Prime), a set outside the table
        assert states(source) == [("unverified", "rule_failed", None, None)], source
    assert states("ex15-id") == [("verified", None, 12, "holofoil")]  # its own id, never product 1


def test_v6_rematch_picks_up_a_product_listed_after_activation_in_any_group_of_a_set(tcgplayer_products):
    reset_catalog()
    activate(MATCHING, 6)
    run(Records(promo("bw11-rc1", "RC1", "bw11", "Radiant Charizard"), promo("g1-5", "5", "g1", "Venusaur-EX")))
    assert rematched() == 0
    listing(5, "Radiant Charizard", "RC1/RC25", 1465)
    listing(6, "Venusaur EX", "5/115", 1729)
    assert rematched() == 2
    assert states("bw11-rc1") == [("verified", None, 5, "holofoil")] and states("g1-5") == [("verified", None, 6, "holofoil")]


def test_v6_digest_covers_the_candidate_lookup_and_the_hook_that_calls_it():
    from app.catalog_targets import multi_group_candidates, v6_set_path_facts
    table = MatchingRulesV6.table()
    assert table["multi_group_candidates"] == inspect.getsource(multi_group_candidates)
    assert table["v6_set_path_facts"] == inspect.getsource(v6_set_path_facts)
    assert "multi_group_candidates" not in MatchingRulesV5.table() and "v6_set_path_facts" not in MatchingRulesV5.table()
    assert v6_set_path_facts(None, MatchingRulesV6, {"set_id": "svp"}) == {} == v6_set_path_facts(None, MatchingRulesV5, {"set_id": "ex15"})


def test_v6_candidates_span__a_sets_groups_and_earlier_rules_see_exactly_what_they_did_before(tcgplayer_products):
    from app.catalog_targets import multi_group_candidates, reviewed_rule, tcgplayer_candidates
    v6_products()
    listing(20, "Chespin", "XY01", 1451)
    listing(21, "Cabinet", "XY01", 1452)
    with connect() as conn:
        assert reviewed_rule(None) is MatchingRulesV6
        assert [item["product_id"] for item in multi_group_candidates(conn, "bw11", "1", MatchingRulesV6)] == [9, 10]
        assert [item["product_id"] for item in multi_group_candidates(conn, "sma", "SV46", MatchingRulesV6)] == [3]
        assert multi_group_candidates(conn, "sma", "", MatchingRulesV6) == []
        # v4 and v5 read their single group, and the shared function is the one rule v5 pins: v6's groups never reach it
        for rule in (MatchingRulesV4, MatchingRulesV5):
            assert [item["product_id"] for item in tcgplayer_candidates(conn, "xyp", "XY01", rule)] == [20]
        assert [item["product_id"] for item in tcgplayer_candidates(conn, "bw11", "1", MatchingRulesV6)] == [9]  # first group only


def test_v6_refresh_uses_every_group_of_a_set_while_v5_active_leaves_the_main_sets_alone(tcgplayer_products):
    reset_catalog()
    v6_products()
    run(Records(promo("bw11-rc1", "RC1", "bw11", "Radiant Charizard"), promo("ex15-1", "1", "ex15", "Ampharos δ")))
    activate(MATCHING, 5)
    assert states("bw11-rc1") == [("unverified", "rule_failed", None, None)] and states("ex15-1") == [("unverified", "rule_failed", None, None)]
    activate(MATCHING, 6)
    assert states("bw11-rc1") == [("verified", None, 5, "holofoil")] and states("ex15-1") == [("verified", None, 1, "holofoil")]
