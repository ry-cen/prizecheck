"""Architecture pins for api/app, as data for scripts/check_python_boundaries.py (ADR-free layout facts that tests used to
assert by file name). Names, patterns and exact lists only; the engine is in the checker. Modules are dotted names
(app.social.friends); the one repository-path rule is import-aliases-tsv-readers.

A rule's list is exact where it says importers, readers or modules: a module missing from it fails, and so does one that
is not there. Two rules are subsets (tcgcsv-host, several-owners-readers). No rule has an allow-list escape: a package that
moves a module renames its entry here and lists the change in its PR. Adding a module or a name to a list is a change of
expectation and needs the owner.
"""
import re

# Every package directory named `social` under api/app must be listed here (rule social-area-complete); the social area
# is every module under one of these packages.
SOCIAL_PACKAGES = ['app.social']

# --- Helpers' patterns, copied unchanged from api/tests/test_social_contract.py --------------------------------------
# Reads of inventory tables, schema-qualified, quoted, ONLY or comma-joined too. Matched against the string constants of
# a module (and the pieces of its f-strings), never its docstrings. A collector's own Trade Wants and Will accept choices
# (trading #268) count as inventory: in the social area only the choke point may read them.
INVENTORY_TABLE = re.compile(
    r'(?:\bFROM|\bJOIN|,)\s+(?:ONLY\s+)?(?:"?\w+"?\s*\.\s*)?"?'
    r'(?:holding|deck_list_line|deck_list|location|borrowed_holding|trade_want|trade_accept)"?\b',
    re.IGNORECASE)
# The rules over a collector's own Locations that the choke point's statements call: hidden Locations (migration 101),
# For trade Locations (140) and the listable rule (142, trading #269). Matched against the whole source text, docstrings
# and comments too, so a social module's prose must never write one of these names followed by an open parenthesis.
HIDDEN_CALL = re.compile(r'\b(?:hidden_location(?:s|_ids)|for_trade_locations|trade_listable)\s*\(')
# A read of several collectors' inventory in one statement (ADR 0015): a string constant that reads an inventory table
# and filters on a list of owners or borrowers. Only the choke point may write one. Owner and admin aggregate reads in
# another form are exempt by the ADR, and review catches the forms this misses (IN lists, joins, split constants).
SEVERAL_OWNERS_TABLE = re.compile(
    r'(?:\bFROM|\bJOIN|,)\s+(?:ONLY\s+)?(?:"?\w+"?\s*\.\s*)?"?(?:holding|deck_list_line|location|borrowed_holding)"?\b',
    re.IGNORECASE)
SEVERAL_OWNERS_FILTER = re.compile(r'\b(?:owner_id|borrower_id)\s*=\s*ANY\s*\(', re.IGNORECASE)

