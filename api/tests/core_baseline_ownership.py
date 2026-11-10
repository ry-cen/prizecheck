"""Who owns what in the schema the Pokémon history leaves (S10, IM-13), for the core baseline proof (test_core_baseline.py).

The core baseline holds core-owned objects only. Ownership is by relation and function name:

* **Pokémon**: every ``catalog_*`` relation, the price, TCGplayer and scanner tables, and the functions that serve them
  (``POKEMON_FUNCTIONS``). ``random_public_reference`` is here because only ``catalog_*`` columns default to it.
* **Auth**: the gateway's tables (``AUTH_RELATIONS``) and the trigger function that onboards a new account from them. The
  auth track will own these (S4).
* **Core**: everything else, including ``released_handle`` and ``legacy_contact``. ``released_handle`` is read by the core
  function ``create_collector_profile`` and written by ``api/app/social/profile.py``, so a core-only database needs it to
  create a Handle; it stays core until the identity split (IM-3) decides otherwise, and a core tail migration can then
  drop it. ``art_large_upgrade`` is core because ``api/app/core/art/store.py`` reads and writes it, although its foreign
  key points at ``catalog_printing`` (omitted below).

There is no "unowned" answer: a relation or function in none of the Pokémon or auth lists counts as core. An object a later root
migration added to the Pokémon side and forgot to list here would therefore be expected in the baseline and reported as a core
object the baseline lacks, which fails the proof. Names listed here that the history does not create fail it too. A kind with no rule
at all (a user type, say) raises. Indexes, constraints, sequences and triggers belong to the relation they sit on.
"""
import ast
import re

AUTH_RELATIONS = frozenset({
    "account", "session", "user", "verification", "auth_rate_event", "auth_send_event", "owner_binding",
})
POKEMON_EXTRA_RELATIONS = frozenset({
    "deck_format_result", "edition_price_binding", "price_import", "public_price_ref", "scanner_fingerprint",
    "scanner_fingerprint_failure", "scanner_index", "tcgplayer_price", "tcgplayer_product",
})
LEDGER = "schema_migration"  # the runner's own table, in every database, belonging to no track

POKEMON_FUNCTIONS = frozenset("""
catalog_advance_attribute_revision catalog_append_only catalog_art_route catalog_art_route_v catalog_art_version
catalog_begin_correction catalog_card_category catalog_card_identity_key catalog_elemental_types
catalog_printing_surviving_identity catalog_search_words catalog_stamp_format_facts catalog_sync_reprint_group_membership
default_edition_metadata default_printing_metadata derive_printing_attributes enqueue_metadata_outbox
immutable_catalog_public_reference immutable_printing_display random_public_reference remember_printing_display
stamp_edition_metadata stamp_format_facts_from_attributes stamp_format_facts_from_identity stamp_format_facts_from_printing
stamp_format_facts_from_reprint_groups stamp_printing_metadata
""".split())
AUTH_FUNCTIONS = frozenset({"onboard_auth_account"})

# The foreign keys from core tables into the Pokémon catalog, which the baseline omits and a game track adds (design brief D9):
# (table, constraint, referenced table). All sixteen are plain REFERENCES catalog_x(id).
OMITTED_FOREIGN_KEYS = (
    ("art_fetch_failure", "art_fetch_failure_printing_id_fkey", "catalog_printing"),
    ("art_hit", "art_hit_printing_id_fkey", "catalog_printing"),
    ("art_large_upgrade", "art_large_upgrade_printing_id_fkey", "catalog_printing"),
    ("art_object", "art_object_printing_id_fkey", "catalog_printing"),
    ("borrowed_holding", "borrowed_holding_edition_id_fkey", "catalog_edition"),
    ("collection_import_row", "collection_import_row_edition_id_fkey", "catalog_edition"),
    ("collection_import_row", "collection_import_row_printing_id_fkey", "catalog_printing"),
    ("deck_list_line", "deck_list_line_edition_id_fkey", "catalog_edition"),
    ("holding", "holding_edition_id_fkey", "catalog_edition"),
    ("loan_line", "loan_line_edition_id_fkey", "catalog_edition"),
    ("missing_card_report", "missing_card_report_approved_edition_id_fkey", "catalog_edition"),
    ("missing_card_report", "missing_card_report_approved_printing_id_fkey", "catalog_printing"),
    ("missing_card_report", "missing_card_report_printing_id_fkey", "catalog_printing"),
    ("trade_accept", "trade_accept_edition_id_fkey", "catalog_edition"),
    ("trade_line", "trade_line_edition_id_fkey", "catalog_edition"),
    ("trade_want", "trade_want_edition_id_fkey", "catalog_edition"),
)

