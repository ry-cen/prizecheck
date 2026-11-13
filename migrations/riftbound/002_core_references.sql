-- Adds the foreign keys the core baseline leaves out: core tables into the game's catalog (design brief D9).
ALTER TABLE art_fetch_failure ADD CONSTRAINT art_fetch_failure_printing_id_fkey FOREIGN KEY (printing_id) REFERENCES catalog_printing(id);
ALTER TABLE art_hit ADD CONSTRAINT art_hit_printing_id_fkey FOREIGN KEY (printing_id) REFERENCES catalog_printing(id);
ALTER TABLE art_large_upgrade ADD CONSTRAINT art_large_upgrade_printing_id_fkey FOREIGN KEY (printing_id) REFERENCES catalog_printing(id);
ALTER TABLE art_object ADD CONSTRAINT art_object_printing_id_fkey FOREIGN KEY (printing_id) REFERENCES catalog_printing(id);
ALTER TABLE borrowed_holding ADD CONSTRAINT borrowed_holding_edition_id_fkey FOREIGN KEY (edition_id) REFERENCES catalog_edition(id);
ALTER TABLE collection_import_row ADD CONSTRAINT collection_import_row_edition_id_fkey FOREIGN KEY (edition_id) REFERENCES catalog_edition(id);
ALTER TABLE collection_import_row ADD CONSTRAINT collection_import_row_printing_id_fkey FOREIGN KEY (printing_id) REFERENCES catalog_printing(id);
ALTER TABLE deck_list_line ADD CONSTRAINT deck_list_line_edition_id_fkey FOREIGN KEY (edition_id) REFERENCES catalog_edition(id);
ALTER TABLE holding ADD CONSTRAINT holding_edition_id_fkey FOREIGN KEY (edition_id) REFERENCES catalog_edition(id);
ALTER TABLE loan_line ADD CONSTRAINT loan_line_edition_id_fkey FOREIGN KEY (edition_id) REFERENCES catalog_edition(id);
ALTER TABLE missing_card_report ADD CONSTRAINT missing_card_report_approved_edition_id_fkey FOREIGN KEY (approved_edition_id) REFERENCES catalog_edition(id);
ALTER TABLE missing_card_report ADD CONSTRAINT missing_card_report_approved_printing_id_fkey FOREIGN KEY (approved_printing_id) REFERENCES catalog_printing(id);
ALTER TABLE missing_card_report ADD CONSTRAINT missing_card_report_printing_id_fkey FOREIGN KEY (printing_id) REFERENCES catalog_printing(id);
ALTER TABLE trade_accept ADD CONSTRAINT trade_accept_edition_id_fkey FOREIGN KEY (edition_id) REFERENCES catalog_edition(id);
ALTER TABLE trade_line ADD CONSTRAINT trade_line_edition_id_fkey FOREIGN KEY (edition_id) REFERENCES catalog_edition(id);
ALTER TABLE trade_want ADD CONSTRAINT trade_want_edition_id_fkey FOREIGN KEY (edition_id) REFERENCES catalog_edition(id);
