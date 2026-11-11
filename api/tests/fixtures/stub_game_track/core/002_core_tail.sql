-- Stands in for a core tail migration: it runs after the baseline and before the game track, on a database that has no
-- catalog_* relation yet.
CREATE TABLE core_tail_marker (id int PRIMARY KEY);
