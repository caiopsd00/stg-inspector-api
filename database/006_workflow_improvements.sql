-- Add the new web workflow without replacing existing records or legacy readings.
ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('admin', 'technician', 'technician_admin'));

CREATE OR REPLACE FUNCTION require_technician_for_user() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target_user_id text;
BEGIN
  IF TG_TABLE_NAME = 'users' THEN
    target_user_id := NEW.id;
  ELSIF TG_OP <> 'INSERT' THEN
    target_user_id := OLD.user_id;
  END IF;
  IF target_user_id IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM users WHERE id=target_user_id AND role IN ('technician','technician_admin')
     )
     AND NOT EXISTS (SELECT 1 FROM technicians WHERE user_id=target_user_id) THEN
    RAISE EXCEPTION 'Usuário % precisa ter um cadastro de técnico vinculado.', target_user_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

ALTER TABLE clients DROP CONSTRAINT clients_cnpj_check;
ALTER TABLE clients ADD CONSTRAINT clients_cnpj_check CHECK(cnpj ~ '^[A-Z0-9]{12}[0-9]{2}$');

CREATE TABLE rental_companies (
  id text PRIMARY KEY, name text NOT NULL CHECK(length(trim(name))>0),
  active boolean NOT NULL DEFAULT true, version integer NOT NULL DEFAULT 1 CHECK(version>0),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX rental_companies_name_key ON rental_companies(lower(trim(name)));

CREATE TABLE vehicles (
  id text PRIMARY KEY, rental_company_id text NOT NULL REFERENCES rental_companies(id),
  plate text NOT NULL UNIQUE CHECK(plate ~ '^[A-Z0-9]{1,20}$'),
  model text NOT NULL DEFAULT '', color text NOT NULL DEFAULT '',
  active boolean NOT NULL DEFAULT true, version integer NOT NULL DEFAULT 1 CHECK(version>0),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX vehicles_rental_company_idx ON vehicles(rental_company_id);

CREATE TABLE record_fill_starts (
  kind text NOT NULL CHECK(kind IN ('reports','inspections')),
  record_id text NOT NULL, user_id text NOT NULL REFERENCES users(id),
  started_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(kind,record_id,user_id)
);
CREATE INDEX record_fill_starts_time_idx ON record_fill_starts(started_at);

ALTER TABLE service_orders DROP CONSTRAINT service_orders_type_check;
ALTER TABLE service_orders ADD CONSTRAINT service_orders_type_check
  CHECK(type IN ('interno','externo','remoto'));
-- This check had an implicit name and also required the removed photos question.
DO $$
DECLARE
  old_constraint text;
BEGIN
  SELECT conname INTO STRICT old_constraint
  FROM pg_constraint
  WHERE conrelid='service_orders'::regclass AND contype='c'
    AND pg_get_constraintdef(oid) LIKE '%photos_sent IS NOT NULL%';
  EXECUTE format('ALTER TABLE service_orders DROP CONSTRAINT %I',old_constraint);
END;
$$;
ALTER TABLE service_orders ADD CONSTRAINT service_orders_final_required_check
  CHECK(status='draft' OR (client_id IS NOT NULL AND concluded IS NOT NULL AND released IS NOT NULL));

ALTER TABLE service_orders
  ADD COLUMN form_revision smallint NOT NULL DEFAULT 1 CHECK(form_revision IN (1,2)),
  ADD COLUMN filling_started_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN vehicle_id text REFERENCES vehicles(id),
  ADD COLUMN vehicle_plate text,
  ADD COLUMN vehicle_model text,
  ADD COLUMN vehicle_color text,
  ADD COLUMN vehicle_rental_company text;
ALTER TABLE inspections
  ADD COLUMN form_revision smallint NOT NULL DEFAULT 1 CHECK(form_revision IN (1,2)),
  ADD COLUMN filling_started_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN vehicle_id text REFERENCES vehicles(id),
  ADD COLUMN vehicle_plate text,
  ADD COLUMN vehicle_model text,
  ADD COLUMN vehicle_color text,
  ADD COLUMN vehicle_rental_company text,
  ADD COLUMN hourmeter_upper nonnegative_reading,
  ADD COLUMN hourmeter_upper_not_applicable boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT inspections_hourmeter_upper_na_check
    CHECK(NOT hourmeter_upper_not_applicable OR hourmeter_upper IS NULL);
ALTER TABLE service_order_team ADD COLUMN charged boolean;
ALTER TABLE service_order_services ADD COLUMN completed boolean;

CREATE TABLE inspection_days (
  inspection_id text NOT NULL REFERENCES inspections(id) ON DELETE CASCADE,
  id text NOT NULL, position integer NOT NULL CHECK(position>=0),
  date date NOT NULL, notes text NOT NULL DEFAULT '',
  PRIMARY KEY(inspection_id,id), UNIQUE(inspection_id,position)
);
CREATE TABLE inspection_day_periods (
  inspection_id text NOT NULL, day_id text NOT NULL, id text NOT NULL,
  position integer NOT NULL CHECK(position>=0),
  kind text NOT NULL CHECK(kind IN ('outbound','work','inbound')),
  start_time time, end_time time,
  pause_minutes numeric(10,2) CHECK(pause_minutes>=0 AND pause_minutes<>'NaN'::numeric),
  PRIMARY KEY(inspection_id,day_id,id), UNIQUE(inspection_id,day_id,position),
  FOREIGN KEY(inspection_id,day_id) REFERENCES inspection_days(inspection_id,id) ON DELETE CASCADE,
  CHECK(pause_minutes IS NULL OR pause_minutes=0 OR
    (start_time IS NOT NULL AND end_time IS NOT NULL AND pause_minutes <=
     extract(epoch FROM (end_time-start_time + CASE WHEN end_time<start_time THEN interval '1 day' ELSE interval '0' END))/60))
);
DO $$
DECLARE
  period_table text;
BEGIN
  FOREACH period_table IN ARRAY ARRAY[
    'service_order_day_periods','service_order_participant_periods','inspection_day_periods'
  ] LOOP
    EXECUTE format('ALTER TABLE %I
      ADD COLUMN odometer_start nonnegative_reading,
      ADD COLUMN odometer_start_not_applicable boolean NOT NULL DEFAULT false,
      ADD COLUMN odometer_end nonnegative_reading,
      ADD COLUMN odometer_end_not_applicable boolean NOT NULL DEFAULT false,
      ADD CHECK(NOT odometer_start_not_applicable OR odometer_start IS NULL),
      ADD CHECK(NOT odometer_end_not_applicable OR odometer_end IS NULL),
      ADD CHECK(odometer_end IS NULL OR odometer_start IS NULL OR odometer_end>=odometer_start)', period_table);
  END LOOP;
END;
$$;

-- A signature capture is an event: reusing identical image bytes still creates
-- a different capture with a new server time.
CREATE TABLE signature_captures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), file_id uuid NOT NULL REFERENCES files(id),
  kind text NOT NULL CHECK(kind IN ('reports','inspections')), record_id text NOT NULL,
  signer_role text NOT NULL CHECK(signer_role IN ('technician','client')),
  signer_name text NOT NULL CHECK(length(trim(signer_name)) BETWEEN 1 AND 300),
  signed_at timestamptz NOT NULL DEFAULT now(), created_by text NOT NULL REFERENCES users(id),
  UNIQUE(id,file_id)
);
ALTER TABLE service_order_files
  ADD COLUMN capture_id uuid,
  ADD FOREIGN KEY(capture_id,file_id) REFERENCES signature_captures(id,file_id),
  ADD CHECK(capture_id IS NULL OR purpose IN ('technician_signature','client_signature'));
ALTER TABLE inspection_files
  ADD COLUMN capture_id uuid,
  ADD FOREIGN KEY(capture_id,file_id) REFERENCES signature_captures(id,file_id),
  ADD CHECK(capture_id IS NULL OR purpose IN ('technician_signature','client_signature'));

-- Backfill after DDL; updating reports queues their deferred team trigger.
-- For preexisting records, first persistence is the earliest known time.
UPDATE service_orders SET filling_started_at=created_at;
UPDATE inspections SET filling_started_at=created_at;
-- Keep historical technician IDs for reports already signed/assigned.
UPDATE technicians t SET active=false, version=version+1, updated_at=now()
FROM users u WHERE t.user_id=u.id AND u.role='admin' AND t.active;
