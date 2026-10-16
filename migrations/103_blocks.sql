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

-- Friend commands (send, accept, decline, withdraw, remove, block, unblock) are limited per account like lookups are,
-- counted in handle_lookup_event under kind 'friend_command' (social.friends). Widens migration 100's kind check, by
-- whatever name it has, only when it doesn't allow the kind yet.
DO $$
DECLARE
  existing record;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'handle_lookup_event'::regclass AND contype = 'c'
               AND pg_get_constraintdef(oid) LIKE '%friend_command%') THEN
    RETURN;
  END IF;
  FOR existing IN SELECT conname FROM pg_constraint
      WHERE conrelid = 'handle_lookup_event'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%kind%' LOOP
    EXECUTE format('ALTER TABLE handle_lookup_event DROP CONSTRAINT %I', existing.conname);
  END LOOP;
  ALTER TABLE handle_lookup_event ADD CONSTRAINT handle_lookup_event_kind_check
    CHECK (kind IN ('lookup', 'handle_change', 'friend_command'));
END $$;

-- A Friend Request the recipient declined: the sender can't send that collector another for 7 days (social.friends).
-- Cleared when the recipient sends the sender a request, when the sender's next request goes through, and on Unblock.
CREATE TABLE IF NOT EXISTS friend_request_declined (
  sender_id text NOT NULL REFERENCES collector_profile(user_id) ON DELETE CASCADE,
  recipient_id text NOT NULL REFERENCES collector_profile(user_id) ON DELETE CASCADE,
  declined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (sender_id, recipient_id)
);
CREATE INDEX IF NOT EXISTS friend_request_declined_recipient ON friend_request_declined(recipient_id);
