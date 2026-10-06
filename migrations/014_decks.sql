-- Decks share the existing Storage Leaf inventory and Move contracts.
CREATE INDEX location_owner_decks ON location(owner_id,lower(name),id) WHERE kind='deck';
