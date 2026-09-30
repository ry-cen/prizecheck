CREATE TABLE missing_card_report (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id text REFERENCES inventory_owner(user_id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN ('printing','edition')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','needs_info','rejected','approved')),
  set_id text,
  set_name text,
  collector_number text,
  english_name text,
  printing_id uuid REFERENCES catalog_printing(id),
  descriptor jsonb,
  evidence_url text,
  note text NOT NULL DEFAULT '',
  review_reason text,
  reviewer_id text REFERENCES inventory_owner(user_id),
  reviewed_at timestamptz,
  approved_printing_id uuid REFERENCES catalog_printing(id),
  approved_edition_id uuid REFERENCES catalog_edition(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind='printing' AND printing_id IS NULL) OR kind='edition')
);
CREATE INDEX missing_report_reporter ON missing_card_report(reporter_id,created_at DESC);
CREATE INDEX missing_report_queue ON missing_card_report(status,created_at);

CREATE TABLE catalog_override (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id uuid NOT NULL UNIQUE REFERENCES missing_card_report(id),
  printing_id uuid NOT NULL REFERENCES catalog_printing(id),
  edition_id uuid NOT NULL REFERENCES catalog_edition(id),
  revision bigint NOT NULL UNIQUE,
  reviewer_id text NOT NULL REFERENCES inventory_owner(user_id),
  reviewed_at timestamptz NOT NULL DEFAULT now(),
  evidence_url text NOT NULL,
  reason text NOT NULL,
  action text NOT NULL CHECK (action IN ('approve_printing','approve_edition'))
);

CREATE TABLE catalog_approval_code (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id text NOT NULL REFERENCES inventory_owner(user_id),
  report_id uuid NOT NULL REFERENCES missing_card_report(id),
  action text NOT NULL CHECK (action IN ('approve_printing','approve_edition')),
  code_hash text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX catalog_approval_code_lookup ON catalog_approval_code(owner_id,report_id,action,created_at DESC);
