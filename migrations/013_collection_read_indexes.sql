-- Current Holdings remain the only source of Collection totals.
CREATE INDEX holding_owner_leaf_quantity ON holding(owner_id,location_id,quantity DESC,edition_id);
CREATE INDEX catalog_printing_identity ON catalog_printing(identity_id,id);
CREATE INDEX catalog_edition_printing ON catalog_edition(printing_id,id);
