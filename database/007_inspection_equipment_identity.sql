-- Preserve the two identifiers separately in each inspection snapshot.
-- Old combined values remain untouched: their meaning cannot be inferred safely.
ALTER TABLE inspections
  ADD COLUMN equipment_plate text,
  ADD COLUMN equipment_fleet text;
