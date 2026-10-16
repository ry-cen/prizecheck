-- Hidden Locations (social network #249, spec "Blocks and Hidden Locations"). Social network migrations use the
-- reserved block 100-139 (docs/planning/social-network/migrations.md). Re-runnable.

-- The collector's own choice for this Location. Everything inside a hidden Location is hidden too; that is worked out
-- when read (hidden_locations below, and location_tree's hidden_by), never stored, so a Location added or moved
-- inside a hidden one is hidden at once. Hiding never moves the inventory revision.
ALTER TABLE location ADD COLUMN IF NOT EXISTS hidden boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS location_hidden ON location(owner_id) WHERE hidden;

-- Every Location of the given owners that Friends can't see: each Location the owner hid and every Location inside
-- it, at any depth. The one definition of "effectively hidden": Friend reads (social.friend_copies, #250) and the
-- Collection's own markers agree with it. Walks location_owner_parent from each hidden Location.
CREATE OR REPLACE FUNCTION hidden_locations(owners text[])
RETURNS TABLE(owner_id text, location_id uuid) LANGUAGE sql STABLE AS $$
  WITH RECURSIVE hidden(owner_id, location_id) AS (
    SELECT l.owner_id, l.id FROM location l WHERE l.owner_id = ANY(owners) AND l.hidden
    UNION
    SELECT c.owner_id, c.id FROM location c JOIN hidden h ON c.owner_id = h.owner_id AND c.parent_id = h.location_id
  )
  SELECT hidden.owner_id, hidden.location_id FROM hidden
$$;