# What each social module may import from inside the app, as (module, name), both absolute. A new import of the Want List,
# copy allocation, the Location readers, hidden_locations or friend_copies.READ fails (rule social-allowed-imports) until
# someone justifies it by adding it. Spelled as the old test spelled it relative to app.social, now absolute: `.x` is
# app.social.x, `..x` is app.x, `.` is app.social and `..` is app.
ALLOWED_IMPORTS = {
    'app.social': set(),
    'app.social.counts': set(),
    'app.social.hidden_locations': set(),
    'app.social.name_rules': set(),
    # The owner facts the Loan and Trade steps share: the inventory revision, the command start (replay, hourly count).
    'app.social.owners': {('app.location_tree', 'replay')},
    # The choke point counts each Friend's wants with the pure allocation over rows it reads itself (trading #276).
    'app.social.friend_copies': {('app.social', 'counts'), ('app', 'copy_allocation'), ('app.copy_allocation', 'allocate_rows'),
                                ('app.copy_allocation', 'AllocationRows')},
    'app.social.friend_reads': {
        ('app.social', 'name_rules'), ('app', 'set_codes'), ('app.db', 'connect'), ('app.identity', 'verified_user'),
        # Only the error helper of the Location readers; the Want List's capture and card order drive the wanted cards.
        ('app.location_tree', 'error'), ('app.want_list', 'capture_want_list'), ('app.want_list', 'number_order'),
        ('app.social.friend_copies', 'friend_copies')},
    # A Friend's Trade List (trading #269): the Friend by Handle and the card facts as a Friend's Collection reads them,
    # and their listable copies from the choke point. Discovery and Ask to trade (trading #276): the viewer's own wants
    # (the Want List's capture, their Trade Wants and their Will accept choices) and Trade List from the inventory
    # modules, the Friends' copies and wants from the choke point, the catalog's Will accept expansion, and the one
    # definition of "are Friends", a set of account ids.
    'app.social.trade_matches': {
        ('app.social', 'name_rules'), ('app.db', 'connect'), ('app.identity', 'verified_user'), ('app.location_tree', 'error'),
        ('app.social.friend_copies', 'friend_trade_copies'), ('app.social.friend_reads', 'FRIEND_BY_HANDLE'),
        ('app.social.friend_reads', 'PAGE_IDENTITIES'), ('app.social.friend_reads', 'card_facts'), ('app.social.friend_reads', 'search_key'),
        ('app.trade_list', 'own_trade_copies'), ('app.trade_wants', 'own_wants'), ('app.trade_wants', 'own_rules'),
        ('app.want_list', 'capture_want_list'), ('app.social.friend_copies', 'friend_wants'), ('app.card_accepts', 'accepts'),
        ('app.social.friends', 'friend_ids'),
        # Each Friend's completed-Trade count on their row and Trade List (trading #298), one read for all of them.
        ('app.social.trades', 'completed_trades'),
        # Near you and card search (trading #300): the nearby candidates and the viewer's status and radius from the
        # discovery module's one definition, and the band order.
        ('app.social.discovery', 'BANDS'), ('app.social.discovery', 'DiscoveryStatus'), ('app.social.discovery', 'Radius'),
        ('app.social.discovery', 'nearby'), ('app.social.discovery', 'search_setting'),
        # The trader reads (trading #299) ask the reach rule after resolving the trader id, and take the header's
        # status, band and count from the conversations' one definition (``standings``) and the pair's conversation
        # (``pair_row``).
        ('app.social.conversations', 'pair_row'), ('app.social.conversations', 'standings'), ('app.social.discovery', 'Band'),
        ('app.social.discovery', 'reach_one'), ('app.social.discovery', 'trader_user'),
        # The trader header's add_friend (trading #304) comes from the Friend code's one definition.
        ('app.social.friends', 'add_friend_state')},
    'app.social.friends': {
        ('app.social', 'name_rules'), ('app.db', 'connect'), ('app.identity', 'verified_user'), ('app.publications', 'TOKEN'),
        ('app.location_tree', 'error'), ('app.location_tree', 'replay'), ('app.social.owners', 'ensure_owner'),
        ('app.social.owners', 'lock_owners'), ('app.social.profile', 'token_hash'),
        # Ending a friendship cancels the pair's Loans nobody has confirmed a handover for (#260), then their Trades
        # nobody has confirmed the swap for (trading #274), inside the command that already locked both owners; the
        # Loan and Trade rows are written in app.social.loans and app.social.trades, never here.
        ('app.social.loans', 'end_loans_between'), ('app.social.trades', 'end_trades_between'),
        # Block for strangers (trading #302): the trader routes resolve a trader id, and a Block or Unblock moves the
        # pair's conversation watermark.
        ('app.social.conversations', 'pair_changed'), ('app.social.discovery', 'trader_user'),
        # Add as Friend (trading #304): the Trade by id through the Trades' own statement, the one suspension check and
        # the reach rule, checked before the Friend command and again under its locks.
        ('app.social.discovery', 'reach_one'), ('app.social.discovery', 'require_not_suspended'), ('app.social.trades', 'TRADES')},
    # Reports and the owner queue (trading #303): the Friend command and its Block, the reach rule, trader ids and the
    # discovery helpers from their one definitions, the conversation lookup, cursors and text rule, the Trades' end and
    # counterparties, and card facts for the snapshot.
    'app.social.reports': {
        ('app.db', 'connect'), ('app.identity', 'verified_user'), ('app.identity', 'require_owner'),
        ('app.location_tree', 'error'), ('app.location_tree', 'replay'), ('app.social.owners', 'lock_owners'),
        ('app.social.friends', '_command'), ('app.social.friends', 'command_payload'), ('app.social.friends', 'place_block'),
        ('app.social.discovery', 'reach_one'), ('app.social.discovery', 'trader_user'), ('app.social.discovery', 'lock_discovery'),
        ('app.social.discovery', 'switch_off'), ('app.social.discovery', 'remove_from_discovery'), ('app.social.discovery', 'restore_discovery'),
        ('app.social.discovery', 'account_state'),
        ('app.social.conversations', 'normalize_text'), ('app.social.conversations', 'pair_row'), ('app.social.conversations', 'account_changed'),
        ('app.social.conversations', 'encode_cursor'), ('app.social.conversations', 'decode_cursor'),
        ('app.social.trades', 'end_trades_between'), ('app.social.trades', 'unconfirmed_partners'),
        ('app.social.friend_reads', 'card_facts')},
    # The Loans both sides read and the steps that change no inventory (#252). Card facts are catalog facts; the owner
    # lock and the command plumbing are the Friend commands'. Steps that touch a collector's own inventory are in
    # app.loan_inventory, outside this area.
    'app.social.loans': {
        # The borrower's own count of written-off copies awaiting their keep-or-remove choice (#257): a count per Loan,
        # read for the reader's Loans as borrower only, never a Location; the read stays in app.borrowed_copies.
        ('app.borrowed_copies', 'awaiting_choice'),
        # Which of the reader's Loans as lender have a reserved pick out of date, so Needs you and the inbox list them
        # (#259): a set of Loan ids from the lender's own Holdings, never a Location; the read stays in app.loan_picks.
        ('app.loan_picks', 'stale_pick_loans'),
        ('app.db', 'connect'), ('app.identity', 'verified_user'), ('app.location_tree', 'error'),
        ('app.location_tree', 'record_response'), ('app.social.friend_reads', 'card_facts'), ('app.social.owners', 'NOW'),
        ('app.social.owners', 'advance_revision'), ('app.social.owners', 'begin_owner_command'), ('app.social.owners', 'lock_owners'),
        # Whether the lender is still the reader's Friend, so Edit and resend is offered only then (owner's decision,
        # 2026-10-16): the one definition of "are Friends", a set of account ids, never anything of their inventory.
        ('app.social.friends', 'friend_ids')},
    # The inbox (#259): the reader's own Loans through the Loans' one definition of what waits on them, and the updates
    # stored for them. Nothing of another collector's inventory.
    'app.social.inbox': {
        ('app.db', 'connect'), ('app.identity', 'verified_user'), ('app.social.loans', 'LOANS'), ('app.social.loans', 'LoanView'),
        ('app.social.loans', 'loan_facts'), ('app.social.loans', 'loan_views'), ('app.social.loans', 'role_of'),
        # The nudge's 14 days, so a nudge's update says when it began to apply (owner's decision, 2026-10-16).
        ('app.social.loans', 'NUDGE_DAYS'),
        # The reader's own Trades through the Trades' one definition of what waits on them, and since when (trading
        # #273): the Trade view both sides read, never a pick or a Location.
        ('app.social.trades', 'TRADES'), ('app.social.trades', 'TradeView'), ('app.social.trades', 'trade_facts'), ('app.social.trades', 'trade_views'),
        ('app.social.trades', 'waiting_trade_step'), ('app.social.trades', 'trade_waiting_since')},
    # Trade Proposals and Trades both sides read (trading #270), as the Loans read theirs: card facts, the owner lock and
    # the Loans' revision helper. Steps that touch a collector's own inventory are in app.trade_inventory. Which of the
    # reader's Trades have a pick out of date, so Needs you and the inbox list them (``trade_picks.stale_pick_trades``,
    # #273): a set of Trade ids from the reader's own Holdings, never a Location; the read stays in app.trade_picks. The
    # Friends set is allowed ahead of Counter (#278), as the resolution lists it; ending a friendship's Trades (#274)
    # needs none. ``friend_ids`` must be imported inside the function that uses it, as in social/loans.py, because
    # app.social.friends imports this module (``end_trades_between``).
    'app.social.trades': {
        ('app.trade_picks', 'stale_pick_trades'), ('app.db', 'connect'), ('app.identity', 'verified_user'),
        ('app.location_tree', 'error'), ('app.location_tree', 'record_response'), ('app.social.friend_reads', 'card_facts'),
        ('app.social.owners', 'ensure_owner'), ('app.social.owners', 'lock_owners'), ('app.social.owners', 'advance_revision'), ('app.social.owners', 'NOW'),
        ('app.social.owners', 'begin_owner_command'),
        ('app.social.friends', 'friend_ids'),
        # The other side's availability on a Trade (``TradeParty``, trading #299): one call to the reach rule for all the
        # rows' other sides, never a query of its own.
        ('app.social.discovery', 'reach')},
    # Conversations and messages (trading #298): the pair's Trades as cards through the Trades' own views and their one
    # definition of what waits on the reader, the Friends set (imported inside the functions that use it, because
    # app.social.friends imports app.social.trades), and the completed-Trade count. Nothing of another collector's
    # inventory.
    'app.social.conversations': {
        ('app.db', 'connect'), ('app.identity', 'verified_user'), ('app.location_tree', 'error'),
        ('app.social.owners', 'ensure_owner'), ('app.social.owners', 'lock_owners'), ('app.social.friends', 'friend_ids'),
        ('app.social.trades', 'TRADES'), ('app.social.trades', 'TradeView'), ('app.social.trades', 'trade_facts'), ('app.social.trades', 'trade_views'),
        ('app.social.trades', 'waiting_trade_step'), ('app.social.trades', 'completed_trades'),
        # The reach rule (trading #299): the party's band and the open-or-not check of a conversation come from its one
        # definition, and the one suspension check is ``require_not_suspended``.
        ('app.social.discovery', 'Band'), ('app.social.discovery', 'reach'), ('app.social.discovery', 'reach_one'),
        ('app.social.discovery', 'require_not_suspended')},
    'app.social.discovery': {
        ('app.db', 'connect'), ('app.identity', 'verified_user'), ('app.location_tree', 'error'),
        ('app.social.owners', 'ensure_owner'), ('app.social.owners', 'lock_owners')},
    'app.social.profile': {
        ('app.social', 'name_rules'), ('app.db', 'connect'), ('app.identity', 'verified_user'),
        ('app.location_tree', 'error'), ('app.location_tree', 'owner_and_rows'), ('app.location_tree', 'replay'),
        ('app.public_projection', 'ProjectionUnavailable'), ('app.public_records', 'MAX_BATCH'),
        ('app.public_records', 'invite_key'), ('app.public_records', 'public_record_store'),
        ('app.publications', 'PUBLIC_HEADERS'), ('app.publications', 'TOKEN')},
}

