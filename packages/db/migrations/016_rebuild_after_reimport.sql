-- The re-import brought two things the cards cannot see until they are rebuilt.
--
-- Every service and branch now carries source_updated_at — the date the source
-- last changed it, parsed out of the export's two rival date columns — and
-- payment_required has been restated from the source, so the 19,191 services
-- that never said anything about money are NULL again rather than false.
--
-- rebuild_cards() reads both. Until it runs, cards still hold the rebuild
-- timestamp as their date, which is the thing this whole sequence exists to
-- stop showing people.
INSERT INTO system_state (key, value)
VALUES ('cards_need_rebuild', 'real source dates and restated payment status from the re-import')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
