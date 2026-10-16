-- Blocks (social network #248, spec "Blocks and Hidden Locations"). Social network migrations use the reserved block
-- 100-139 (docs/planning/social-network/migrations.md). Re-runnable.

-- blocker_id blocked blocked_id. Blocking deletes the pair's friendship row in the same transaction
-- (social.friends.block); while the Block stands, the blocked collector can't find the blocker by Handle, use their
-- Invite Link or send them a Friend Request, and is never told why.
CREATE TABLE IF NOT EXISTS block (
  blocker_id text NOT NULL REFERENCES collector_profile(user_id) ON DELETE CASCADE,
  blocked_id text NOT NULL REFERENCES collector_profile(user_id) ON DELETE CASCADE,
  PRIMARY KEY (blocker_id, blocked_id),
  CONSTRAINT block_not_self CHECK (blocker_id <> blocked_id)
);
CREATE INDEX IF NOT EXISTS block_blocked ON block(blocked_id);

-- Every accepted Friend of each viewer with no Block either way: the one definition of "are Friends" that every
-- Friend read uses (social.friends.friend_ids, and social.friend_copies from #250). Replaces migration 102's version,
-- which had no Blocks to check. A Block deletes the friendship row too; this check stands behind that.
CREATE OR REPLACE FUNCTION friends_of(viewers text[])
RETURNS TABLE(viewer_id text, friend_id text) LANGUAGE sql STABLE AS $$
  SELECT pair.viewer_id, pair.friend_id FROM (
    SELECT f.user_low AS viewer_id, f.user_high AS friend_id FROM friendship f
      WHERE f.state = 'accepted' AND f.user_low = ANY(viewers)
    UNION ALL
    SELECT f.user_high, f.user_low FROM friendship f WHERE f.state = 'accepted' AND f.user_high = ANY(viewers)
  ) pair
  WHERE NOT EXISTS (SELECT 1 FROM block b WHERE (b.blocker_id = pair.viewer_id AND b.blocked_id = pair.friend_id)
                                             OR (b.blocker_id = pair.friend_id AND b.blocked_id = pair.viewer_id))
$$;
