-- Working copies preserve incomplete form input separately from checked rows.
-- A draft can have no reserved O.S.; the original unique indexes and all
-- schedule constraints still apply to the operational data.
ALTER TABLE service_orders
  ALTER COLUMN number DROP NOT NULL,
  ADD CONSTRAINT service_orders_final_number_check CHECK(status <> 'finalized' OR number IS NOT NULL),
  ADD COLUMN working_copy jsonb CHECK(jsonb_typeof(working_copy) = 'object');
ALTER TABLE inspections
  ALTER COLUMN number DROP NOT NULL,
  ADD CONSTRAINT inspections_final_number_check CHECK(status <> 'finalized' OR number IS NOT NULL),
  ADD COLUMN working_copy jsonb CHECK(jsonb_typeof(working_copy) = 'object');

