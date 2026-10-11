-- Physical review evidence is retained beside, not inside, the revisioned lookup candidate.
-- Mapping revisions therefore advance only for lookup candidate or correspondence changes.
-- No Edition ID, descriptor, public reference or correspondence is rewritten here.
ALTER TABLE catalog_edition_metadata ADD COLUMN mapping_evidence jsonb NOT NULL DEFAULT '{}';
UPDATE catalog_edition_metadata SET
 mapping_evidence=jsonb_strip_nulls(jsonb_build_object(
  'physical_evidence',mapping_candidate->'physical_evidence',
  'variant_evidence',mapping_candidate->'variant_evidence')),
 mapping_candidate=mapping_candidate-'physical_evidence'-'variant_evidence'
WHERE mapping_candidate ?| ARRAY['physical_evidence','variant_evidence'];
