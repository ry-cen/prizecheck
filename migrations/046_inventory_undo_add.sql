-- Batch add (#175, spec "Batch add and Gather Undo"): an Inventory Undo record of a new `add` kind for the copies one
-- batch add put in one Location. Its destination_id is that Location; it names no source (source_id NULL,
-- source_count 0); its payload items are {edition_id, quantity}. Undoing it takes exactly those copies out again.
-- Undoing an add returns copies to no source, so its replay row in move_response has source_count 0, as does the
-- replay row of the batch add itself.
-- Expand-only, as 026: the previous application keeps working against this schema. It lists an `add` record like any
-- other, and its Undo reads a NULL source for every item and answers UNDO_INCOMPATIBLE instead of misapplying it.
-- Take both locks in one statement, in the order the application touches these tables (move_response, then
-- inventory_undo), so no ALTER below upgrades a weaker lock while a writer waits.
LOCK TABLE move_response, inventory_undo IN ACCESS EXCLUSIVE MODE;

ALTER TABLE move_response
  DROP CONSTRAINT move_response_source_count_check,
  ADD CONSTRAINT move_response_source_count_check CHECK (source_count >= 0);

-- A Move or Removal names its one source, or how many sources when there are several; an add names none and always
-- has its Location.
ALTER TABLE inventory_undo
  DROP CONSTRAINT inventory_undo_action_check,
  ADD CONSTRAINT inventory_undo_action_check CHECK (action IN ('move','remove','add')),
  DROP CONSTRAINT inventory_undo_source_count_check,
  ADD CONSTRAINT inventory_undo_source_count_check CHECK (source_count >= 0),
  DROP CONSTRAINT inventory_undo_source_present,
  ADD CONSTRAINT inventory_undo_source_present CHECK (CASE WHEN action = 'add'
    THEN source_id IS NULL AND source_count = 0 AND destination_id IS NOT NULL
    ELSE source_count > 0 AND (source_id IS NOT NULL OR source_count > 1) END);
