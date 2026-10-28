"""Private inventory API. Only the auth gateway may assert a user identity."""
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel

from .art_store import router as art_router, start_warmups, stop_warmups
from .attribute_corrections import router as attribute_corrections_router
from .catalog_browse import router as catalog_browse_router
from .catalog_reconciliation import router as catalog_reconciliation_router
from .catalog_search import router as catalog_search_router
from .catalog_status import router as catalog_status_router
from .collection import router as collection_router
from .collection_import import router as collection_import_router
from .db import connect
from .deck_cost import router as deck_cost_router
from .deck_deletion import router as deck_deletion_router
from .deck_format_checks import router as deck_format_checks_router
from .deck_import import router as deck_import_router
from .deck_list_printing import router as deck_list_printing_router
from .deck_live_export import router as deck_live_export_router
from .deck_mass_entry import router as deck_mass_entry_router
from .deck_pick_list import router as deck_pick_list_router
from .decks import router as decks_router
from .discovery import router as discovery_router
from .format_standing import rebuild_on_startup as rebuild_format_standing, router as format_standing_router
from .holdings import router as holdings_router
from .loan_inventory import router as loan_inventory_router
from .location_tree import router as location_tree_router
from .locations import router as locations_router
from .metadata_reviews import router as metadata_reviews_router
from .missing_cards import router as missing_cards_router
from .moves import router as moves_router
from .operation_counts import Count, DatabaseWriter, counter as operation_counter
from .operations import router as operations_router
from .price_budget import is_budgeted
from .prices import router as prices_router
from .publications import router as publications_router
from .published_cost import router as published_cost_router
from .published_format_checks import router as published_format_checks_router
from .published_live_export import router as published_live_export_router
from .published_mass_entry import router as published_mass_entry_router
from .reprint_group_reviews import router as reprint_group_reviews_router
from .rule_rollout import start_on_startup as start_rule_rollout
from .scanner import router as scanner_router
from .scanner_save import router as scanner_save_router
from .settings import router as settings_router
from .social.conversations import router as conversations_router, traders_router as conversation_traders_router
from .social.discovery import router as open_discovery_router
from .social.friend_reads import router as friend_reads_router
from .social.friends import router as friends_router
from .social.inbox import router as inbox_router
from .social.loans import router as loans_router
from .social.profile import router as profile_router, public_router as public_invite_router
from .social.reports import router as reports_router, admin_router as trade_reports_admin_router
from .social.trade_matches import router as trade_matches_router
from .social.trades import router as trades_router, settings_router as trade_settings_router
from .trade_inventory import router as trade_inventory_router
from .trade_list import router as trade_list_router
from .trade_value import router as trade_value_router
from .trade_wants import router as trade_wants_router
from .want_list import router as want_list_router
from .want_list_cost import router as want_list_cost_router
from .want_list_mass_entry import router as want_list_mass_entry_router


class HealthResponse(BaseModel):
    status: str


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # Background startup work, in the order the routers' startup handlers used to run.
    start_warmups()
    start_rule_rollout()
    rebuild_format_standing()
    yield
    stop_warmups()  # deck art warm-ups stop before their next Printing
    # Give counts still queued a short, bounded time to reach PostgreSQL, then stop the writer thread.
    await run_in_threadpool(operation_counter.stop)


app = FastAPI(title="PrizeCheck API", version="0.1.0", lifespan=lifespan)


@app.get("/api/health", response_model=HealthResponse)
def health():
    return HealthResponse(status="ok")


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
    format_standing_router, collection_import_router, scanner_router, art_router, scanner_save_router,
    # social and trading
    profile_router, public_invite_router, friends_router, friend_reads_router, trade_matches_router, loans_router,
    inbox_router, trades_router, trade_settings_router, open_discovery_router, conversations_router,
    conversation_traders_router, loan_inventory_router, trade_list_router, trade_inventory_router, trade_value_router,
    trade_wants_router, reports_router, trade_reports_admin_router,
)
for included in ROUTERS:
    app.include_router(included)

operation_counter.set_writer(DatabaseWriter(lambda **options: connect(**options)))


@app.middleware('http')
async def bounded_operational_counts(request: Request,call_next):
    started = time.perf_counter()
    response = await call_next(request)
    # Anonymous projection requests must never wake the private database.
    # Budgeted routes (prices) are exempt: a count is a read route writing, and their three seconds are spent.
    # The count is only handed to the background writer (app/operation_counts.py); nothing here waits on PostgreSQL.
    if request.url.path.startswith('/api/') and not request.url.path.startswith('/api/public/') and request.url.path!='/api/health' \
            and not is_budgeted(request.method, request.url.path):
        operation_counter.record(Count(
            failures=int(response.status_code>=500),
            authorization_denials=int(response.status_code in (401,403)),
            elapsed_ms=int((time.perf_counter()-started)*1000),
            projection_failures=int(response.status_code>=500 and '/publication' in request.url.path)))
    return response
