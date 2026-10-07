ALTER TABLE catalog_review DROP CONSTRAINT catalog_review_kind_check;
ALTER TABLE catalog_review ADD CONSTRAINT catalog_review_kind_check
 CHECK(kind IN ('name_change','variant_ambiguity','source_match','reference_change'));
