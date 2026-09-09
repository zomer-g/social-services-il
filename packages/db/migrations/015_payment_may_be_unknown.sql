-- "Free of charge" was being said about 19,191 services nobody had asked.
--
-- payment_required was NOT NULL DEFAULT false, so a service whose source said
-- nothing about money was indistinguishable from one that said it was free —
-- and both the site and the MCP tools read that false and printed "ללא תשלום".
-- In the export, 2,212 services actually say "no", 1,606 say "yes", and 19,191
-- say nothing at all; 3,667 of those blanks carry payment_details anyway, so
-- the silence was never evidence of anything.
--
-- Telling someone with no money that a service is free, when nobody knows, is
-- the most expensive wrong answer this corpus can give: they travel, and they
-- are turned away. Unknown is now its own value, and the interfaces say nothing
-- rather than guessing.

ALTER TABLE services
  ALTER COLUMN payment_required DROP NOT NULL,
  ALTER COLUMN payment_required DROP DEFAULT;

COMMENT ON COLUMN services.payment_required IS
  'true = charges, false = the source stated it is free, NULL = the source did not say. Never assume NULL means free.';

-- Every existing row was written under the old default, so none of them can be
-- trusted to distinguish "free" from "unstated". They are cleared, and the next
-- import restates the ones the source is actually explicit about.
UPDATE services SET payment_required = NULL WHERE payment_required = false;
