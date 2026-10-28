-- Confirming a manual Printing as a card of its own (#171). A Card Identity made by approving a missing-card report has
-- only a manual Printing, which waits in Owner controls' Reprints queue for a group. Merging, splitting and joining all
-- need a group that already exists, so such a Printing could never leave. The new ``confirm`` decision puts the named
-- ungrouped manual Printings into one new group of their own, by assignment, the way ``split`` does.
--
-- The decision log's CHECK gains the value. Rows already written keep their decisions, so nothing is rewritten. Safe to
-- run again.
ALTER TABLE catalog_card_identity_decision DROP CONSTRAINT IF EXISTS catalog_card_identity_decision_decision_check;
ALTER TABLE catalog_card_identity_decision ADD CONSTRAINT catalog_card_identity_decision_decision_check
 CHECK(decision IN ('merge','split','join','restore','confirm','merge_identity'));
