-- Additive: retain all legacy timelines/readings; no invented attendance on old records.
ALTER TABLE service_order_days ADD COLUMN notes text NOT NULL DEFAULT '';
ALTER TABLE service_order_days ADD COLUMN participants_defined boolean NOT NULL DEFAULT false;
CREATE TABLE service_order_day_participants (
 service_order_id text NOT NULL,
 day_id text NOT NULL,
 technician_id text NOT NULL REFERENCES technicians(id),
 position integer NOT NULL CHECK(position>=0),
 present boolean NOT NULL,
 same_hours_as text,
 same_vehicle_as text,
 odometer_start nonnegative_reading,
 odometer_start_not_applicable boolean NOT NULL DEFAULT false,
 odometer_end nonnegative_reading,
 odometer_end_not_applicable boolean NOT NULL DEFAULT false,
 PRIMARY KEY(service_order_id,day_id,technician_id),
 UNIQUE(service_order_id,day_id,position),
 FOREIGN KEY(service_order_id,day_id) REFERENCES service_order_days(service_order_id,id) ON DELETE CASCADE,
 FOREIGN KEY(service_order_id,technician_id) REFERENCES service_order_team(service_order_id,technician_id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(service_order_id,day_id,same_hours_as) REFERENCES service_order_day_participants(service_order_id,day_id,technician_id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(service_order_id,day_id,same_vehicle_as) REFERENCES service_order_day_participants(service_order_id,day_id,technician_id) DEFERRABLE INITIALLY DEFERRED,
 CHECK(same_hours_as IS DISTINCT FROM technician_id),
 CHECK(same_vehicle_as IS DISTINCT FROM technician_id),
 CHECK(odometer_end IS NULL OR odometer_start IS NULL OR odometer_end>=odometer_start),
 CHECK(NOT odometer_start_not_applicable OR odometer_start IS NULL),
 CHECK(NOT odometer_end_not_applicable OR odometer_end IS NULL)
);
CREATE TABLE service_order_participant_periods (
 service_order_id text NOT NULL,
 day_id text NOT NULL,
 technician_id text NOT NULL,
 id text NOT NULL,
 position integer NOT NULL CHECK(position>=0),
 kind text NOT NULL CHECK(kind IN ('outbound','work','inbound')),
 start_time time,
 end_time time,
 pause_minutes numeric(10,2) CHECK(pause_minutes>=0 AND pause_minutes<>'NaN'::numeric),
 PRIMARY KEY(service_order_id,day_id,technician_id,id),
 UNIQUE(service_order_id,day_id,technician_id,position),
 FOREIGN KEY(service_order_id,day_id,technician_id) REFERENCES service_order_day_participants(service_order_id,day_id,technician_id) ON DELETE CASCADE,
 CHECK(pause_minutes IS NULL OR pause_minutes=0 OR
   (start_time IS NOT NULL AND end_time IS NOT NULL AND pause_minutes <=
    extract(epoch FROM (end_time-start_time + CASE WHEN end_time<start_time THEN interval '1 day' ELSE interval '0' END))/60))
);
-- Contract 3 clients cannot overwrite participant-aware schedules.
ALTER TABLE app_instance DROP CONSTRAINT app_instance_contract_version_check;
ALTER TABLE app_instance ALTER COLUMN contract_version SET DEFAULT 4;
UPDATE app_instance SET contract_version=4;
ALTER TABLE app_instance ADD CONSTRAINT app_instance_contract_version_check CHECK(contract_version=4);