RULES = {
    # The printed set code table is read by display and matching code, not by export (app redesign #173). The decklist
    # import (#212, #213) reads the printed code table too, to match and show a pasted line and to read its alias rules
    # (import_aliases); display and matching, not export. The Want List's Swap hint (#211) shows the owned Edition's code
    # ("PAL 254"). Copy to my Decks (#216) shows a Published Deck row's printed code on its review line
    # (import_publication). The collection import (#228, #234) reads it to match a Dragon Shield or Sorted set code and a
    # pasted decklist-style line (collection_import_matcher). The scanner's number table (#310) carries each set's printed
    # code so the phone can match an OCR'd "PAL 254" (scanner). Collection's tiles and inspector (#192) show each holding's
    # printed code (holdings, collection). app.social.friend_reads is new here: the old top-level glob never scanned the
    # social package.
    'set-codes-importers': {
        'imported': 'app.games.pokemon.catalog.set_codes',
        'importers': {'app.games.pokemon.catalog.catalog_browse', 'app.games.pokemon.imports.collection_import_matcher', 'app.games.pokemon.imports.deck_import',
                      'app.games.pokemon.imports.import_aliases', 'app.games.pokemon.imports.import_matching', 'app.games.pokemon.imports.import_publication', 'app.games.pokemon.scanner.scanner'}},
    # test_set_codes reads the data file beside format_evaluator; this pins that layout fact.
    'format-rules-beside-evaluator': {'module': 'app.games.pokemon.formats.format_evaluator', 'file': 'format_rules/imported_sets.txt'},
    # The alias table feeds the import reviews alone: import_matching runs its step, deck_import fills the Missing cards
    # report, and Collection Import's matcher reads a pasted line's set code through it (#234).
    'import-aliases-importers': {
        'imported': 'app.games.pokemon.imports.import_aliases',
        'importers': {'app.games.pokemon.imports.collection_import_matcher', 'app.games.pokemon.imports.deck_import', 'app.games.pokemon.imports.import_matching'}},
    # Repository paths, not module names: the files under api/app and scripts that name the table's file.
    'import-aliases-tsv-readers': {
        'pattern': re.compile(r"""['"]import_aliases\.tsv['"]"""),
        'readers': {'api/app/games/pokemon/imports/import_aliases.py'}},
    # The TCGdex price client: one origin literal, a client that follows no redirect and reads no proxy environment, every
    # json.loads keeps floats as text, and fetch takes the card and a may_retry callable.
    'price-source-client': {
        'module': 'app.games.pokemon.prices.price_source',
        'origins': ['https://api.tcgdex.net'],
        'client': 'httpx.Client',
        'client_keywords': {'follow_redirects': 'False', 'trust_env': 'False'},
        'loads': 'json.loads',
        'loads_keyword': 'parse_float',
        'function': 'fetch',
        'function_arguments': ['card', 'may_retry']},
    # Only the price import talks to the TCGCSV host. A subset: the module may also stop naming it.
    'tcgcsv-host': {'host': 'tcgcsv.com', 'allowed': {'app.games.pokemon.prices.price_import'}},
    # In the social area only friend_copies (the choke point) and hidden_locations (the rule it calls) may read inventory.
    'social-inventory-readers': {'readers': {'app.social.friend_copies', 'app.social.hidden_locations'}},
    'social-allowed-imports': {'allowed': ALLOWED_IMPORTS},
    # The one place that may ask which Friends a collector has (ADR 0014: "only code"); everything else goes through them.
    'friends-of-readers': {
        'pattern': re.compile(r'\bfriends_of\b'),
        'readers': {'app.social.friends', 'app.social.friend_copies', 'app.social.friend_reads'}},
    # Only the choke point may write a read of several collectors' inventory in one statement (ADR 0015). A subset.
    'several-owners-readers': {'readers': {'app.social.friend_copies'}},
    # The trade steps no longer ask the Friends set: they take the ids they are given.
    'trade-steps-no-friend-ids': {'module': 'app.trade_inventory', 'name': 'friend_ids'},
    'social-area-complete': {'directory': 'social'},
}
