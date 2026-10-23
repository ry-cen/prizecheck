-- Open discovery (Trading #297, Stage 2 spec "Zip codes and distance", "Open discovery switch";
-- docs/planning/trading/migrations.md). Trading migrations use the reserved block 140-179. Re-runnable. Not purely
-- additive: the handle_lookup_event kind CHECK is widened.
--
-- A collector's zip code stays in discovery_setting, with the centroid copied from zip_centroid (migration 146) when
-- the zip is set. Only api/app/social/discovery.py names these relations.
--
-- Merge order: this file widens the handle_lookup_event kind CHECK (last widened by 141_trades.sql). Whoever merges
-- second checks the CHECK against every branch that widened it: the last CHECK applied must allow the union of every
-- kind any branch writes (docs/planning/trading/migrations.md, "Two kind CHECKs are widened").

-- Random, stable and never shown. Routes that address a stranger use it instead of a Handle or a user id. Each existing
-- row gets its own value, because the default is volatile.
ALTER TABLE collector_profile ADD COLUMN IF NOT EXISTS trader_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE;

-- Set while the account is suspended (a later ticket writes it).
ALTER TABLE collector_profile ADD COLUMN IF NOT EXISTS suspended_at timestamptz;

CREATE TABLE IF NOT EXISTS discovery_setting (
  user_id text PRIMARY KEY REFERENCES collector_profile(user_id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  zip char(5),
  lat double precision,
  lon double precision,
  radius_mi smallint NOT NULL DEFAULT 25 CHECK (radius_mi IN (5, 10, 25, 50)),
  removed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT discovery_setting_enabled_has_place
    CHECK (NOT enabled OR (zip IS NOT NULL AND lat IS NOT NULL AND lon IS NOT NULL)),
  CONSTRAINT discovery_setting_enabled_not_removed CHECK (NOT (enabled AND removed_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS discovery_open_lat ON discovery_setting (lat) WHERE enabled;

-- Collectors who can be found: switched on, not removed by the owner, not suspended. Later migrations may only append
-- columns.
CREATE OR REPLACE VIEW open_discovery AS
  SELECT d.user_id, p.trader_id, d.lat, d.lon, d.radius_mi
  FROM discovery_setting d JOIN collector_profile p ON p.user_id = d.user_id
  WHERE d.enabled AND d.removed_at IS NULL AND p.suspended_at IS NULL;

-- The distance band between two points: 1 under 5 miles, 2 under 10, 3 under 25, 4 at 50 or less, NULL beyond 50 miles
-- or when any argument is NULL (the WHERE gives no row then, because least() ignores NULLs and would otherwise let a
-- missing coordinate through as a far-away point). Haversine with R = 3958.8 miles and the asin argument clamped to 1,
-- so antipodal points answer NULL instead of failing. The distance is rounded to 6 decimals of a mile (about 1.6 mm)
-- before it meets an edge: that tolerance admits up to 0.0000005 miles past an edge, far below the precision of the
-- 4-decimal centroids (about 30 feet), and keeps floating-point error from moving a point that sits on an edge.
CREATE OR REPLACE FUNCTION distance_band(lat1 double precision, lon1 double precision,
                                         lat2 double precision, lon2 double precision)
RETURNS smallint LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT (CASE WHEN m < 5 THEN 1 WHEN m < 10 THEN 2 WHEN m < 25 THEN 3 WHEN m <= 50 THEN 4 END)::smallint
  FROM (SELECT round((2 * 3958.8 * asin(least(1, sqrt(
          sin(radians(lat2 - lat1) / 2) ^ 2
          + cos(radians(lat1)) * cos(radians(lat2)) * sin(radians(lon2 - lon1) / 2) ^ 2))))::numeric, 6) AS m
        WHERE lat1 IS NOT NULL AND lon1 IS NOT NULL AND lat2 IS NOT NULL AND lon2 IS NOT NULL) AS d
$$;

-- 'zip_change' counts a collector's changes of a stored zip (Trading #297); 'new_conversation' and 'message' are
-- written by the conversation tickets. Widens the kind check, by whatever name it has, only when it doesn't allow the
-- kinds yet, with migration 105's pattern; the new CHECK is the union of every kind known. Keep this block last: its
-- RETURN ends the block, not the file, but a later statement would be easy to skip by mistake.
DO $$
DECLARE
  existing record;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'handle_lookup_event'::regclass AND contype = 'c'
               AND pg_get_constraintdef(oid) LIKE '%''zip_change''%'
               AND pg_get_constraintdef(oid) LIKE '%''new_conversation''%'
               AND pg_get_constraintdef(oid) LIKE '%''message''%') THEN
    RETURN;
  END IF;
  FOR existing IN SELECT conname FROM pg_constraint
      WHERE conrelid = 'handle_lookup_event'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%kind%' LOOP
    EXECUTE format('ALTER TABLE handle_lookup_event DROP CONSTRAINT %I', existing.conname);
  END LOOP;
  ALTER TABLE handle_lookup_event ADD CONSTRAINT handle_lookup_event_kind_check
    CHECK (kind IN ('lookup', 'handle_change', 'friend_command', 'loan_command', 'trade_command', 'zip_change',
                    'new_conversation', 'message'));
END $$;
