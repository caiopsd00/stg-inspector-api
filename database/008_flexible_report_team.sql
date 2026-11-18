-- Preserve every historical assignment; position 0 remains the primary contact,
-- not a mandatory technical role. A finalized report still requires a team.
DO $$
DECLARE constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT conname FROM pg_constraint
    WHERE conrelid='service_order_team'::regclass AND contype='c'
      AND pg_get_constraintdef(oid) LIKE '%position%role%'
  LOOP
    EXECUTE format('ALTER TABLE service_order_team DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION validate_order_team() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target text; state text;
BEGIN
  IF TG_TABLE_NAME='service_orders' THEN target=COALESCE(NEW.id,OLD.id);
  ELSE target=COALESCE(NEW.service_order_id,OLD.service_order_id); END IF;
  SELECT status INTO state FROM service_orders WHERE id=target;
  IF state IS NOT NULL
    AND (state='finalized' OR EXISTS(SELECT 1 FROM service_order_team WHERE service_order_id=target))
    AND NOT EXISTS(SELECT 1 FROM service_order_team WHERE service_order_id=target AND position=0)
  THEN RAISE EXCEPTION 'Selecione ao menos um profissional na equipe' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
