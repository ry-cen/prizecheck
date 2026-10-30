"""The Pokemon app: the routers FastAPI mounts, in route order, and the startup and shutdown hooks (design D12)."""
from app.core.art.store import start_warmups, stop_warmups
from app.games.pokemon.art.route import router as art_router, public_router as public_art_router
from app.games.pokemon.catalog.attribute_corrections import router as attribute_corrections_router
from app.games.pokemon.catalog.catalog_browse import router as catalog_browse_router
from app.games.pokemon.catalog.catalog_reconciliation import router as catalog_reconciliation_router
from app.games.pokemon.catalog.catalog_search import router as catalog_search_router
from app.games.pokemon.catalog.catalog_status import router as catalog_status_router
from app.collection import router as collection_router
from app.games.pokemon.imports.collection_import import router as collection_import_router
from app.games.pokemon.decks.cost import router as deck_cost_router
from app.deck_deletion import router as deck_deletion_router
from app.games.pokemon.formats.deck_format_checks import router as deck_format_checks_router
from app.games.pokemon.imports.deck_import import router as deck_import_router
from app.games.pokemon.decks.printing import router as deck_list_printing_router
from app.games.pokemon.exports.deck_live_export import router as deck_live_export_router
from app.games.pokemon.exports.deck_mass_entry import router as deck_mass_entry_router
from app.deck_pick_list import router as deck_pick_list_router
from app.games.pokemon.decks.routes import router as decks_router
from app.games.pokemon.publications.discovery import router as discovery_router
from app.games.pokemon.formats.format_standing import rebuild_on_startup as rebuild_format_standing, router as format_standing_router
from app.holdings import router as holdings_router
from app.loan_inventory import router as loan_inventory_router
from app.location_tree import router as location_tree_router
from app.locations import router as locations_router
from app.games.pokemon.prices.metadata_reviews import router as metadata_reviews_router
from app.games.pokemon.catalog.missing_cards import router as missing_cards_router
from app.moves import router as moves_router
from app.operations import router as operations_router
from app.games.pokemon.prices.prices import router as prices_router
from app.games.pokemon.publications.publications import router as publications_router
from app.games.pokemon.publications.published_cost import router as published_cost_router
from app.games.pokemon.formats.published_format_checks import router as published_format_checks_router
from app.games.pokemon.exports.published_live_export import router as published_live_export_router
from app.games.pokemon.exports.published_mass_entry import router as published_mass_entry_router
from app.games.pokemon.catalog.reprint_group_reviews import router as reprint_group_reviews_router
from app.games.pokemon.catalog.rule_rollout import start_on_startup as start_rule_rollout
from app.games.pokemon.scanner.scanner import router as scanner_router
from app.games.pokemon.scanner.scanner_save import router as scanner_save_router
from app.settings import router as settings_router
from app.social.conversations import router as conversations_router, traders_router as conversation_traders_router
from app.social.discovery import router as open_discovery_router
from app.social.friend_reads import router as friend_reads_router
from app.social.friends import router as friends_router
from app.social.inbox import router as inbox_router
from app.social.loans import router as loans_router
from app.social.profile import router as profile_router, public_router as public_invite_router
from app.social.reports import router as reports_router, admin_router as trade_reports_admin_router
from app.social.trade_matches import router as trade_matches_router
from app.social.trades import router as trades_router, settings_router as trade_settings_router
from app.games.pokemon.trading.trade_inventory import router as trade_inventory_router
from app.trade_list import router as trade_list_router
from app.games.pokemon.trading.trade_value import router as trade_value_router
from app.games.pokemon.trading.trade_wants import router as trade_wants_router
from app.want_list import router as want_list_router
from app.games.pokemon.decks.want_list_cost import router as want_list_cost_router
from app.games.pokemon.exports.want_list_mass_entry import router as want_list_mass_entry_router


# FastAPI matches routes in registration order; keep this order.
ROUTERS = (
    locations_router, catalog_status_router,
    # inventory, search and settings
    location_tree_router, catalog_search_router, holdings_router, missing_cards_router, moves_router,
    collection_router, catalog_browse_router, settings_router,
    # decks
    decks_router, deck_list_printing_router, deck_import_router, deck_pick_list_router, deck_deletion_router,
    # catalog review
    catalog_reconciliation_router, metadata_reviews_router, attribute_corrections_router, reprint_group_reviews_router,
    # publications, discovery, operations
    publications_router, discovery_router, operations_router,
    # prices, costs and exports
    prices_router, deck_live_export_router, deck_mass_entry_router, deck_cost_router,
    want_list_router, want_list_cost_router, want_list_mass_entry_router, deck_format_checks_router,
    # published decks, format standing, imports, scanner
    published_cost_router, published_live_export_router, published_mass_entry_router, published_format_checks_router,
    format_standing_router, collection_import_router, scanner_router, art_router, public_art_router, scanner_save_router,
    # social and trading
    profile_router, public_invite_router, friends_router, friend_reads_router, trade_matches_router, loans_router,
    inbox_router, trades_router, trade_settings_router, open_discovery_router, conversations_router,
    conversation_traders_router, loan_inventory_router, trade_list_router, trade_inventory_router, trade_value_router,
    trade_wants_router, reports_router, trade_reports_admin_router,
)

# Startup hooks, in the order the routers' startup handlers used to run.
STARTUP_HOOKS = (start_warmups, start_rule_rollout, rebuild_format_standing)
# Shutdown hooks run after the app yields, in order: deck art warm-ups stop before their next Printing.
SHUTDOWN_HOOKS = (stop_warmups,)
LIFESPAN_HOOKS = (STARTUP_HOOKS, SHUTDOWN_HOOKS)
