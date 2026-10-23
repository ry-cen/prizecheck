# Decide the Trading Stage 2 plumbing: reach, zip distance, conversations and reports

Resolves the Stage 2 candidate ticket "Decide location storage and other technical plumbing" of the [Trading decision map](../map.md) on 2026-10-22, revised the same day after an independent review. The owner delegated the plumbing. The map's "Stage 2 owner decisions — 2026-10-22" and its seven approved defaults are the authority on what collectors see. Where this resolution has to read one of them, the reading is listed under "Readings this resolution assumes". Where a plumbing constraint would change one, the point was put to the owner under "Owner questions", answered on 2026-10-23. The copy this resolution proposed is collected under "Approved copy" (approved by the owner on 2026-10-23). It extends the [Stage 1 plumbing resolution](decide-trading-plumbing.md), [ADR 0014](../../../../adr/0014-friend-reads-and-two-owner-loans.md) and [ADR 0015](../../../../adr/0015-trades-share-the-promise-invariant-and-friend-reads.md), and uses the [zip-centroid research](../research/zip-centroid-data.md).

## Readings this resolution assumes

1. **Distance ordering.** "Sort by match, then distance" sorts by **band**, then Display Name (case ignored), then `trader_id`. The server never ranks by exact distance, because that would leak finer distance than the band shows (Owner question 5).
2. **Radius.** It filters by band: 5 mi shows Under 5 mi, 10 mi adds 5–10, 25 mi adds 10–25 and 50 mi adds 25–50. It is chosen on Find trades' Near you, not in Settings, and stored with the collector's discovery setting (default 25).
3. **A conversation stays open once started.** It carries messages and proposals until a Block, suspension or deletion. Turning discovery off, moving zip or moving beyond 50 mi does not close it. See Owner question 2 for Remove Friend.
4. **Archive.** A new message from either side, or a new Trade Proposal or Counter, brings an archived conversation back.
5. **Trades tab badge.** It is unread conversations plus Trades waiting on the collector, summed as the owner worded it. The bell is unchanged: Loans plus Trades waiting.
6. **A Block looks like unavailability to the blocked side.** The blocked collector reads "This collector is no longer available", byte-identical to a suspended collector (map default 6). The blocker sees that they blocked.
7. **Card search lists Friends first, then Near you.** This follows the owner's Find trades decision (Friends first, then Near you).
8. **"Message" from a card prefills the composer in the client.** For example: "Is your <card> (<set> <number>) still available?" Messages stay plain text and never reference a card.

## Owner questions

**Answered by the owner on 2026-10-23.** Q1 differs from the recommendation (Lend Offers are also stopped); every other answer is the recommendation.

1. **What a suspension stops.** *Answer (B):*
   - A suspended collector can still sign in and use their own Collection, Decks and Want List. Their existing Loans continue to handover and return. Their Friends can still see their Collection.
   - Everywhere, Friends included, they leave open discovery and cannot message, send Trade Proposals, Counter or accept. They also cannot send Friend Requests (by Handle, Invite Link or Add as Friend), Borrow Requests or Lend Offers.
   - *Why:* suspension is an app-level flag. Locking them out of sign-in would need the auth gateway and an answer on data export.
2. **Remove Friend and the conversation.** *Answer (A):* the conversation stays open, so ex-Friends can still message and propose; only Block stops contact. Remove Friend still cancels unconfirmed Trades (Stage 1).
   - Ex-Friends keep reading each other's Trade List and matching wants through their conversation, with no distance band. Their Collections stay closed to each other.
   - Ex-Friends from Stage 1 do not regain this. The backfill creates conversations only for pairs who are Friends at deploy time, or who still have an open Trade.
3. **Unrecognised zip codes.** *Answer (A):* refuse, with "We couldn't find that zip code. Try the zip code where you'd meet." A zip that places the collector nowhere would leave them silently invisible.
4. **A stranger's "wants".** *Answer (A):* their Trade List page shows their full Trade List plus only the wants that match the viewer's Trade List, as a Friend's row does. It does not show their whole Want List. The map's "wants" means these matching wants.
5. **"Then distance".** *Answer (A):* accept reading 1. Inside a band, the order is by Display Name, not exact distance.
6. **Band on a stranger's Trade List.** *Answer (A):* the band shows only while both collectors have discovery on. Otherwise no band shows, for example for a collector reached only through a conversation after either side turned discovery off.
7. **Card search order** (added in the Stage 2 spec). *Answer (A):* Friends who have the card first, then Near you, mirroring Find trades (reading 7).

## Module boundary

Stage 1 promised that non-Friend reads would add "a second filter beside `friends_of` in `friend_copies.py`, not a new module" (Stage 1 resolution, Module boundary; ADR 0015 Consequences). Stage 2 keeps that promise:

- The second filter is one SQL function, `trade_reach`. Every cross-collector Trade read in `friend_copies.py` filters through it.
- New modules hold only what is not an inventory read.

| Module | Prefix | Owns |
| --- | --- | --- |
| `api/app/social/friend_copies.py` (extended) | none | `TRADE_READ` and `WANTS_FRIENDS` filter through `trade_reach`. `friend_trade_copies(..., among=)` and `friend_wants(..., among=)`. `READ` (Collections) stays Friends-only on `friends_of` |
| `api/app/social/discovery.py` (new) | `/api/social/discovery` | Own settings and the zip-change limit. `reach`, `reach_one`, `nearby`, `trader_user`, `require_not_suspended`. `remove_from_discovery`, `restore_discovery` and `switch_off` for the owner routes. The only module that names `discovery_setting`, `zip_centroid`, `open_discovery`, `trade_reach(` or `nearby_collectors(` outside `friend_copies.py` |
| `api/app/social/conversations.py` (new) | `/api/social/conversations`, `/api/social/traders/{trader_id}/messages` | List, timeline, messages, read, archive and pulse. `open_conversation`, `count_new_conversation`, `partners`, `normalize_text` |
| `api/app/social/trade_matches.py` (extended) | `/api/social` | Near you, card search, `GET /traders/{trader_id}`, `/trade-list` and `/matches`. `discover` is generalised over a party set |
| `api/app/social/friends.py` (extended) | `/api/social` | `/traders/{trader_id}/block`, `/unblock` and `/blocked/{block_id}/unblock`. The Block row's `via` and `handle_shown`. `/trades/{id}/add-friend`. `_command` generalised (Report) |
| `api/app/social/trades.py` (extended) | `/api/social/trades` | `TradeParty` fields, `completed_trades(conn, ids)`, inline Trade views |
| `api/app/social/reports.py` (new) | `/api/social/reports`. `admin_router`: `/api/admin/trade-reports`, `/api/admin/collectors` | Report (plus Block), snapshot, owner queue and decisions, suspension, audit. Never writes discovery tables; it calls `discovery` helpers |
| `api/app/trade_inventory.py` (changed) | `/api/trades` | Send, Counter and accept check `reach_one`. Send takes `recipient_trader_id` and locks both owners |
| `api/app/social/loans.py` (two lines) | `/api/social/loans` | Borrow Request sends and Lend Offer sends call `require_not_suspended` |

## The reach rule (the second filter)

Migration 148 adds `trade_reach(viewer text, others text[]) RETURNS TABLE(other_id text, how text, band smallint)`. It is the one definition of "may trade or talk with now". It has three branches:

- **`friend`**: the other is in `friends_of(viewer)`.
- **`conversation`**: a `conversation` row exists for the pair.
- **`near`**: both are in `open_discovery` (switched on, not removed, not suspended) and `distance_band(...)` is not NULL.

Every branch excludes a Block either way, a suspended viewer or other, the viewer themselves, and a deleted other (no `collector_profile` row).

`band` is set only when the two are not Friends and both are in `open_discovery`. Otherwise it is NULL (Owner question 6).

```sql
CREATE OR REPLACE FUNCTION trade_reach(viewer text, others text[])
RETURNS TABLE(other_id text, how text, band smallint) LANGUAGE sql STABLE AS $$
  SELECT o.id,
         CASE WHEN f.friend_id IS NOT NULL THEN 'friend' WHEN c.id IS NOT NULL THEN 'conversation' ELSE 'near' END,
         CASE WHEN f.friend_id IS NULL THEN distance_band(dv.lat, dv.lon, d.lat, d.lon) END
  FROM unnest(others) AS o(id)
  JOIN collector_profile p ON p.user_id = o.id AND p.suspended_at IS NULL
  JOIN collector_profile me ON me.user_id = viewer AND me.suspended_at IS NULL
  LEFT JOIN friends_of(ARRAY[viewer]) f ON f.friend_id = o.id
  LEFT JOIN conversation c ON c.user_low = least(viewer, o.id) AND c.user_high = greatest(viewer, o.id)
  LEFT JOIN open_discovery dv ON dv.user_id = viewer
  LEFT JOIN open_discovery d ON d.user_id = o.id
  WHERE o.id <> viewer
    AND NOT EXISTS (SELECT 1 FROM block b WHERE (b.blocker_id = viewer AND b.blocked_id = o.id)
                                             OR (b.blocker_id = o.id AND b.blocked_id = viewer))
    AND (f.friend_id IS NOT NULL OR c.id IS NOT NULL OR distance_band(dv.lat, dv.lon, d.lat, d.lon) IS NOT NULL)
$$;
```

