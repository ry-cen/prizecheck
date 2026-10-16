-- Friends and Friend Requests (social network #247, spec "Friends and finding collectors"). Social network migrations
-- use the reserved block 100-139 (docs/planning/social-network/migrations.md). Re-runnable.

-- One row per pair of collectors, stored once: user_low is the smaller account id in byte order (COLLATE "C", the
-- order Python's sorted() gives, which is also the order both owners are locked in). A Friend Request is 'pending',
-- requested_by its sender; accepting it makes the row 'accepted', which is mutual. Declining, withdrawing and Remove
-- Friend delete the row. created_at is when the request was sent.
CREATE TABLE IF NOT EXISTS friendship (
  user_low text NOT NULL REFERENCES collector_profile(user_id) ON DELETE CASCADE,
  user_high text NOT NULL REFERENCES collector_profile(user_id) ON DELETE CASCADE,
  state text NOT NULL CHECK (state IN ('pending', 'accepted')),
  requested_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_low, user_high),
  CONSTRAINT friendship_pair_order CHECK ((user_low COLLATE "C") < (user_high COLLATE "C")),
  CONSTRAINT friendship_requested_by_member CHECK (requested_by IN (user_low, user_high))
);
CREATE INDEX IF NOT EXISTS friendship_high ON friendship(user_high);

-- Every accepted Friend of each viewer: the one definition of "are Friends" that Friend reads use
-- (social.friends.friend_ids, and social.friend_copies from #250). Batched over viewers, like hidden_locations.
-- Migration 103 (Blocks) replaces it with one that also drops a pair with a Block in either direction.
CREATE OR REPLACE FUNCTION friends_of(viewers text[])
RETURNS TABLE(viewer_id text, friend_id text) LANGUAGE sql STABLE AS $$
  SELECT f.user_low, f.user_high FROM friendship f WHERE f.state = 'accepted' AND f.user_low = ANY(viewers)
  UNION ALL
  SELECT f.user_high, f.user_low FROM friendship f WHERE f.state = 'accepted' AND f.user_high = ANY(viewers)
$$;
