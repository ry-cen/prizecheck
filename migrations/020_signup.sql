-- Better Auth's account INSERT and the collector's initial storage are one
-- PostgreSQL statement/transaction: failed onboarding cannot leave an account.
CREATE FUNCTION onboard_auth_account() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO inventory_owner(user_id) VALUES (NEW.id) ON CONFLICT(user_id) DO NOTHING;
 INSERT INTO location(id,owner_id,name,kind)
 VALUES (gen_random_uuid(),NEW.id,'Unsorted','storage_leaf')
 ON CONFLICT(owner_id,name) WHERE parent_id IS NULL AND name='Unsorted' DO NOTHING;
 RETURN NEW;
END $$;
CREATE TRIGGER onboard_auth_account AFTER INSERT ON "user"
 FOR EACH ROW EXECUTE FUNCTION onboard_auth_account();