**In the choke point:**

- `TRADE_READ`'s CTE becomes `SELECT r.other_id AS friend_id FROM trade_reach(%(viewer)s, %(friends)s::text[]) r WHERE %(among)s = 'reach' OR r.how = 'friend'`. `WANTS_FRIENDS` changes the same way. Ids are still a bound array, joined, never sub-selected (the Stage 1 #276 inlining lesson).
- `friend_trade_copies` and `friend_wants` gain `among: Literal['friends', 'reach'] = 'friends'`:
  - With `'reach'`, `friend_ids` must not be None.
  - With `'friends'` and `friend_ids=None`, both first list the Friends with `TRADE_FRIENDS` (`friends_of`), as `friend_trade_copies` does today. `trade_reach` therefore always receives a bound array, and a suspended Friend drops out of Friends' Find trades.
- `READ` (a Friend's Collection, Lend views) is unchanged. Strangers never reach a Collection.

**In Python.** `discovery.reach_one(conn, viewer, other) -> Reach | None` and `discovery.reach(conn, viewer, others) -> dict[str, Reach]` both call the same function. `Reach` is a dataclass of `how` and `band`. Every contact step and every trader read calls one of them, after its locks (see Locks and concurrency).

**Contract guards** (`api/tests/test_social_contract.py`):

- `REACH_CALL = \b(?:trade_reach|nearby_collectors)\s*\(` appears only in the string constants of `social/friend_copies.py` and `social/discovery.py`.
- `DISCOVERY_TABLE` (`discovery_setting|zip_centroid|open_discovery` after FROM, JOIN, UPDATE or INTO) appears only in `social/discovery.py`.
- `MESSAGE_TABLE` (`message|conversation_member`) appears only in `social/conversations.py` and `social/reports.py`.
- `'trade_reach(' in friend_copies.TRADE_READ`, `'trade_reach(' in friend_copies.WANTS_FRIENDS`, and `'trade_reach' not in friend_copies.READ`.
- `trade_inventory.py` no longer imports `friend_ids`.
- `FRIENDS_OF_READERS` is unchanged.

## Identity: trader ids, Handles and user ids

Three facts drive this section:

- Friend commands take a raw user id (`SendFriendRequest.collector_id`, `friends.py:94`).
- `GET /api/social/friends` (`sent`) and `GET /api/social/blocks` answer Handles (`friends.py:382-391`).
- A Handle lookup or an Invite Link read answers the user id (`CollectorLookup`, `InviteCollector`).

**Rule: no stranger-facing response carries a user id or a Handle, and no route that takes a user id or a Handle ever answers a non-Friend's `trader_id`.** Otherwise anyone who knows a Handle could link it to a discovery row and its distance band.

- **Trader ids.** Migration 145 adds `collector_profile.trader_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE`. It is random, stable and never shown. Stranger-facing routes and responses address collectors only by `trader_id`. An unknown `trader_id` and an unreachable one answer byte-identically wherever reach decides.
- **Which schemas carry which id:**

  | Id | Carried by | Never by |
  | --- | --- | --- |
  | `trader_id` | `NearbyMatchRow`, `CardHolder`, `TraderView`, `TraderTradeList`, `ConversationParty`, `TradeParty`. The Friend-only `TradeMatchRow` and `FriendTradeList`. `BlockedCollector`, only for Blocks placed through a trader route | `Collector`, `CollectorLookup`, `InviteCollector`, `FriendsView`, Loan views |
  | user id (`collector_id`) | Friend-only models: `Collector`, `CollectorLookup`, `InviteCollector`, `FriendsView`, `TradeMatchRow`, `FriendTradeList`, `TradeCardOffer`, Loan views. `TradeParty` only while Friends | every model in the first cell except those Friend-only ones |
  | `conversation_id` | `TraderView`, `ConversationView`, `ConversationSummary` | |
  | `block_id` | `BlockedCollector` | |
  | report ids | owner routes only | |

- **`TradeParty`** becomes `{collector_id: str|None, handle: str|None, trader_id: UUID|None, display_name, open_to_cash_offers, friend: bool, available: bool, completed_trades: int|None}`:
  - `collector_id` and `handle` are set only while the two are Friends.
  - `trader_id` is None once the other account is deleted.
  - `available` means `reach_one` is not None.
  - `completed_trades` is None when the party is not available.

  `collector_id is None` no longer means "deleted". The web switches to `trader_id`/`available` (`CounterPage.tsx:58-62`, `TradeScreen.tsx:563`).
- **Sends** take `recipient_trader_id: UUID | None` beside the existing `recipient_id`, which is now optional:
  - Exactly one is required, else 422 `RECIPIENT_REQUIRED`.
  - A send by `recipient_id` (user id) is accepted only when `reach_one(...).how == 'friend'`; otherwise it answers 409 `COLLECTOR_UNAVAILABLE`. A Handle lookup followed by a send therefore never yields a stranger's `trader_id` in the answer `TradeView`.
  - The web always sends `recipient_trader_id`.
- **Block rows** (migration 148):
  - `block.id uuid NOT NULL DEFAULT gen_random_uuid()` (unique).
  - `block.via text NOT NULL DEFAULT 'collector' CHECK (via IN ('collector','trader'))`. `'trader'` is set by the trader routes and Report.
  - `block.handle_shown boolean NOT NULL DEFAULT false`. The migration sets existing rows to true in the same DO block that adds the column, so today's Blocked lists are unchanged.
  - Every Block path sets `handle_shown` true only when, at the Block, the two were Friends, or the blocker had received a pending Friend Request from the other, or the blocker had sent one that is not `via_trade`.
- **Blocked list.** `GET /api/social/blocks` answers `BlockedCollector {block_id, display_name, handle: str|None, trader_id: UUID|None}`:
  - `handle` only when `handle_shown`.
  - `trader_id` only when `via = 'trader'`.
  - No user id.
  - Unblock from Settings is `POST /api/social/blocked/{block_id}/unblock`. It lifts any Block the caller placed, of either kind. The `block_id` is opaque and comes only from the caller's own list, so it links nothing; it is the only way to lift a `'collector'` Block whose Handle is not shown, such as one made from an Invite Link. An unknown `block_id`, or one the caller did not place, answers 404 `BLOCK_NOT_FOUND`.
  - **Each identity-keyed unblock route lifts only Blocks of its own kind.**
    - `POST /blocks/{collector_id}/unblock` lifts only a `via = 'collector'` Block.
    - `POST /traders/{trader_id}/unblock` lifts only a `via = 'trader'` Block.
    - Asked about a Block of the other kind, each answers exactly as if no Block existed: no change, and the current relation. So neither route can confirm that a user id and a `trader_id` are the same collector.
    - The existing `POST /blocks` stays, with no answer change apart from setting `via` and `handle_shown`. `relation()` is unchanged.
  - **The API and web for `GET /blocks` deploy together, in one ticket and one release.** The old web cannot unblock without `collector_id`. This was chosen over keeping `collector_id` when `handle_shown` is true because it is the simpler of the two: one model with no conditional user id.
  - This also closes an existing leak: blocking an Invite Link holder by the id the link gave used to show their Handle.
- **Add as Friend** (below) never hands the requester the other's user id or Handle before acceptance.

## Zip codes and distance

- **Dataset.** The Census 2026 ZCTA Gazetteer (`INTPTLAT`/`INTPTLONG`) comes first, then GeoNames `US.zip` for 5-digit codes Census lacks:
  - GeoNames rows with accuracy 1 (estimated) are dropped.
  - Each row keeps `source` (`'census'|'geonames'`).
- **Loading.** The data comes in a data migration, `146_zip_centroids.sql`, generated by the committed script `scripts/build_zip_centroids.py`:
  - The script downloads both files, checks pinned sha256 values and merges them. It writes `INSERT ... VALUES` batches of 1,000 rows with `ON CONFLICT (zip) DO UPDATE` and 4-decimal coordinates, about 1.3 MB in all.
  - The migration header records the source URLs, the download date, the hashes and the row counts.
  - A migration, because `scripts/migrate.py` runs only `.sql` files and every deploy already runs it.
  - A yearly refresh is a new migration that upserts `zip_centroid` and re-copies coordinates into `discovery_setting` by join.
- **Table** (146): `zip_centroid(zip char(5) PRIMARY KEY CHECK (zip ~ '^[0-9]{5}$'), lat double precision NOT NULL, lon double precision NOT NULL, source text NOT NULL CHECK (source IN ('census','geonames')))`.
- **Per collector** (145):

  ```sql
  discovery_setting(
    user_id text PRIMARY KEY REFERENCES collector_profile(user_id) ON DELETE CASCADE,
    enabled boolean NOT NULL DEFAULT false,
    zip char(5), lat double precision, lon double precision,
    radius_mi smallint NOT NULL DEFAULT 25 CHECK (radius_mi IN (5,10,25,50)),
    removed_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (NOT enabled OR (zip IS NOT NULL AND lat IS NOT NULL AND lon IS NOT NULL)),
    CHECK (NOT (enabled AND removed_at IS NOT NULL)))
  ```

  - The centroid is copied in when the zip is set.
  - The zip is kept while discovery is off.
  - Index: `discovery_open_lat ON discovery_setting(lat) WHERE enabled`.
  - The view `open_discovery` (also 145) is enabled, not removed, and profile not suspended.
- **`distance_band(lat1, lon1, lat2, lon2) RETURNS smallint`** (145) is an IMMUTABLE SQL haversine with R = 3958.8 mi, with the `asin` argument clamped to 1:
  - It answers 1 under 5 mi, 2 under 10, 3 under 25 and 4 at 50 or less.
  - It answers NULL beyond 50 mi or when an argument is NULL.
  - The API exposes it only as `band: Literal['under_5','5_to_10','10_to_25','25_to_50']`.
  - **No response carries miles, a latitude, a longitude or another collector's zip.**
- **`nearby_collectors(viewer text, max_band smallint, max_rows int) RETURNS TABLE(other_id text, band smallint)`** (148):
  - Bounding-box prefilter: latitude ±0.7246°, longitude ±50/(69.172·cos(radians(least(89, |lat|+0.7246)))). Then `distance_band(...) <= max_band`.
  - It excludes the viewer, Friends, Blocks either way and anyone outside `open_discovery`. It answers nothing when the viewer is not in `open_discovery`.
  - Order before the cap: `band`, then `md5(viewer || trader_id::text)`, a per-viewer pseudo-random order. Then `LIMIT max_rows`. The cap never ranks by distance, and each viewer gets an independent cut, so which collectors make it says nothing beyond the band. Visible order is set by the caller (name order inside a band).
  - Known gap: collectors near the antimeridian (Aleutians) do not see across it.
- **Anti-trilateration.** Band edges are not the control (research, Privacy). The controls are:
  - only opted-in collectors can query;
  - the probe point is the viewer's own zip centroid, and zip changes are limited;
  - only bands are output, in name order inside a band, with the radius on band edges;
  - the target point is itself a centroid, so the most an attacker learns over days of moves is the target's zip.
- **Zip-change limit.**
  - What counts: a write that changes a stored zip to a different zip. Setting a zip when none is stored does not count. Same-value writes and switching on or off do not count.
  - Kind `'zip_change'` in `handle_lookup_event`, a rolling 24-hour window, the `count_trade_command` pattern.
  - The fourth counted change within 24 hours answers 429 `ZIP_CHANGE_LIMIT` with `retry_after_minutes`.
  - Because the window rolls, the copy must not say "tomorrow" (see Approved copy).

## Open discovery switch

- **`GET /api/social/discovery`** answers `DiscoverySettings {status: 'off'|'on'|'removed'|'suspended', zip: str|None, radius_mi: 5|10|25|50, zip_changes_left: int, visible_beyond_friends: bool}`.
  - This is the collector's own zip, the one place a zip leaves the API.
  - `visible_beyond_friends` is `status == 'on'` or `reach` over `conversations.partners(conn, user)` has a `conversation` branch that is not a Friend. In other words, some non-Friend can read the collector's Trade List now (Hidden For trade Locations).
- **`PUT /api/social/discovery {enabled: bool|None, zip: str|None, radius_mi: 5|10|25|50|None}`** is idempotent by value and needs no key. It runs under `pg_advisory_xact_lock('prizecheck.discovery:'||user)`, then `lock_owners(user)`. Checks, in order:
  1. 409 `DISCOVERY_UNAVAILABLE` when suspended or removed and `enabled` is true.
  2. The zip is stripped and must match `^\d{5}(-\d{4})?$`, keeping the first 5 digits; otherwise 422 `INVALID_ZIP`.
  3. 422 `UNKNOWN_ZIP` when the zip is not in `zip_centroid`.
  4. A counted change: 429 `ZIP_CHANGE_LIMIT`.
  5. `enabled` with no zip given or stored: 422 `ZIP_REQUIRED`.
- **Reciprocal rule.** `near` needs both collectors in `open_discovery`:
  - A viewer who is off gets `status: 'off'` and an empty `near` list from Near you and card search. Card search's `friends` list is still answered.
  - Off stops new stranger conversations.
  - Existing conversations continue through the `conversation` branch.
- **Owner removal and restore.**
  - `discovery.remove_from_discovery(conn, user)` sets `removed_at` and `enabled = false`.
  - `restore_discovery` clears `removed_at` only; the collector switches discovery on again themselves.
  - `switch_off(conn, user)` (used by suspension) sets `enabled = false`.

## Find trades: Near you and card search

- **Friends section.** `GET /api/social/trade-matches` is unchanged, apart from `TradeMatchRow` gaining `trader_id` and `completed_trades`.
- **`GET /api/social/trade-matches/near`** answers `NearbyMatches {status, radius_mi, rows: [NearbyMatchRow]}`. `NearbyMatchRow` is `{trader_id, display_name, band, completed_trades, open_to_cash_offers, match, you_get, you_give, more_you_get, more_you_give}`.
  - `discover(user_id, parties, among)` is generalised from the Friend set (`trade_matches.py:292`).
  - Candidates come from `discovery.nearby(conn, viewer, radius, NEAR_CANDIDATES = 500)`, read in one read-only repeatable-read transaction with `friend_trade_copies(among='reach')` and `friend_wants(among='reach')`.
  - Rows are sorted by `KIND_ORDER`, band, Display Name (casefold) and `trader_id`. At most 100 rows, with 20 cards per side.
  - A separate route, so the Friends section keeps its latency.
- **`GET /api/social/traders/{trader_id}/matches`** answers one trader's full row. It needs `reach_one`, else 404 `COLLECTOR_NOT_FOUND`.
- **`GET /api/social/trade-card-search?printing_id=&scope=name|set|printing`** answers `TradeCardSearch {status, friends: [CardHolder], near: [CardHolder]}`. `CardHolder` is `{trader_id, display_name, friend, band|None, completed_trades, open_to_cash_offers, cards: [FriendTradeCard], more_cards}`.
  - The collector picks a card through the existing catalog search. The Editions searched depend on `scope`:
    - `name`: every Edition of every Printing sharing the picked Printing's `identity_id`.
    - `set`: those, within the picked Printing's set.
    - `printing`: that Printing's own Editions.
  - An unknown `printing_id` answers 200 with empty lists, as Stage 1's Ask to trade does.
  - `friends` covers `friend_ids` with `among='friends'`, answered whatever the discovery status. `near` covers `nearby(..., 1000)` with `among='reach'`, sorted by band and then name.
  - At most 50 holders per list and 20 cards each. Reverse search is deferred (map).

## A stranger's Trade List and trader header

- **`GET /api/social/traders/{trader_id}`** answers `TraderView {trader_id, display_name, friend, band|None, completed_trades|None, open_to_cash_offers, status: 'open'|'unavailable'|'you_blocked', conversation_id|None, add_friend: 'offer'|'sent'|'received'|None}`.
  - It answers when `reach_one` holds or the two share a conversation; otherwise 404 `COLLECTOR_NOT_FOUND`.
  - `unavailable` means the other is suspended or has blocked the viewer. Its `band`, `completed_trades` and `add_friend` are null and `open_to_cash_offers` is false, so the two causes are byte-identical.
  - A deleted collector has no `trader_id` and is reached only through the conversation (below).
- **`GET /api/social/traders/{trader_id}/trade-list?q=&page=`** answers `TraderTradeList {trader_id, display_name, band|None, completed_trades, cards, next_page}`.
  - It mirrors `friend_trade_list` (`trade_matches.py:93-127`) with `friend_trade_copies(conn, viewer, [other], among='reach')`.
  - It needs `reach_one`, else 404 `COLLECTOR_NOT_FOUND`.
  - `band` is null unless both have discovery on (Owner question 6).
- **Excluded, as before:** the rest of the Collection, Location names, promised copies and Borrowed Copies (`trade_listable`). Hidden Decks' wants also stay out (Stage 1 question 2).
- **Proposal builder and Counter page** are keyed by `trader_id` and read `/traders/{id}/trade-list` and `/traders/{id}/matches`. Friends' old links `/trades/new/<Handle>` still work: they resolve through `FriendTradeList`, which gains `trader_id`, and redirect to `/trades/new/<trader_id>`.

## Conversations and messages

**Schema (migration 147):**

```sql
CREATE TABLE IF NOT EXISTS conversation (
  id uuid PRIMARY KEY,
  user_low text REFERENCES inventory_owner(user_id) ON DELETE SET NULL,
  user_high text REFERENCES inventory_owner(user_id) ON DELETE SET NULL,
  low_name text NOT NULL CHECK (char_length(low_name) BETWEEN 1 AND 40),
  high_name text NOT NULL CHECK (char_length(high_name) BETWEEN 1 AND 40),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_activity_at timestamptz NOT NULL DEFAULT now(),   -- messages and new Trade rows: list order, archive
  changed_at timestamptz NOT NULL DEFAULT now(),         -- any message or Trade step: the pulse watermark
  last_from_low_at timestamptz, last_from_high_at timestamptz,
  CONSTRAINT conversation_ordered CHECK (user_low IS NULL OR user_high IS NULL OR user_low < user_high),
  CONSTRAINT conversation_pair UNIQUE (user_low, user_high));
CREATE TABLE IF NOT EXISTS conversation_member (
  conversation_id uuid NOT NULL REFERENCES conversation ON DELETE CASCADE,
  member_id text NOT NULL REFERENCES inventory_owner(user_id) ON DELETE CASCADE,
  read_at timestamptz, archived_at timestamptz, PRIMARY KEY (conversation_id, member_id));
CREATE INDEX IF NOT EXISTS conversation_member_member ON conversation_member(member_id);
CREATE TABLE IF NOT EXISTS message (
  id uuid PRIMARY KEY, conversation_id uuid NOT NULL REFERENCES conversation ON DELETE CASCADE,
  from_low boolean NOT NULL, client_key uuid NOT NULL,
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL,
  CONSTRAINT message_once UNIQUE (conversation_id, from_low, client_key));
CREATE INDEX IF NOT EXISTS message_timeline ON message(conversation_id, created_at DESC, id DESC);
```

- **One row per unordered pair**, Friends included. Messages record `from_low` rather than a sender FK, so after a deletion the remaining side still knows which messages were theirs.
- **Names** follow `collector_profile` through the trigger **`trade_names_follow_profile_conversations`**, a copy of `trade_names_follow_profile`.
  - PostgreSQL fires same-event triggers in name order. This name sorts after `trade_names_follow_profile`, so a rename locks `trade` rows before `conversation` rows, the same order as every Trade step. A name sorting earlier would let a rename deadlock against an accept.
- **`trade` gains `conversation_id uuid REFERENCES conversation ON DELETE SET NULL`** (indexed). Two triggers go with it:
  - `BEFORE INSERT`, when `conversation_id` is NULL and both ids are set: upsert the pair's conversation **and both `conversation_member` rows**, then set the id. An older API build's new Trades therefore join a conversation during deploy.
  - `AFTER INSERT OR UPDATE OF revision`: set `changed_at`, plus `last_activity_at` on insert. Every step moves `revision`. A rename's name-only update does not fire it, so a rename never locks a conversation through `trade`.
- **Backfill** (147):
  - **Who gets a conversation:** each pair that has a `trade` row and either is Friends now (`friends_of`) or has a Trade in `proposed` or `accepted`. Ex-Friends from Stage 1 with only closed Trades get none, and so do not regain reach (Owner question 2).
  - **What it holds:** `created_at` is the pair's first Trade and `last_activity_at` its last. Both member rows are inserted, and `trade.conversation_id` is set for every Trade of the pair.
  - **Closed Trades of pairs left out** keep a NULL `conversation_id`. They stay readable at `/trades/<id>` and through the inbox. If that pair ever opens a conversation, `open_conversation` attaches them in the same transaction.

**Opening and counting.** `open_conversation(conn, user, other, reach) -> UUID` finds or creates the pair's row (`INSERT ... ON CONFLICT ON CONSTRAINT conversation_pair DO NOTHING`, then select), both member rows, and the pair's earlier unattached Trades. When it creates the row it calls `count_new_conversation`, unless `reach.how == 'friend'` or the pair has a Trade both sides confirmed (map default 5, "traded with before"):

- kind `'new_conversation'`, a rolling 24-hour window, limit 10;
- over the limit: 429 `TOO_MANY_NEW_CONVERSATIONS` with `retry_after_minutes`;
- the advisory lock `pg_advisory_xact_lock('prizecheck.new_conversation:'||user)` is taken **by the caller before `lock_owners`**. `open_conversation` asserts it is held and does not take it itself.

A refused step rolls back its count.

**Messages.**

- **Routes:**
  - `POST /api/social/traders/{trader_id}/messages {body, idempotency_key}`, for first contact or any time;
  - `POST /api/social/conversations/{id}/messages {body, idempotency_key}`.
  - Both answer 201 `Message {id, from: 'you', body, at}`. A replay with the same `(conversation, side, client_key)` answers the stored row.
- **Rate limit:** 120 per hour under kind `'message'`. Over it: 429 `MESSAGE_RATE_LIMITED` with `retry_after_minutes`, and chat-appropriate copy (see Approved copy).
- **`normalize_text`** (shared with the Report note), applied in order:
  1. CRLF and CR become LF.
  2. Unicode NFC.
  3. Drop C0/C1 controls except LF and TAB, and drop U+202A–U+202E and U+2066–U+2069.
  4. Strip leading and trailing whitespace.
  5. Empty: 422 `EMPTY_MESSAGE`.
  6. Over 1,000 code points: 422 `MESSAGE_TOO_LONG`.

  Pydantic `max_length=4000` bounds the raw parse. The text is stored and returned plain, and rendered as text with no link detection.
- **Write:** `UPDATE conversation SET last_from_<side>_at = clock_timestamp(), last_activity_at = ..., changed_at = ... RETURNING` locks the row. The message is inserted with that same `created_at`, so times are monotonic within a conversation and read markers never skip a message.

**Timeline.** `GET /api/social/conversations/{id}?before=<cursor>` answers `ConversationView {id, other: ConversationParty, status, can_message, can_propose, can_report, items: [TimelineItem], next_before}`.

- **Items:** `TimelineItem` is `{kind: 'message'|'trade', at, cursor, message|None, trade: TradeView|None}`. It is one `UNION ALL` of messages and the conversation's `trade` rows, one card per round at its `created_at`, showing current state (`trade_views`).
- **Order and paging:** `(at DESC, kind, id DESC)`, 50 per page. The cursor is opaque base64 of `at|kind|id`. A malformed cursor answers 422 `INVALID_CURSOR`.
- **Inline cards are a join, not event rows.**
- **`ConversationParty`** is `{trader_id|None, display_name, friend, handle (Friends only), band|None, completed_trades|None}`.
- **`status`:**
  - `'open'`.
  - `'you_blocked'`: the viewer blocked the other.
  - `'unavailable'`: the other blocked the viewer, is suspended, or is deleted (`trader_id` null). The three are byte-identical apart from names and ids.
- **Flags:** `can_message` and `can_propose` are `status == 'open'` and the viewer is not suspended. `can_report` is true unless the other is deleted, so Report stays available when the conversation is `unavailable` or `you_blocked`.
- A non-member or an unknown id answers 404 `CONVERSATION_NOT_FOUND`.

**List, read and archive.**

- **List:** `GET /api/social/conversations?archived=false&before=` answers `ConversationsView {conversations: [ConversationSummary], next_before}`.
  - `ConversationSummary` is `{id, other: ConversationParty, status, last_message: {from, preview (first 140 code points), at}|None, open_trades, waiting_on_you, unread, archived, last_activity_at}`.
  - Sorted by `last_activity_at DESC`, 50 per page.
- **Visible:** `archived_at IS NULL OR last_activity_at > archived_at`.
- **Unread:** the other side's `last_from_*_at > coalesce(read_at, '-infinity')`.
- **Read:** `POST .../read {through: cursor}` sets `read_at = greatest(read_at, at)`.
- **Archive:** `POST .../archive` and `.../unarchive`. Neither a conversation nor a message can be deleted.

**Freshness: polling, not push.** The gateway (`auth/src/server.ts`) proxies buffered, HMAC-signed requests, and the deployment provider is deferred (ADR 0002). So there is no SSE or WebSocket.

- **The pulse:** `GET /api/social/conversations/pulse` answers `{unread_conversations, watermark}`. It is two indexed statements: a count and `max(changed_at)` over the viewer's member rows, and the `max(created_at)` of their `inbox_update` rows.
- **Web polling:**
  - every 15 s while a conversation is open and visible;
  - every 60 s while visible otherwise;
  - never while hidden;
  - at once on focus.
- **On a new watermark** the web re-reads the inbox, the list and the open conversation's newest page. This replaces the inbox's "nothing polls" note.

## Proposals to strangers

- **Send (`POST /api/trades`)**, in order:
  1. `begin_trade_command`.
  2. `require_not_suspended`: 403 `ACCOUNT_SUSPENDED`.
  3. Resolve the recipient. An unknown `trader_id` answers 409 `COLLECTOR_UNAVAILABLE`.
  4. The `new_conversation` advisory lock.
  5. `lock_owners(sender, recipient)`. Stage 1 locked the sender only.
  6. `reach_one`, else 409 `COLLECTOR_UNAVAILABLE`. For a send by `recipient_id` (user id), also 409 `COLLECTOR_UNAVAILABLE` unless `how == 'friend'`, checked here after the locks, so a friendship ended by a racing Remove Friend or Block is seen.
  7. `open_conversation` (429 possible).
  8. The Stage 1 checks: `CASH_ONLY_NOT_OPEN`, and `NOT_TRADEABLE` through `among='reach'`.
  9. Insert with `conversation_id`.
- **Counter** checks `reach_one` instead of `friend_ids`: 409 `COLLECTOR_UNAVAILABLE`. Its caps use `among='reach'`, and it locks both, as today.
- **Accept** calls `require_not_suspended`, then `reach_one` (`trade_inventory.py:340`). It locks the recipient only. That is enough, because a suspension of the proposer locks every counterparty of its unconfirmed Trades (Reports and the owner review queue).
- **Decline, withdraw, cancel and Confirm swap** need no reach check. Confirm swap works after a Block, suspension or deletion (Stage 1 and map default 6).
- **Open to cash offers** applies to everyone, unchanged.
- **Discovery off mid-deal:** the conversation branch keeps Counters, accepts and messages working. Only the band goes.
- **The meetup tip** shows on an accepted Trade whose `other.friend` is false. It is web only.
- **Stage 1 tests** that assert `NOT_FRIENDS` on Trades now assert `COLLECTOR_UNAVAILABLE`. The accept-after-unfriend test needs a pair with no conversation, which the backfill guarantees for ex-Friends without open Trades, or else a Block. `NOT_FRIENDS` stays for Loans.

## Block extended

- **Routes.** `POST /api/social/traders/{trader_id}/block` and `/unblock {idempotency_key}` resolve the trader and run `_command(..., blocked_you_ok=True)` with the existing Block `apply`, setting `via = 'trader'` and `handle_shown`.
  - **Any existing `trader_id`** can be blocked or unblocked whatever the reach. Only an unknown one is 404 `COLLECTOR_NOT_FOUND`.
  - An Unblock with no Block changes nothing and answers the current relation, as today.
- **Effects** (Stage 1 code, unchanged):
  - `friendship_ended` cancels unconfirmed Loans, then Trades (`end_trades_between`, `trades.py:450`), with the reason-free `cancelled` update. The friendship is deleted and the `block` row inserted.
  - Open proposals close. Trades either side confirmed stay open and can still be confirmed.
- **Derived, no new writes:**
  - Neither collector appears in the other's `nearby_collectors` or `trade_reach`.
  - The conversation is `you_blocked` for the blocker and `unavailable` for the blocked side.
  - Messages and proposals answer 409 `COLLECTOR_UNAVAILABLE`.
  - The inbox loses the closed Trades' waiting lines.
- **No notification** beyond Stage 1's reason-free cancel update.
- **Unblock** reopens the conversation.

## Reports and the owner review queue

**Schema (migration 149):**

- **`trade_report`:**
  - `id uuid PK`;
  - `reporter_id`/`reported_id text REFERENCES inventory_owner ON DELETE SET NULL`;
  - `reporter_name`, `reported_name`, `reporter_handle`, `reported_handle` (owner screens are exempt from the copy rule);
  - `reason CHECK IN ('scam_or_no_show','harassment','inappropriate_content','other')`;
  - `note text CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 1000)`;
  - `source CHECK IN ('conversation','discovery','trade')`;
  - `trade_id uuid` and `conversation_id uuid`, neither with an FK;
  - `status CHECK IN ('open','dismissed','actioned') DEFAULT 'open'`;
  - `decision CHECK IN ('dismiss','remove_from_discovery','suspend')`;
  - `decided_at`, `decided_by text`, `created_at`.
  - Index `(status, created_at)`.
- **`trade_report_message`**: `(report_id REFERENCES trade_report ON DELETE CASCADE, message_id uuid, from_reporter boolean, body text, at timestamptz, PRIMARY KEY (report_id, message_id))`.
- **`trade_report_trade`**: `(report_id, trade_id uuid, facts jsonb, PRIMARY KEY (report_id, trade_id))`. `facts` holds the state, closed reason, each side's cards (name, set code, number, quantity), the cash, and the proposal, acceptance and confirmation times.
- **`moderation_event`**: `(id uuid PK, subject_id text, subject_name text, report_id uuid, action CHECK IN ('dismiss','remove_from_discovery','suspend','restore_discovery','lift_suspension'), owner_id text, note text, created_at)`. Append-only, with no FKs.

**A snapshot, not retention.**

- **What is copied:** the Report copies the whole conversation and every Trade of the pair into report-owned rows, in its own transaction, as they stand at that moment. Later messages (after an Unblock, say) and later Trade steps are not added.
- **Survives deletion:** the copies reference no user or message rows, so they outlive either account.
- **Owner sees only the snapshot:** the owner review screen shows the snapshot, never the live conversation.

**Collector route.** `POST /api/social/reports {trader_id, reason, note?, source, trade_id?, idempotency_key}` answers 201 `{reported: true}`.

1. **Before `_command`**, the route settles the allowance:
   - An unknown `trader_id` answers 404 `COLLECTOR_NOT_FOUND`.
   - Otherwise the Report is allowed when `reach_one` holds, or the two share a conversation, or `source = 'trade'` and `trade_id` is a Trade between them.
   - A `trade_id` that is not theirs answers 404 `TRADE_NOT_FOUND`. With none of these, the answer is 404 `COLLECTOR_NOT_FOUND`.
   - A conversation or Trade never disappears, so the allowance cannot be lost between this check and the command.
2. **Then** `_command(user, other, key, 'report', apply, blocked_you_ok=True, answer=lambda _: ReportResult(reported=True))`. `_command` gains an `answer` parameter whose default is today's `FriendCommandResult(relation=...)`. It runs with the `friend_command` count, both owners locked, and the `location_command` replay. `apply` does three things:
   - runs the Block `apply` (`via = 'trader'`, `handle_shown`);
   - inserts the report;
   - copies the snapshot.
3. **Same answer whatever the state.** Reporting a collector who already blocked the reporter, one who is suspended, or one who is open answers the same 201 body. Report stays offered in `unavailable` and `you_blocked` conversations.
4. **The reported collector is never told.** Nothing is stored or answered for them beyond the Block's existing effects.

**Owner routes** (`require_owner`, `main.py:129`, after `missing_cards.py:168-198`):

- `GET /api/admin/trade-reports?status=open&before=` answers the list and the count.
- `GET /api/admin/trade-reports/{id}` answers the report, its snapshot, and the reported collector's other reports and moderation events.
- `POST /api/admin/trade-reports/{id}/decision {action, note?}`:
  - 404 `REPORT_NOT_FOUND`;
  - 409 `REPORT_DECIDED`;
  - 409 `REPORTED_ACCOUNT_GONE` for `remove_from_discovery` or `suspend` on a deleted account.
- `POST /api/admin/collectors/{user_id}/restore {what: 'discovery'|'suspension', note?}`:
  - 404 `COLLECTOR_NOT_FOUND`;
  - 409 `NOTHING_TO_RESTORE` when the collector is not removed or not suspended.
- Every decision and restore writes a `moderation_event`. No automatic penalty beyond the reporter's Block.

**Suspension** sets the app-level flag `collector_profile.suspended_at` (Owner question 1). It is one transaction:

1. Read the counterparties of the account's unconfirmed open Trades, without locking.
2. `lock_owners(account, *counterparties)` in one ascending call.
3. Re-read the counterparties. If any is new, roll back and retry, at most 3 times, else 503 `INVENTORY_TEMPORARILY_UNAVAILABLE`. With the account's row held, no new send involving it can commit.
4. Set `suspended_at`, then `discovery.switch_off(conn, account)`.
5. Run `end_trades_between(conn, account, counterparty)` for each counterparty. **The actor is the suspended account**, so `closed_by` is them and the reason-free `cancelled` updates go to the counterparties (map default 6).
6. Write the `moderation_event` and mark the report `actioned`.

An accept or Confirm swap on one of those Trades holds a counterparty lock, so it finishes first. Contact steps re-check `reach_one` after their locks.

**What a suspended actor gets:**

- 403 `ACCOUNT_SUSPENDED` from every contact step, from switching discovery on, from `POST /friend-requests` (Handle and Invite Link paths) and add-friend, and from Borrow Request and Lend Offer sends (`loans.py`).
- Existing Loans continue. Friendships, Collections and their own reads are untouched.

**Removal** is `discovery.remove_from_discovery` plus the event, in one transaction under `lock_owners(account)`.

**Web.** `web/src/owner/sections.ts` adds `{id: 'trade-reports', queue: true}`, a `TradeReportsQueue.tsx` and a detail page modelled on `MissingQueue.tsx`. The count goes through `useQueueCounts.ts`.

## Add as Friend

`POST /api/social/trades/{trade_id}/add-friend {idempotency_key}` answers `{relation}`.

- **Before `_command`:**
  - `require_not_suspended`: 403 `ACCOUNT_SUSPENDED`.
  - 404 `TRADE_NOT_FOUND` for a non-party.
  - 409 `TRADE_NOT_SWAPPED` unless both `*_swap_at` are set.
  - 409 `COLLECTOR_UNAVAILABLE` unless `reach_one` holds. That covers deleted, blocked either way and suspended alike.
- **Then** `_command(..., blocked_you_ok=True)` against the resolved user id, which never leaves the server. Its `apply` re-checks `reach_one` under the locks (Refusal 409 `COLLECTOR_UNAVAILABLE`), then:
  - `request_received` accepts the request;
  - `none` inserts a pending friendship with `friendship.via_trade = true` (migration 148), under the usual cool-off (`TRY_LATER`).
- **Withdraw:** `POST /api/social/trades/{trade_id}/add-friend/withdraw`.
- **`GET /friends` leaves `via_trade` requests out of the requester's `sent`.** The requester follows the request through `TraderView.add_friend = 'sent'`.
  - The recipient sees it in `received` with the requester's Handle, which is the requester's own consent, and accepts there or on the Trade.
  - `add_friend` is `'offer'` when there is a both-confirmed Trade, the two are not Friends, no request is pending and they are reachable.

## Completed-trade count

- **Definition.** Trades with `proposer_swap_at IS NOT NULL AND recipient_swap_at IS NOT NULL`, counted for each party, Friend Trades included.
  - A Trade closed as `swapped` because the other account was deleted does not count, since one side never confirmed.
  - After the other account is deleted, a Trade both had confirmed still counts for the remaining side, whose id is still on the row.
- **Computation.** `trades.completed_trades(conn, user_ids) -> dict[str, int]` is one `UNION ALL` count over two partial indexes in 147: `trade_completed_proposer ON trade(proposer_id) WHERE proposer_swap_at IS NOT NULL AND recipient_swap_at IS NOT NULL`, and the recipient equivalent. There is no counter column.
- **Exposed** as `completed_trades: int` on `TradeMatchRow`, `NearbyMatchRow`, `CardHolder`, `TraderView`, `TraderTradeList`, `FriendTradeList`, `ConversationParty` and `TradeParty`.
  - It is null where the party is unavailable.
  - Zero reads "New to trading".

## Account deletion: what Stage 2 does now

Deletion is not built (social spec 419-427). Stage 2 makes it possible:

- **Kept rows.**
  - `conversation.user_low` and `user_high` go `SET NULL` with names kept, so the remaining side reads "This collector is no longer available".
  - `conversation_member`, `discovery_setting` and `block` cascade, and `handle_lookup_event` already cascades (migration 100).
  - Messages have no user FK.
  - `trade_report.*_id` go `SET NULL` with names and Handles kept. The snapshot rows and `moderation_event` have no user FKs.
- **For the deletion spec:**
  - cancel unconfirmed Trades first (Stage 1);
  - keep conversations and messages for the remaining side;
  - never delete `trade_report*` or `moderation_event` rows.

  Command-limit rows need no step: they cascade.

## Hidden For trade Locations

There is no API change beyond `visible_beyond_friends`: stranger reads go through `trade_listable`, which already lists hidden For trade Locations.

The wording keys on `visible_beyond_friends`, which is true while discovery is on or while any non-Friend can reach the collector through a conversation. It goes in two places:

- `web/src/workspace/LocationSettings.tsx`: the For trade and hidden lines.
- `web/src/settings/ForTradeLocationsSection.tsx:63-65`.

The copy is under Approved copy. While the flag is false, Stage 1's copy stays.

## Locks and concurrency

Lock order:

1. advisory command locks (the step's own, then `new_conversation`);
2. `inventory_owner` rows, ascending;
3. `loan` rows;
4. `trade` rows;
5. `conversation` rows.

Every trigger respects it.

| Step | Locks | Serialises against |
| --- | --- | --- |
| Message, existing conversation | sender | Block (locks both) |
| Message or send that may open a conversation | both | Block, discovery off, suspension, the reverse first contact |
| Send proposal | both (was sender only) | as above |
| Counter | both (unchanged) | |
| Accept | recipient (unchanged), then `trade`, then `conversation` (trigger) | Block; suspension (locks every counterparty) |
| Display Name change | own owner row (`owner_and_rows`), profile, then `loan` and `trade` names, then `conversation` names | accept, messages |
| Discovery `PUT`, owner removal | that collector | contact steps that lock both |
| Suspension | the account and every counterparty of its unconfirmed Trades | sends, accepts, Confirm swaps |
| Report, Block, add-friend | both (Friend command) | messages, sends |

A message in an existing conversation can land just after the recipient's suspension. This is benign, since the conversation is read-only from then on. `DeadlockDetected` answers 503 `INVENTORY_TEMPORARILY_UNAVAILABLE`.

## Error codes

| Code | Status | When |
| --- | --- | --- |
| `COLLECTOR_UNAVAILABLE` | 409 | A contact step (message, send, Counter, accept, add-friend) outside `trade_reach`. Also an unknown `trader_id`, or a send by a `recipient_id` that is not a Friend |
| `COLLECTOR_NOT_FOUND` | 404 (existing) | Trader reads and Report: unknown or unreachable, byte-identical. Trader Block and Unblock, and owner restore: unknown only |
| `BLOCK_NOT_FOUND` | 404 | Unblock by an unknown or someone else's `block_id` |
| `ACCOUNT_SUSPENDED` | 403 | The actor is suspended (contact steps, discovery on, Friend Requests, Borrow Requests, Lend Offers) |
| `RECIPIENT_REQUIRED` | 422 | A send with neither or both recipient fields |
| `INVALID_ZIP` / `UNKNOWN_ZIP` / `ZIP_REQUIRED` | 422 | Discovery `PUT` |
| `ZIP_CHANGE_LIMIT` | 429 | The fourth counted zip change in a rolling 24 h; `retry_after_minutes` |
| `DISCOVERY_UNAVAILABLE` | 409 | Switching on while removed or suspended |
| `EMPTY_MESSAGE` / `MESSAGE_TOO_LONG` | 422 | Message or note after `normalize_text` |
| `MESSAGE_RATE_LIMITED` | 429 | Over 120 messages in an hour; `retry_after_minutes` |
| `TOO_MANY_NEW_CONVERSATIONS` | 429 | The 11th counted new conversation in a rolling 24 h; `retry_after_minutes` |
| `CONVERSATION_NOT_FOUND` | 404 | Unknown conversation or non-member |
| `INVALID_CURSOR` | 422 | A malformed `before` or `through` cursor |
| `TRADE_NOT_SWAPPED` | 409 | Add-friend before both confirmations |
| `REPORT_NOT_FOUND` / `REPORT_DECIDED` / `REPORTED_ACCOUNT_GONE` | 404 / 409 / 409 | Owner decisions |
| `NOTHING_TO_RESTORE` | 409 | Owner restore of a collector who is not removed or not suspended |

Reused codes:

- `INVENTORY_TEMPORARILY_UNAVAILABLE` (503: deadlock, or suspension's retries exhausted);
- `TRADE_NOT_FOUND`, `OWN_ACCOUNT`, `TRY_LATER`, `TOO_MANY_CHANGES` (Friend and Trade commands, unchanged).

`NOT_FRIENDS` stays for Loans only. An unknown `printing_id` in card search is not an error: 200 with empty lists.

## Migrations (Trading block, 145 to 149)

| File | Contents |
| --- | --- |
| `145_open_discovery.sql` | `collector_profile.trader_id` and `suspended_at`; `discovery_setting` and its index; the `open_discovery` view; `distance_band`; the `handle_lookup_event` kind CHECK rebuilt with `'zip_change'`, `'new_conversation'` and `'message'` (migration 105's DO-block pattern, the union of every known kind) |
| `146_zip_centroids.sql` | `zip_centroid` and its generated data |
| `147_conversations.sql` | `conversation`, `conversation_member`, `message`; the names trigger `trade_names_follow_profile_conversations`; `trade.conversation_id` with its two triggers; the backfill; the completed-trade partial indexes |
| `148_trade_reach.sql` | `trade_reach`, `nearby_collectors`; `block.id`, `via` and `handle_shown` (default false, existing rows set true in the adding DO block); `friendship.via_trade` |
| `149_trade_reports.sql` | `trade_report`, `trade_report_message`, `trade_report_trade`, `moderation_event` |

- **Re-runnable:** all five follow the [migrations note](../../migrations.md), whose table gains these rows. 150 to 179 stay spare.
- **Not purely additive:**
  - 145 widens a CHECK.
  - 147 adds triggers to `trade` and `collector_profile`, and backfills.
  - 148 sets existing Block rows.
- **An older API build keeps working:**
  - It never reads the new columns.
  - The `BEFORE INSERT` trigger gives its Trades a conversation and both member rows.
  - A Block it inserts gets `handle_shown = false`, which is conservative.
  - Nothing it calls changed signature.
- Deploy migrations first.

## Web surfaces

- **Routes** (`web/src/shell/routes.ts:66-79`):
  - `/trades`: the conversation list, replacing `TradesList.tsx`.
  - `/trades/with/<trader_id>`: a conversation; an empty composer until the first message.
  - `/trades/trader/<trader_id>`: a stranger's Trade List.
  - `/trades/new/<trader_id>`: the proposal builder. `/trades/new/<Handle>` resolves and redirects to it.
  - `/trades/<Trade id>` and `/counter`: kept, linking to the conversation.
  - `sectionItems: ["new", "with", "trader"]`, all as lazy pages.
- **Find trades:**
  - The Friends section, then Near you with the radius choice, or the prompt to switch on.
  - Card search, Friends first.
  - Rows show the band and the track record, with Message, Trade List and Propose trade, and Block and Report behind ⋯.
- **Conversation:**
  - The header shows the name, band, track record and Trade List link, with Block and Report behind ⋯. Report stays in the read-only states.
  - Trade cards appear inline.
  - Read-only states read "This collector is no longer available", or "You blocked <name>" with a link to Settings.
  - Add as Friend appears on a Trade both sides confirmed.
- **Trade screen:** Report behind ⋯, and the meetup tip on accepted stranger Trades.
- **Settings:**
  - Open discovery: the switch, the zip, changes left, the removed and suspended states, and the GeoNames credit line. The radius is not here.
  - Blocked: `BlockedCollector` entries, with Unblock by `block_id`.
- **Shell:** a `usePulse` hook in `web/src/inbox/`. The Trades badge becomes `tradesWaiting + unread_conversations` (`Shell.tsx:137-138`).
- **Owner:** the Trade reports section, showing the snapshot only.
- **Clients:** new `/api/social` components go into `scripts/generate_social_client.py`, and `trades_generated.ts` is regenerated.

**UI copy rule (AGENTS.md):**

- Never show another collector's zip, coordinates, miles or Handle.
- No source names, except the legally required GeoNames credit.
- No polling, refresh or fetch times. Message send times are content and may show.
- Owner report screens are exempt.

## Approved copy

The owner approved all of this copy on 2026-10-23, including the replacement for the 2026-10-22 default's "tomorrow" sentence.

| Where | Approved copy |
| --- | --- |
| `ZIP_CHANGE_LIMIT` (replaces the default's "tomorrow" sentence, which a rolling window makes untrue) | "You've changed your zip code 3 times in the last 24 hours. Try again in N hours." N is `retry_after_minutes` rounded up to whole hours; under an hour, or when unavailable, it reads "Try again later." |
| `UNKNOWN_ZIP` | "We couldn't find that zip code. Try the zip code where you'd meet." |
| `MESSAGE_RATE_LIMITED` | "You're sending messages quickly. Try again in a few minutes." |
| `TOO_MANY_NEW_CONVERSATIONS` | "You've started 10 new conversations in the last 24 hours. Try again in N hours." N as for zip changes. |
| Near you while discovery is off | "Turn on open discovery to find collectors near you who want your cards or have cards you want." with a **Turn on** button |
| Accepted stranger Trade tip | "Meet somewhere public, like a local game store, and check the cards before you swap." |
| Conversation, other side blocked, suspended or deleted | "This collector is no longer available" |
| Conversation, blocker's side | "You blocked <name>." linking to Settings |
| Report reasons | Scam or no-show / Harassment / Inappropriate content / Other |
| Track record | "New to trading" / "1 completed trade" / "N completed trades" |
| Discovery removed by the owner | "Open discovery isn't available for your account." |
| Suspended (Trades tab and Settings) | "Your account can't trade or message right now." |
| For trade Locations while `visible_beyond_friends` (Settings) | "Friends, and collectors near you or in your conversations, can trade for the cards in these Locations and everything inside them." |
| A hidden For trade Location while `visible_beyond_friends` (LocationSettings) | "<path> is hidden from Friends, but its cards are still on your Trade List for Friends and for collectors near you or in your conversations." |
| Credit (Settings › Open discovery) | "Zip code locations include data from GeoNames (geonames.org), CC BY 4.0." |

## Stage 1 stories superseded

| Stage 1 story | What changes |
| --- | --- |
| 50 | A non-Friend Handle still answers as unknown on Friend routes. |
| 67 | Sending only to Friends: now anyone in `trade_reach`. |
| 105 | Stage 1 limited to Friends. |
| 118 | Accept checks reach (Friend, conversation or nearby), not friendship. |
| 194 | Non-Friends in reach see the Trade List and matching wants. Blocked collectors, either way, still see nothing. |

## Testing

**Seams.** The same as Stage 1:

- signed HTTP against real PostgreSQL first (`test_holdings.call`, `test_friend_copies.collector`, `befriend` and `block`, `test_trades.trading`);
- then the concurrency seam;
- then Playwright with `web/tests/support/collectors.ts`.

`discoverable(user, zip)` seeds a few fixed `zip_centroid` rows and switches discovery on.

1. **Zip and distance (`test_open_discovery.py`):**
   - `distance_band` at 0, 4.99, 5, 9.99, 10, 24.99, 25, 50 and 50.01 mi.
   - The bounding box never drops a collector the exact distance keeps, at latitudes 25° and 65°.
   - The `PUT` refusals in order.
   - `test_a_first_zip_is_not_a_change`.
   - `test_a_fourth_zip_change_in_24_hours_is_refused`: three changes, then 429 with `retry_after_minutes`. The same zip again is not counted.
   - Switching off keeps the zip. The radius filters by band.
2. **Reach and privacy (`test_trade_reach.py`, `test_stranger_privacy.py`):**
   - Each branch and exclusion: Block either way, suspension of either side, one side off, beyond 50 mi. The conversation branch survives switch-off and moves. Friends never appear in Near you.
   - **`test_no_stranger_response_carries_a_zip_coordinate_distance_handle_or_user_id`.** It walks the JSON of every stranger-facing route:
     - `/discovery` as read by the other side, `near`, `card-search`, `/traders/*` and `/conversations*`;
     - a stranger `TradeView`, the inbox and the pulse;
     - **`GET /blocks` and `GET /friends`.**

     It asserts that no value contains the stranger's zip, user id or Handle, or a coordinate to 2 decimals. No key is named `miles`, `distance`, `lat`, `lon` or `zip`, except in the viewer's own `DiscoverySettings`.
   - `test_unblock_routes_lift_only_their_own_kind`: a `'trader'` Block is untouched by the user-id unblock and answers as if absent, and the reverse; `block_id` lifts either kind.
   - `test_a_handle_lookup_never_leads_to_a_trader_id`. Look up B by Handle, then block B by user id: the Blocked list shows no `trader_id`. Look up again, then send by `recipient_id`: 409 `COLLECTOR_UNAVAILABLE`, and nothing is created. Send Add as Friend, then block: no Handle.
   - `test_unknown_and_unreachable_trader_ids_answer_byte_identical_404s` for `/traders/{id}`, `/trade-list`, `/matches` and Report.
   - `test_a_block_reads_like_a_suspension_to_the_blocked_side`: `TraderView` and `ConversationView` are byte-identical apart from names and ids.
   - `test_no_band_while_either_side_has_discovery_off`, on the trader header, the Trade List and the conversation.
   - `test_in_band_order_is_by_name_and_the_cap_is_per_viewer`. Two viewers in one band with 3 candidates and a cap of 2 can get different subsets, and the visible order is by name.
   - The OpenAPI walk: `NearbyMatchRow`, `CardHolder`, `TraderView`, `TraderTradeList`, `ConversationParty` and `BlockedCollector` declare no `collector_id`. `Collector`, `CollectorLookup`, `InviteCollector` and `FriendsView` declare no `trader_id`.
3. **Contract guards:**
   - the `REACH_CALL`, `DISCOVERY_TABLE` and `MESSAGE_TABLE` sets;
   - `TRADE_READ` and `WANTS_FRIENDS` call `trade_reach(`, and `READ` does not;
   - no `friend_ids` import in `trade_inventory`;
   - `reports.py` names no discovery table;
   - `ALLOWED_IMPORTS` entries for the new modules;
   - the names triggers on `collector_profile` fire in the order `loan`, `trade`, `trade_names_follow_profile_conversations` (`pg_trigger`).
4. **Find trades (`test_trade_matches.py`):**
   - Near you order: kind, band, name.
   - Caps: 100 rows, 20 cards per side, 50 holders and 20 cards each in card search.
   - Card search scopes `name`, `set` and `printing`. The `friends` list comes before `near`.
   - With discovery off, `status: 'off'`, an empty `near` list and `friends` still answered.
   - An unknown `printing_id` answers empty.
   - Old `/trades/new/<Handle>` resolution through `FriendTradeList.trader_id`.
   - `test_a_closed_trade_without_a_conversation_still_opens` (story 71): a closed Trade of an ex-Friend pair that the backfill left with no conversation still answers `GET /api/social/trades/{id}`, and its page `/trades/<id>` opens in the browser.
5. **Conversations (`test_conversations.py`):**
   - One per pair, from either side. Friends are not counted.
   - `test_the_eleventh_new_stranger_conversation_in_a_day_is_refused`.
   - A pair with a both-confirmed Trade but no conversation (ex-Friends) opens one uncounted, and its earlier Trades attach.
   - The backfill covers Friends-now and open-Trade pairs only.
   - The `BEFORE INSERT` trigger creates both member rows for a Trade inserted without `conversation_id`.
   - `normalize_text` rules; replay by key.
   - `MESSAGE_RATE_LIMITED` at 121 messages in an hour.
   - The timeline mixes rounds and messages across pages. `INVALID_CURSOR` on a bad cursor.
   - Unread, read and archive (a new message or proposal unarchives). The read-only states, with `can_report`.
   - The pulse moves on a message, a Trade step and an inbox update, and not on a rename.
6. **Strangers' Trades (extend `test_trades.py`):**
   - Send, Counter and accept between nearby strangers, with caps on the stranger's list.
   - The `COLLECTOR_UNAVAILABLE` cases.
   - Switch-off mid-deal still allows Counter and accept.
   - `CASH_ONLY_NOT_OPEN` for strangers.
   - The updated Stage 1 tests.
7. **Block, Report, suspension (`test_stranger_blocks.py`, `test_trade_reports.py`):**
   - **Block:**
     - The Block rule on stranger Trades.
     - Any existing `trader_id` can be blocked and unblocked; an unknown one is 404.
     - `handle_shown` and `via` in every case, including Invite Link and `via_trade`.
     - Unblock by `block_id`; `BLOCK_NOT_FOUND` for someone else's.
   - **Report:**
     - `test_report_after_being_blocked_matches_report_of_suspended`: byte-identical 201s.
     - Report blocks and snapshots. The snapshot is unchanged by later messages after an Unblock, and survives `DELETE FROM inventory_owner` of either side.
     - `test_the_reported_collector_is_never_told`: their inbox, pulse, `TraderView` and conversation are unchanged apart from the Block's effects.
     - The owner detail answers the snapshot only.
   - **Owner routes:**
     - Owner routes are 403 for non-owners.
     - Each decision writes an event.
     - Restore of discovery and suspension, with `NOTHING_TO_RESTORE`.
   - **Suspension:**
     - Its cancellations have the suspended account as `closed_by`, and the updates go to the counterparties.
     - A send committed between suspension's read and its locks makes it retry.
     - `test_a_suspended_collector_keeps_their_own_data`: Collection, Decks, Want List and existing Loan steps answer. Friend Requests by Handle, Invite Link and Add as Friend, Borrow Requests and Lend Offers are 403 `ACCOUNT_SUSPENDED`.
8. **Concurrency (real PostgreSQL, opposite directions):**
   - Block vs message;
   - Block vs stranger send;
   - switch-off vs first-contact send and first message;
   - suspension vs send, accept and Confirm swap;
   - A→B vs B→A first messages (one conversation);
   - two first contacts by one collector at a count of 9;
   - **`test_a_rename_racing_an_accept_does_not_deadlock`**;
   - a rename vs a message.

   None deadlocks.
9. **Capacity (`slow`, `capacity:`, `serial`):**
   - The Stage 1 200-Friend target (p95 1.5 s) still holds with `trade_reach` in `TRADE_READ`.
   - Near you with 500 candidates, 200 with matching Deck Lists: p95 at most 2.0 s.
   - Card search over 1,000 nearby candidates with 2,000 listable Editions each: p95 at most 1.0 s.

   These are design targets to confirm.
10. **Add as Friend and the count:**
    - Refused before both confirmations.
    - `COLLECTOR_UNAVAILABLE` when the other has blocked the requester, byte-identical to a suspended other.
    - Never in the requester's `sent`.
    - Both tapping makes Friends.
    - `completed_trades` counts both-confirmed Trades, Friend ones included, and still counts after the other account is deleted. A `swapped` close after a deletion with one confirmation does not count.
11. **Playwright (`trade-strangers-story.spec.ts`):**
    - A and B, 3 mi apart, switch discovery on.
    - B sees A in Near you ("Under 5 mi", "New to trading"), opens A's Trade List and messages A.
    - A's badge counts it after focus, and A replies.
    - B proposes. A accepts and sees the meetup tip. Both confirm and see "1 completed trade" and Add as Friend. B adds; A accepts in the Friends drawer.
    - Second story: C, who A has blocked, reports A from their read-only conversation. The owner suspends A from Trade reports, seeing only the snapshot. B's conversation with A reads "This collector is no longer available". A still opens their Collection.
    - Phone width and the accessibility checks.
    - No page text holds A's zip or Handle on B's or C's screens.

## Suggested tickets (vertical slices)

1. **Open discovery settings and zip data** (145, 146): the build script, the Settings section, the credit. Blocked by nothing.
2. **Conversations** (147): Friends-only messaging, the conversation list, inline Trades, read and archive, the pulse, the badge, the completed-trade count. Blocked by 1.
3. **The reach rule and stranger Trades** (148): `trade_reach` in the choke point, trader reads and the Trade List page, steps on `reach_one`, `TradeParty`, builder and Counter by `trader_id`, guards and the privacy sweep. Blocked by 1 and 2.
4. **Near you and card search**, with the capacity tests and the Location wording. Blocked by 3.
5. **Messaging strangers:** first contact, the spam limit, Message from rows and cards, the meetup tip. Blocked by 3.
6. **Block for strangers:** trader and block-id routes, `via`, `handle_shown`, the Blocked list, read-only states. Blocked by 3.
7. **Reports, owner queue, removal and suspension** (149), including the suspended-actor checks in Friend Requests, Borrow Requests and Lend Offers. Blocked by 6.
8. **Add as Friend.** Blocked by 3.
9. **Story spec, quiet full gate, burn-in.** Blocked by all.

Tickets 4, 5, 6 and 8 run in parallel after 3.

## ADR

Recorded in [ADR 0016](../../../../adr/0016-trading-beyond-friends-uses-one-reach-rule-and-trader-ids.md): **Trading beyond Friends uses one reach rule, and strangers are addressed by trader ids.**

- **One reach rule.** Every cross-collector Trade read and every contact step asks one SQL function, `trade_reach`, whether two collectors may trade or talk now. The answer is yes for Friends, for a pair with a conversation, or for two open-discovery collectors within 50 mi of each other's zip centroids. It is never yes across a Block or a suspension.
- **In the choke point.** `social.friend_copies` filters its Trade List and wants statements through it, beside `friends_of`, as ADR 0015 promised. Collection reads stay Friends-only.
- **Trader ids.** Strangers are addressed by a random, stable `trader_id`. They never receive a user id or Handle, and no route keyed by a user id or Handle answers a non-Friend's `trader_id`.
- **Distance** leaves the database only as a band. Candidate caps never rank by distance.
- **Freshness** is polled through one cheap pulse read until the deployment can carry streaming connections.
- **Rejected:**
  - a parallel stranger module;
  - exposing user ids;
  - stored distances or ranks;
  - PostGIS;
  - WebSockets or SSE now.

## Risks and open items

**Risks**

- **Block oracles (residual, accepted).** Each one links a Handle to a band, and each is accepted for the reasons below.
  - **Block, then watch Near you.** Someone who knows a Handle looks the collector up, blocks them by user id, and watches which Near you row disappears.
  - **Block from Near you, then probe by user id.** Someone blocks a Near you row through the trader route. Then a Handle lookup, an Invite Link read or a Friend Request by user id answers relation `'blocked'` for exactly that collector.
  - **Pace:** probing runs at the lookup limit of 30 an hour, with Blocks at 120 an hour.
  - The gain is small: the lookup already shows the Display Name, which usually identifies the row anyway.
  - Both need the prober's own discovery on within 50 mi. Both reveal the same thing: which band a Handle-known collector is in.
  - Not adopted, as too costly for the gain: keeping a Block's discovery effect for 24 h after an Unblock, to slow repeated probes. Recorded for the privacy review.
- **Location inference.** One patient account learns at most a target's zip over days of moves; many accounts multiply that. Signup caps and the opt-in limit it.
- **`trade_reach` in Stage 1's measured statements.** Re-run the 200-Friend capacity test. If it fails, keep `friends_of` for `among='friends'` and add only the suspension join.
- **Sends lock the recipient's owner row.** That briefly holds off the recipient's inventory commands, the same cost as a Counter today.
- **Polling load** grows with open tabs. The pulse can later answer 304 on an unchanged watermark.
- **Command replays** answer what was stored when the command first ran. A stranger's stored answer never held a Handle or user id.
- **Near you candidate cap** (500 per viewer, by band then per-viewer hash): in a dense area some matching collectors in a band are not shown. A viewer's cut is stable, so in a dense area that viewer may never see a given collector until the set of nearby collectors changes. Revisit with real numbers.
- **Stage 1 meaning change.** A null `TradeParty.collector_id` no longer means deleted. Grep the web before merging ticket 3.

**Open items, not plumbing**

- The copy table above, for the owner.
- Owner questions 1 to 7: answered 2026-10-23.
- The liability-notice review must record:
  - no age rule;
  - sales between strangers;
  - free-text messages;
  - the need for a message content policy.
- The Census licence wording is unconfirmed. Pin the source hashes in the build script.
- Capacity numbers are design targets.
- Out of scope: the email nudge. Deferred: reverse card search.
- The account-deletion spec gains the requirements above.
- The migrations note gains 145 to 149.
- ADR 0016 is written (see ADR above).
- **Glossary (`CONTEXT.md`):**
  - Add: Conversation, Message, Open discovery, Near you, Distance band, Report, Completed trade.
  - Add **Suspension**: "The owner's action that removes a collector from open discovery and stops them messaging, proposing, countering, accepting, and sending Friend Requests, Borrow Requests or Lend Offers. Their own Collection, Decks and existing Loans continue."
  - Amend Trade and Trade Proposal ("between two collectors").
  - Amend Open to cash offers ("anyone who can send them a proposal").
  - Amend Block: also strangers, also by Report; conversations read-only.
