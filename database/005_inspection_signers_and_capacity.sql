-- Additive inspection fields. Existing equipment, inspections and signatures remain intact.
ALTER TABLE equipment ADD COLUMN nominal_capacity text NOT NULL DEFAULT '';
UPDATE equipment e SET nominal_capacity=latest.nominal_capacity
FROM (
  SELECT DISTINCT ON (equipment_id) equipment_id,nominal_capacity
  FROM inspections
  WHERE equipment_id IS NOT NULL AND trim(nominal_capacity)<>''
  ORDER BY equipment_id,updated_at DESC
) latest
WHERE e.id=latest.equipment_id;
ALTER TABLE inspections ADD COLUMN approved_by_technician_id text REFERENCES technicians(id);

ALTER TABLE inspection_files DROP CONSTRAINT inspection_files_purpose_check;
ALTER TABLE inspection_files ADD CONSTRAINT inspection_files_purpose_check
  CHECK (purpose IN ('equipment_photo','technical_document','item_photo','extra_photo','signature','technician_signature','client_signature'));
ALTER TABLE inspection_files ADD CONSTRAINT inspection_signature_position_check
  CHECK (purpose NOT IN ('technician_signature','client_signature') OR position=0);
