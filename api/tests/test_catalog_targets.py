"""Reviewed Live and Marketplace target state: rules, precedence, quarantine and commit-ordered revisions."""
import copy
import json
import threading
from dataclasses import replace
from uuid import uuid4

import psycopg
import pytest

from app.catalog_targets import (LIVE, LIVE_RULES, MATCHING, MATCHING_RULES, REGISTRIES, EditionState, Failure,
                                 LiveRulesV1, MatchingRulesV1, MatchingRulesV2, MatchingRulesV3, PrintingState, TargetContext, activate_rule,
                                 code_digest, complete_quote_variant, edition_state, edition_targets, ensure_matching_rule, evaluate_edition, normalized_name,
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


def test_automatic_matching_keeps_the_newest_rule_active_without_an_approval(monkeypatch):
    reset_catalog()
    owner()
    run(Records(repeated_block(1)))
    with connect() as conn, conn.transaction():
        assert ensure_matching_rule(conn) is None  # off unless MARKETPLACE_MATCHING=automatic
    assert {row["mapping_reason"] for row in metadata()[1].values()} == {"no_matching_rule"}
    monkeypatch.setenv("MARKETPLACE_MATCHING", "automatic")
    with connect() as conn, conn.transaction():
        assert ensure_matching_rule(conn) == {"printings": 0, "editions": 2}
    with connect() as conn, conn.transaction():
        assert ensure_matching_rule(conn) is None  # already the newest version
        assert load_active(conn, MATCHING).version == max(MATCHING_RULES)
        assert conn.execute("""SELECT a.reason FROM catalog_rule_state s JOIN catalog_rule_activation a ON a.id=s.activation_id
          WHERE s.kind=%s""", (MATCHING,)).fetchone()["reason"].startswith("Automatic")
    assert {row["mapping_state"] for row in metadata()[1].values()} == {"verified"}
    # A deactivated rule comes back with the next import, and that import's new cards verify in the same promotion.
    activate(MATCHING, None)
    run(Records(repeated_block(1), repeated_block(2)))
    assert load_active_version() == max(MATCHING_RULES)
    assert {row["mapping_state"] for row in metadata("meta-2")[1].values()} == {"verified"}


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


def test_deactivating_the_rule_suspends_and_reactivation_does_not_requalify():
    reset_catalog(); run(Records(furret())); activate(LIVE, 99)
    assert metadata()[0]["live_state"] == "eligible"
    assert activate(LIVE, None) == {"printings": 1, "editions": 0}
    printing, _ = metadata()
    assert (printing["live_state"], printing["live_reason"]) == ("suspended", "no_active_rule")
    activate(LIVE, 99)
    assert metadata()[0]["live_state"] == "suspended"


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
}


def test_registered_rule_digests_are_pinned():
    """Any edit to a shipped rule's source or table changes its digest and silently deactivates the approved rule.

    A new Live set code ships as ``LiveRulesV2`` (a new registered version), never as an edit of V1. If this
    fails after a deliberate change, ship the change as a new rule version and pin that version here.
    """
    registered = {(kind, version): code_digest(kind, version)
                  for kind, registry in REGISTRIES.items() for version in registry if version != 99}  # 99 is the test-injected table
    assert registered == PINNED_DIGESTS
