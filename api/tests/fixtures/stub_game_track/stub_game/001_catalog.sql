-- The least a game track must create before it can reference the catalog from core: the two tables the sixteen foreign keys
-- name. A real game's track has its own columns and many more tables.
CREATE TABLE catalog_edition (id uuid PRIMARY KEY);
CREATE TABLE catalog_printing (id uuid PRIMARY KEY, edition_id uuid NOT NULL REFERENCES catalog_edition(id));
