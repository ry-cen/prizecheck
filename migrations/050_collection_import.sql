-- Collection Import (#226, spec "Collection import from other trackers"; ADR 0014): a collector's uploaded file as an
-- import draft on the server, one open draft per collector, and its source rows. Saving adds the ready rows' copies
-- to the landing Storage Leaf, marks the draft saved with its result (so a repeated save answers it for 24 hours) and
-- deletes the rows, which hold the collector's whole file.
-- Expand-only: two new tables that the previous application never reads.
CREATE TABLE collection_import (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL REFERENCES inventory_owner(user_id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','saved')),
  -- The landing Storage Leaf. No foreign key: a draft must never stop the collector deleting or converting a
  -- Location; saving checks it again and refuses REVIEW_CHANGED.
  location_id uuid NOT NULL,
  -- Groups the collector left out (#232).
  excluded_groups jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- The detected source and the file's header, for matching and for downloads in the file's own columns. Never shown.
  source text NOT NULL,
  source_header jsonb NOT NULL,
  draft_revision bigint NOT NULL DEFAULT 1 CHECK (draft_revision > 0),
  -- catalog_state.revision when the rows were matched.
  catalog_revision bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  changed_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
  saved_at timestamptz,
  save_key uuid,
  -- The save's response, answered again to a repeated save.
  save_result jsonb,
  CONSTRAINT collection_import_saved_fields
    CHECK ((status = 'saved') = (saved_at IS NOT NULL AND save_key IS NOT NULL AND save_result IS NOT NULL))
);
CREATE UNIQUE INDEX collection_import_one_open_per_owner ON collection_import(owner_id) WHERE status = 'open';
CREATE INDEX collection_import_expiry ON collection_import(expires_at);

CREATE TABLE collection_import_row (
  import_id uuid NOT NULL REFERENCES collection_import(id) ON DELETE CASCADE,
  -- 1 for the file's first row after its header.
  row_number integer NOT NULL CHECK (row_number > 0),
  -- The file's group (a list or binder name) for sources that have one (#232).
  group_name text,
  -- The row's cells as one CSV line, for downloads (#229, #231). Never returned by the API.
  raw_text text NOT NULL,
  -- The fields matching reads (collection_import_reader.FIELDS), as text.
  parsed jsonb NOT NULL,
  -- NULL when the quantity can't be read.
  quantity bigint CHECK (quantity > 0),
  status text NOT NULL
    CHECK (status IN ('matched','finish_unknown','by_name','ambiguous','not_found','unreadable')),
  printing_id uuid REFERENCES catalog_printing(id),
  edition_id uuid REFERENCES catalog_edition(id),
  -- Candidate Printings or Editions to pick from (#229).
  candidates jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Why a row is left out of the import (#231), or NULL.
  left_out_reason text,
  skipped boolean NOT NULL DEFAULT false,
  -- The collector's change to the row (#229, #230), or NULL.
  fix jsonb,
  PRIMARY KEY (import_id, row_number),
  CONSTRAINT collection_import_row_ready_has_edition
    CHECK (status NOT IN ('matched','finish_unknown','by_name')
           OR (printing_id IS NOT NULL AND edition_id IS NOT NULL AND quantity IS NOT NULL))
);
