CREATE TABLE riftbound_group_snapshot (
    group_id integer PRIMARY KEY CHECK (group_id > 0),
    snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
    snapshot_sha256 text NOT NULL CHECK (snapshot_sha256 ~ '^[0-9a-f]{64}$'),
    accepted_run uuid NOT NULL,
    accepted_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE riftbound_identity_evidence (
    identity_id uuid PRIMARY KEY REFERENCES catalog_identity(id),
    evidence_sha256 text NOT NULL CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$')
);