# Which database each root migration file's statements touch on a fresh schema, recomputed by test_core_baseline.py: "core",
# "pokemon", "auth", or "mixed:" and the owners it touches. 008 and 107 leave a fresh schema unchanged (they drop columns
# 006 never added and rewrite a constraint 105 already created that way) and act on core tables only. 160, both 161s and 162
# are the files split-map.md section 4 did not cover when it was written.
FILE_OWNERS = {
    "001_inventory.sql": "mixed:core+auth",
    "002_auth.sql": "auth",
    "003_catalog.sql": "pokemon",
    "004_location_tree.sql": "core",
    "005_catalog_search.sql": "pokemon",
    "006_add_holdings.sql": "core",
    "007_missing_card_reports.sql": "mixed:core+pokemon",
    "008_mutation_request_item_free.sql": "core",
    "009_add_response_cache.sql": "core",
    "011_move_holdings.sql": "core",
    "012_inventory_undo.sql": "core",
    "013_collection_read_indexes.sql": "mixed:core+pokemon",
    "014_decks.sql": "core",
    "015_publications.sql": "core",
    "016_catalog_reconciliation.sql": "pokemon",
    "018_reference_drift.sql": "pokemon",
    "019_operations.sql": "core",
    "020_signup.sql": "auth",
    "021_edition_metadata.sql": "pokemon",
    "022_mapping_evidence.sql": "pokemon",
    "023_metadata_review.sql": "pokemon",
    "026_multi_source_moves.sql": "core",
    "027_card_attributes.sql": "pokemon",
    "028_card_identity_subtitles.sql": "pokemon",
    "029_deck_lists.sql": "core",
    "030_card_attributes.sql": "pokemon",
    "031_deck_list_follows_moves.sql": "core",
    "032_publications_outlive_decks.sql": "core",
    "033_card_attribute_corrections.sql": "pokemon",
    "034_deck_format_results.sql": "pokemon",
    "035_reprint_groups.sql": "pokemon",
    "036_public_format_facts.sql": "pokemon",
    "037_reviewed_reprint_groups.sql": "pokemon",
    "038_basic_pokemon.sql": "pokemon",
    "039_deck_list_trigger_plans.sql": "core",
    "040_auth_rate_event.sql": "mixed:core+auth",
    "041_trainer_type_and_evolves_from.sql": "pokemon",
    "042_format_standing.sql": "pokemon",
    "043_evolution_roots.sql": "pokemon",
    "044_catalog_set_release.sql": "pokemon",
    "045_deck_list_target_format.sql": "core",
    "046_inventory_undo_add.sql": "core",
    "047_put_away_undo_returns_surplus.sql": "core",
    "048_catalog_name_search.sql": "pokemon",
    "049_want_list_counting.sql": "core",
    "050_collection_import.sql": "core",
    "051_collection_import_start.sql": "core",
    "052_deck_cover.sql": "core",
    "100_collector_profile.sql": "core",
    "101_hidden_locations.sql": "core",
    "102_friends.sql": "core",
    "103_blocks.sql": "core",
    "105_loans.sql": "core",
    "106_loan_promises.sql": "core",
    "107_loan_two_collectors.sql": "core",
    "110_borrowed_holding.sql": "core",
    "115_borrowed_deck_lists.sql": "core",
    "120_loan_returns.sql": "core",
    "125_loan_return_by.sql": "core",
    "126_loan_notice_kinds.sql": "core",
    "130_inbox.sql": "core",
    "131_loan_waiting_times.sql": "core",
    "140_for_trade_locations.sql": "core",
    "141_trades.sql": "core",
    "142_trade_promises.sql": "core",
    "143_trade_wants.sql": "core",
    "144_trade_inbox.sql": "core",
    "145_open_discovery.sql": "core",
    "146_zip_centroids.sql": "core",
    "147_conversations.sql": "core",
    "148_trade_reach.sql": "core",
    "149_trade_reports.sql": "core",
    "150_scanner_catalog_data.sql": "pokemon",
    "151_catalog_check.sql": "pokemon",
    "152_tcgcsv_prices.sql": "pokemon",
    "153_price_binding.sql": "pokemon",
    "154_fallback_art.sql": "pokemon",
    "155_set_series.sql": "pokemon",
    "156_art_store.sql": "core",
    "157_rule_rollout.sql": "pokemon",
    "158_art_route_urls.sql": "pokemon",
    "159_confirm_reprint_group_decision.sql": "pokemon",
    "160_catalog_set_code.sql": "pokemon",
    "161_likely_reprint_dismissals.sql": "pokemon",
    "161_tcgplayer_large_art.sql": "mixed:core+pokemon",
    "162_trade_loan_threads.sql": "core",
}


def relation_owner(name):
    if name == LEDGER:
        return "ledger"
    if name.startswith("catalog_") or name in POKEMON_EXTRA_RELATIONS:
        return "pokemon"
    if name in AUTH_RELATIONS:
        return "auth"
    return "core"


def function_owner(name):
    return "pokemon" if name in POKEMON_FUNCTIONS else "auth" if name in AUTH_FUNCTIONS else "core"


def owner_of(key, definition):
    """Owner of a schema_snapshot key: "core", "pokemon", "auth" or "ledger"."""
    kind, rest = key.split(":", 1)
    if kind == "function":
        return function_owner(rest.split("(")[0])
    if kind in ("table", "view"):
        return relation_owner(rest)
    if kind in ("column", "constraint", "trigger"):
        return relation_owner(rest.split(".")[0])
    if kind == "index":
        return relation_owner(re.search(r" ON (?:ONLY )?\"?(\w+)", definition).group(1))
    if kind == "sequence":
        return relation_owner(ast.literal_eval(definition)[-1].split(".")[0])
    raise AssertionError(f"No owner rule for {key}")
