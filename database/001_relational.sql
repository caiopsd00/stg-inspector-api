-- Fresh BR LIFT database. No business entity is stored as JSON.
CREATE DOMAIN nonnegative_reading AS numeric(18,3) CHECK (VALUE >= 0 AND VALUE <> 'NaN'::numeric);
CREATE TABLE app_instance (singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), database_id uuid NOT NULL DEFAULT gen_random_uuid(), contract_version integer NOT NULL DEFAULT 2 CHECK(contract_version=2));
INSERT INTO app_instance(singleton) VALUES(true);
CREATE TABLE users (
 id text PRIMARY KEY, email text NOT NULL, name text NOT NULL, password_hash text NOT NULL,
 role text NOT NULL CHECK(role IN ('admin','technician')), active boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_key ON users(lower(email));
CREATE TABLE sessions (token_hash text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id), expires_at timestamptz NOT NULL);
CREATE INDEX sessions_user_idx ON sessions(user_id);
CREATE TABLE clients (
 id text PRIMARY KEY, name text NOT NULL CHECK(length(trim(name))>0), cnpj text NOT NULL UNIQUE CHECK(cnpj ~ '^[0-9]{14}$'),
 active boolean NOT NULL DEFAULT true, version integer NOT NULL DEFAULT 1 CHECK(version>0), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE technicians (
 id text PRIMARY KEY, name text NOT NULL CHECK(length(trim(name))>0), cpf text NOT NULL UNIQUE CHECK(cpf ~ '^[0-9]{11}$'),
 user_id text UNIQUE REFERENCES users(id), active boolean NOT NULL DEFAULT true, version integer NOT NULL DEFAULT 1 CHECK(version>0), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE equipment (
 id text PRIMARY KEY, client_id text NOT NULL REFERENCES clients(id), name text NOT NULL CHECK(length(trim(name))>0),
 type text NOT NULL DEFAULT '', brand text NOT NULL DEFAULT '', model text NOT NULL DEFAULT '', serial text NOT NULL DEFAULT '',
 manufacture_year smallint CHECK(manufacture_year BETWEEN 1800 AND 9999), plate text, plate_not_applicable boolean NOT NULL DEFAULT false,
 fleet text, fleet_not_applicable boolean NOT NULL DEFAULT false,
 active boolean NOT NULL DEFAULT true, version integer NOT NULL DEFAULT 1 CHECK(version>0), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,client_id), CHECK(NOT plate_not_applicable OR plate IS NULL), CHECK(NOT fleet_not_applicable OR fleet IS NULL)
);
CREATE INDEX equipment_client_idx ON equipment(client_id);
CREATE TABLE parts (
 id text PRIMARY KEY, name text NOT NULL CHECK(length(trim(name))>0), code text NOT NULL UNIQUE CHECK(length(trim(code))>0), supplier text NOT NULL DEFAULT '',
 active boolean NOT NULL DEFAULT true, version integer NOT NULL DEFAULT 1 CHECK(version>0), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE part_codes (code text PRIMARY KEY, part_id text NOT NULL REFERENCES parts(id), created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(code,part_id));
ALTER TABLE parts ADD CONSTRAINT parts_current_code_fk FOREIGN KEY(code,id) REFERENCES part_codes(code,part_id) DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX part_codes_part_idx ON part_codes(part_id);
CREATE TABLE files (
 id uuid PRIMARY KEY, mime text NOT NULL, name text NOT NULL, sha256 text NOT NULL, size bigint NOT NULL CHECK(size>0),
 width integer NOT NULL CHECK(width>0), height integer NOT NULL CHECK(height>0),
 storage_key text NOT NULL UNIQUE, created_by text NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(created_by,sha256)
);
CREATE TABLE service_orders (
 id text PRIMARY KEY, number text NOT NULL CHECK(length(trim(number))>0), client_id text REFERENCES clients(id), equipment_id text REFERENCES equipment(id),
 date date NOT NULL, status text NOT NULL CHECK(status IN ('draft','finalized')), type text NOT NULL CHECK(type IN ('interno','externo')),
 operator text NOT NULL DEFAULT '', requester text NOT NULL DEFAULT '', location text NOT NULL DEFAULT '',
 client_name text, client_cnpj text, equipment_type text NOT NULL DEFAULT '', equipment_brand text NOT NULL DEFAULT '', equipment_model text NOT NULL DEFAULT '', equipment_serial text NOT NULL DEFAULT '',
 equipment_year smallint CHECK(equipment_year BETWEEN 1800 AND 9999), equipment_plate text, equipment_plate_not_applicable boolean NOT NULL DEFAULT false,
 equipment_fleet text, equipment_fleet_not_applicable boolean NOT NULL DEFAULT false,
 odometer nonnegative_reading, odometer_not_applicable boolean NOT NULL DEFAULT false,
 hourmeter_lower nonnegative_reading, hourmeter_lower_not_applicable boolean NOT NULL DEFAULT false,
 hourmeter_upper nonnegative_reading, hourmeter_upper_not_applicable boolean NOT NULL DEFAULT false,
 concluded boolean, released boolean, photos_sent boolean, observations text NOT NULL DEFAULT '',
 finalized_at timestamptz, finalized_by text REFERENCES users(id),
 version integer NOT NULL DEFAULT 1 CHECK(version>0), created_by text NOT NULL REFERENCES users(id), updated_by text NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(equipment_id,client_id) REFERENCES equipment(id,client_id), CHECK(equipment_id IS NULL OR client_id IS NOT NULL),
 CHECK(status='draft' OR (client_id IS NOT NULL AND concluded IS NOT NULL AND released IS NOT NULL AND photos_sent IS NOT NULL)),
 CHECK(NOT odometer_not_applicable OR odometer IS NULL), CHECK(NOT hourmeter_lower_not_applicable OR hourmeter_lower IS NULL), CHECK(NOT hourmeter_upper_not_applicable OR hourmeter_upper IS NULL),
 CHECK(NOT equipment_plate_not_applicable OR equipment_plate IS NULL), CHECK(NOT equipment_fleet_not_applicable OR equipment_fleet IS NULL)
);
CREATE UNIQUE INDEX service_orders_number_key ON service_orders(lower(number));
CREATE INDEX service_orders_filter_idx ON service_orders(date DESC,status);
CREATE INDEX service_orders_client_idx ON service_orders(client_id);
CREATE INDEX service_orders_equipment_idx ON service_orders(equipment_id);
CREATE TABLE service_order_team (
 service_order_id text NOT NULL REFERENCES service_orders(id) ON DELETE CASCADE, technician_id text NOT NULL REFERENCES technicians(id), position integer NOT NULL CHECK(position>=0),
 role text NOT NULL CHECK(role IN ('technician','auxiliary')), technician_name text NOT NULL, technician_cpf text NOT NULL,
 PRIMARY KEY(service_order_id,technician_id), UNIQUE(service_order_id,position), CHECK(position<>0 OR role='technician')
);
CREATE INDEX service_order_team_technician_idx ON service_order_team(technician_id);
CREATE FUNCTION validate_order_team() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target text; state text;
BEGIN
 IF TG_TABLE_NAME='service_orders' THEN target=COALESCE(NEW.id,OLD.id); ELSE target=COALESCE(NEW.service_order_id,OLD.service_order_id); END IF;
 SELECT status INTO state FROM service_orders WHERE id=target;
 IF state IS NOT NULL AND (state='finalized' OR EXISTS(SELECT 1 FROM service_order_team WHERE service_order_id=target))
 AND NOT EXISTS(SELECT 1 FROM service_order_team WHERE service_order_id=target AND position=0 AND role='technician') THEN
 RAISE EXCEPTION 'A equipe precisa de um primeiro técnico' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER order_team_check AFTER INSERT OR UPDATE ON service_orders DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_order_team();
CREATE CONSTRAINT TRIGGER team_order_check AFTER INSERT OR UPDATE OR DELETE ON service_order_team DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_order_team();
CREATE TABLE service_order_reasons (
 service_order_id text NOT NULL REFERENCES service_orders(id) ON DELETE CASCADE, id text NOT NULL, position integer NOT NULL CHECK(position>=0), description text NOT NULL, pending text NOT NULL DEFAULT '',
 PRIMARY KEY(service_order_id,id), UNIQUE(service_order_id,position)
);
CREATE TABLE service_order_services (
 service_order_id text NOT NULL, reason_id text NOT NULL, id text NOT NULL, position integer NOT NULL CHECK(position>=0), description text NOT NULL, notes text NOT NULL DEFAULT '',
 PRIMARY KEY(service_order_id,id), UNIQUE(service_order_id,reason_id,position), FOREIGN KEY(service_order_id,reason_id) REFERENCES service_order_reasons(service_order_id,id) ON DELETE CASCADE
);
CREATE TABLE service_order_parts (
 service_order_id text NOT NULL REFERENCES service_orders(id) ON DELETE CASCADE, id text NOT NULL, part_id text REFERENCES parts(id), position integer NOT NULL CHECK(position>=0),
 code text NOT NULL CHECK(length(trim(code))>0), description text NOT NULL, supplier text NOT NULL DEFAULT '', quantity numeric(18,3) NOT NULL CHECK(quantity>0 AND quantity<>'NaN'::numeric),
 kind text NOT NULL CHECK(kind IN ('requested','replaced')), PRIMARY KEY(service_order_id,id), UNIQUE(service_order_id,position)
);
CREATE INDEX service_order_parts_part_idx ON service_order_parts(part_id);
CREATE TABLE service_order_part_codes (
 service_order_id text NOT NULL, service_order_part_id text NOT NULL, code text NOT NULL, position integer NOT NULL CHECK(position>=0),
 PRIMARY KEY(service_order_id,service_order_part_id,code), UNIQUE(service_order_id,service_order_part_id,position),
 FOREIGN KEY(service_order_id,service_order_part_id) REFERENCES service_order_parts(service_order_id,id) ON DELETE CASCADE
);
CREATE TABLE service_order_days (
 service_order_id text NOT NULL REFERENCES service_orders(id) ON DELETE CASCADE, id text NOT NULL, position integer NOT NULL CHECK(position>=0), date date NOT NULL,
 odometer_start nonnegative_reading, odometer_start_not_applicable boolean NOT NULL DEFAULT false, odometer_end nonnegative_reading, odometer_end_not_applicable boolean NOT NULL DEFAULT false,
 hourmeter_lower nonnegative_reading, hourmeter_lower_not_applicable boolean NOT NULL DEFAULT false, hourmeter_upper nonnegative_reading, hourmeter_upper_not_applicable boolean NOT NULL DEFAULT false,
 outbound_start time, outbound_end time, work_start time, work_end time, inbound_start time, inbound_end time,
 pause_period text NOT NULL CHECK(pause_period IN ('outbound','work','inbound')), pause_minutes numeric(10,2) CHECK(pause_minutes>=0 AND pause_minutes<>'NaN'::numeric),
 PRIMARY KEY(service_order_id,id), UNIQUE(service_order_id,position), CHECK(odometer_end IS NULL OR odometer_start IS NULL OR odometer_end>=odometer_start),
 CHECK(NOT odometer_start_not_applicable OR odometer_start IS NULL), CHECK(NOT odometer_end_not_applicable OR odometer_end IS NULL), CHECK(NOT hourmeter_lower_not_applicable OR hourmeter_lower IS NULL), CHECK(NOT hourmeter_upper_not_applicable OR hourmeter_upper IS NULL)
);
CREATE TABLE inspections (
 id text PRIMARY KEY, number text NOT NULL CHECK(length(trim(number))>0), name text NOT NULL DEFAULT '', client_id text REFERENCES clients(id), technician_id text REFERENCES technicians(id), equipment_id text REFERENCES equipment(id),
 date date NOT NULL, status text NOT NULL CHECK(status IN ('draft','finalized')), template_version integer NOT NULL DEFAULT 1 CHECK(template_version=1),
 client_name text, client_cnpj text, technician_name text, technician_cpf text,
 equipment_type text NOT NULL DEFAULT '', equipment_brand text NOT NULL DEFAULT '', equipment_model text NOT NULL DEFAULT '', equipment_serial text NOT NULL DEFAULT '', equipment_year smallint CHECK(equipment_year BETWEEN 1800 AND 9999),
 nominal_capacity text NOT NULL DEFAULT '', plate_fleet text NOT NULL DEFAULT '', examiner text NOT NULL DEFAULT '', inspection_date date, next_inspection_date date, result text NOT NULL DEFAULT '', performed_by text NOT NULL DEFAULT '', approved_by text NOT NULL DEFAULT '',
 finalized_at timestamptz, finalized_by text REFERENCES users(id),
 odometer nonnegative_reading, odometer_not_applicable boolean NOT NULL DEFAULT false, hourmeter nonnegative_reading, hourmeter_not_applicable boolean NOT NULL DEFAULT false,
 version integer NOT NULL DEFAULT 1 CHECK(version>0), created_by text NOT NULL REFERENCES users(id), updated_by text NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(equipment_id,client_id) REFERENCES equipment(id,client_id), CHECK(equipment_id IS NULL OR client_id IS NOT NULL),
 CHECK(status='draft' OR (client_id IS NOT NULL AND technician_id IS NOT NULL)), CHECK(NOT odometer_not_applicable OR odometer IS NULL), CHECK(NOT hourmeter_not_applicable OR hourmeter IS NULL)
);
CREATE UNIQUE INDEX inspections_number_key ON inspections(lower(number));
CREATE INDEX inspections_filter_idx ON inspections(date DESC,status);
CREATE INDEX inspections_client_idx ON inspections(client_id);
CREATE INDEX inspections_technician_idx ON inspections(technician_id);
CREATE INDEX inspections_equipment_idx ON inspections(equipment_id);
CREATE TABLE inspection_items (
 inspection_id text NOT NULL REFERENCES inspections(id) ON DELETE CASCADE, code text NOT NULL, id text NOT NULL, section_id text NOT NULL, section_name text NOT NULL, section_position integer NOT NULL CHECK(section_position>=0),
 position integer NOT NULL CHECK(position>=0), description text NOT NULL, situation char(1) CHECK(situation IN ('A','B','C','D')), observation text NOT NULL DEFAULT '', updated_at timestamptz,
 PRIMARY KEY(inspection_id,code), UNIQUE(inspection_id,id), UNIQUE(inspection_id,section_position,position)
);
CREATE TABLE service_order_files (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, service_order_id text NOT NULL REFERENCES service_orders(id) ON DELETE CASCADE, service_id text, file_id uuid NOT NULL REFERENCES files(id), name text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 purpose text NOT NULL CHECK(purpose IN ('service_photo','technician_signature','client_signature')), position integer NOT NULL DEFAULT 0 CHECK(position>=0),
 FOREIGN KEY(service_order_id,service_id) REFERENCES service_order_services(service_order_id,id) ON DELETE CASCADE,
 CHECK((purpose='service_photo')=(service_id IS NOT NULL)), CHECK(purpose='service_photo' OR position=0)
);
CREATE UNIQUE INDEX service_order_files_position_key ON service_order_files(service_order_id,purpose,service_id,position) NULLS NOT DISTINCT;
CREATE INDEX service_order_files_file_idx ON service_order_files(file_id);
CREATE TABLE inspection_files (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, inspection_id text NOT NULL REFERENCES inspections(id) ON DELETE CASCADE, item_code text, file_id uuid NOT NULL REFERENCES files(id), name text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 purpose text NOT NULL CHECK(purpose IN ('equipment_photo','technical_document','item_photo','extra_photo','signature')), slot_code text,
 position integer NOT NULL DEFAULT 0 CHECK(position>=0), FOREIGN KEY(inspection_id,item_code) REFERENCES inspection_items(inspection_id,code) ON DELETE CASCADE,
 CHECK((purpose IN ('item_photo','extra_photo'))=(item_code IS NOT NULL)), CHECK((purpose='extra_photo')=(slot_code IS NOT NULL)), CHECK(purpose<>'signature' OR position=0)
);
CREATE UNIQUE INDEX inspection_files_position_key ON inspection_files(inspection_id,purpose,item_code,slot_code,position) NULLS NOT DISTINCT;
CREATE INDEX inspection_files_file_idx ON inspection_files(file_id);
-- Technical envelopes only: never the authoritative business data.
CREATE TABLE sync_receipts (user_id text NOT NULL REFERENCES users(id), mutation_id text NOT NULL, request_hash text NOT NULL, response jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id,mutation_id));
CREATE TABLE audit (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, user_id text NOT NULL REFERENCES users(id), entity_type text NOT NULL, entity_id text NOT NULL, action text NOT NULL, before_data jsonb, after_data jsonb, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX audit_entity_idx ON audit(entity_type,entity_id,created_at);
