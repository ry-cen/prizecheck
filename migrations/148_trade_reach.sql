-- The reach rule (Trading #299, Stage 2 spec "The reach rule" and "Identity"; docs/planning/trading/migrations.md).
-- Trading migrations use the reserved block 140-179. Re-runnable. Not purely additive: it sets existing Block rows'
-- handle_shown.
--
-- Two collectors are in reach when they are Friends, share a conversation, or are both in open discovery within 50
-- miles, and neither has Blocked the other and neither is suspended. trade_reach answers that for a viewer and a list of
-- other collectors; only social/friend_copies.py and social/discovery.py call it (test_social_contract.py).
--
-- The conversation join compares account ids COLLATE "C" (byte order), as friendship_pair_order, conversation_ordered and
-- Python sorted() do, because a pair is stored in that order. The comparison sits inside a CASE on purpose:
-- least(a COLLATE "C", b COLLATE "C") would have collation "C", and PostgreSQL uses the conversation_pair index for
-- column = expression only when the expression has the column's (default) collation. A CASE over the "C" comparison
-- yields the plain ids, so the index stays usable.
--
-- The Block and Add-as-Friend columns at the end are only added here: later tickets read and write them (#302 Block
-- by trader id, #304 Add as Friend from a Trade).

-- For each id in others that the viewer can reach: how ('friend' beats 'conversation' beats 'near') and, unless the two
-- are Friends, the distance band while both have open discovery (NULL otherwise). Nothing for the viewer's own id, an
-- unknown or NULL id, a Block either way or a suspended side. A duplicate id gives duplicate rows, so callers pass a
-- deduplicated array.
CREATE OR REPLACE FUNCTION trade_reach(viewer text, others text[])
RETURNS TABLE(other_id text, how text, band smallint) LANGUAGE sql STABLE AS $$
  SELECT o.id,
         CASE WHEN f.friend_id IS NOT NULL THEN 'friend' WHEN c.id IS NOT NULL THEN 'conversation' ELSE 'near' END,
         CASE WHEN f.friend_id IS NULL THEN distance_band(dv.lat, dv.lon, d.lat, d.lon) END
  FROM unnest(others) AS o(id)
  JOIN collector_profile p ON p.user_id = o.id AND p.suspended_at IS NULL
  JOIN collector_profile me ON me.user_id = viewer AND me.suspended_at IS NULL
  LEFT JOIN friends_of(ARRAY[viewer]) f ON f.friend_id = o.id
  LEFT JOIN conversation c
    ON c.user_low = CASE WHEN (viewer COLLATE "C") < (o.id COLLATE "C") THEN viewer ELSE o.id END
   AND c.user_high = CASE WHEN (viewer COLLATE "C") < (o.id COLLATE "C") THEN o.id ELSE viewer END
  LEFT JOIN open_discovery dv ON dv.user_id = viewer
  LEFT JOIN open_discovery d ON d.user_id = o.id
  WHERE o.id <> viewer
    AND NOT EXISTS (SELECT 1 FROM block b WHERE (b.blocker_id = viewer AND b.blocked_id = o.id)
                                             OR (b.blocker_id = o.id AND b.blocked_id = viewer))
    AND (f.friend_id IS NOT NULL OR c.id IS NOT NULL OR distance_band(dv.lat, dv.lon, d.lat, d.lon) IS NOT NULL)
$$;

-- Collectors near the viewer, nearest band first and in a stable order that differs per viewer (md5 of the viewer's id
-- and the other's trader_id), at most max_rows of them, within max_band (1 to 4). Leaves out the viewer's Friends and
-- anyone Blocked either way. The bounding box (50 miles of latitude is 0.7246 degrees; longitude degrees shrink with
-- the cosine of the latitude, taken at the edge nearest a pole and capped at 89 degrees) narrows the rows before
-- distance_band decides. A viewer outside open_discovery (off, removed or suspended) gets no rows, because me is empty.
CREATE OR REPLACE FUNCTION nearby_collectors(viewer text, max_band smallint, max_rows int)
RETURNS TABLE(other_id text, band smallint) LANGUAGE sql STABLE AS $$
  SELECT d.user_id, distance_band(me.lat, me.lon, d.lat, d.lon)
  FROM open_discovery me
  JOIN open_discovery d
    ON d.lat BETWEEN me.lat - 0.7246 AND me.lat + 0.7246
   AND d.lon BETWEEN me.lon - 50 / (69.172 * cos(radians(least(89, abs(me.lat) + 0.7246))))
                 AND me.lon + 50 / (69.172 * cos(radians(least(89, abs(me.lat) + 0.7246))))
  WHERE me.user_id = viewer AND d.user_id <> viewer
    AND distance_band(me.lat, me.lon, d.lat, d.lon) <= max_band
    AND NOT EXISTS (SELECT 1 FROM friends_of(ARRAY[viewer]) f WHERE f.friend_id = d.user_id)
    AND NOT EXISTS (SELECT 1 FROM block b WHERE (b.blocker_id = viewer AND b.blocked_id = d.user_id)
                                             OR (b.blocker_id = d.user_id AND b.blocked_id = viewer))
  ORDER BY 2, md5(viewer || d.trader_id::text)
  LIMIT max_rows
$$;

-- A Block gets an id of its own (a stranger's Block is addressed by it, never by a user id), a via ('collector': made
-- from a Handle or a Friend; 'trader': made from a trader id) and handle_shown (whether the blocker may see the blocked
-- collector's Handle in their Blocked list).
ALTER TABLE block ADD COLUMN IF NOT EXISTS id uuid NOT NULL DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX IF NOT EXISTS block_id_unique ON block (id);

ALTER TABLE block ADD COLUMN IF NOT EXISTS via text NOT NULL DEFAULT 'collector';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'block_via' AND conrelid = 'block'::regclass) THEN
    ALTER TABLE block ADD CONSTRAINT block_via CHECK (via IN ('collector', 'trader'));
  END IF;
END $$;

-- Existing Blocks keep showing their Handle (today's Blocked list does). New rows default to false, so an older API build
-- that inserts a Block hides it until a later ticket's code decides. The UPDATE runs only when the column is added, so
-- a re-run never flips a later row.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'block'::regclass AND attname = 'handle_shown'
                   AND NOT attisdropped) THEN
    ALTER TABLE block ADD COLUMN handle_shown boolean NOT NULL DEFAULT false;
    UPDATE block SET handle_shown = true;
  END IF;
END $$;

-- True for a friendship that began as an Add-as-Friend request from a Trade (#304). Existing friendships did not.
ALTER TABLE friendship ADD COLUMN IF NOT EXISTS via_trade boolean NOT NULL DEFAULT false;
