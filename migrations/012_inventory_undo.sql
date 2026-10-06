CREATE TABLE inventory_undo (
 id uuid PRIMARY KEY,
 owner_id text NOT NULL REFERENCES inventory_owner(user_id) ON DELETE CASCADE,
 action text NOT NULL CHECK(action IN ('move','remove')),
 source_id uuid NOT NULL,
 destination_id uuid,
 created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
 expires_at timestamptz NOT NULL DEFAULT (statement_timestamp() + interval '10 minutes'),
 payload jsonb NOT NULL
);
CREATE INDEX inventory_undo_owner ON inventory_undo(owner_id,created_at DESC);
CREATE INDEX inventory_undo_expiry ON inventory_undo(expires_at);
-- Every successful inventory mutation advances this row; cleanup participates in
-- its transaction. Daily maintenance can also run the same expiry DELETE.
CREATE FUNCTION cleanup_inventory_undo() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 DELETE FROM inventory_undo WHERE owner_id=NEW.user_id AND expires_at<=clock_timestamp();
 RETURN NEW;
END $$;
CREATE TRIGGER inventory_undo_cleanup AFTER UPDATE OF revision ON inventory_owner
 FOR EACH ROW EXECUTE FUNCTION cleanup_inventory_undo();
