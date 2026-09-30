CREATE INDEX catalog_gen_order ON catalog_generation_printing
  (generation_id, search_name, set_id, collector_number, printing_id)
  WHERE NOT tombstoned;
CREATE INDEX catalog_gen_set_number_ci ON catalog_generation_printing
  (generation_id, lower(set_id), lower(collector_number), search_name, printing_id)
  WHERE NOT tombstoned;
