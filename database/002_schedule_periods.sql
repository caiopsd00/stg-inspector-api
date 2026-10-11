-- Additive migration: preserve legacy day columns and all existing readings.
CREATE TABLE service_order_day_periods (
 service_order_id text NOT NULL,
 day_id text NOT NULL,
 id text NOT NULL,
 position integer NOT NULL CHECK(position>=0),
 kind text NOT NULL CHECK(kind IN ('outbound','work','inbound')),
 start_time time,
 end_time time,
 pause_minutes numeric(10,2) CHECK(pause_minutes>=0 AND pause_minutes<>'NaN'::numeric),
 PRIMARY KEY(service_order_id,day_id,id),
 UNIQUE(service_order_id,day_id,position),
 FOREIGN KEY(service_order_id,day_id) REFERENCES service_order_days(service_order_id,id) ON DELETE CASCADE,
 CHECK(pause_minutes IS NULL OR pause_minutes=0 OR
   (start_time IS NOT NULL AND end_time IS NOT NULL AND pause_minutes <=
    extract(epoch FROM (end_time-start_time + CASE WHEN end_time<start_time THEN interval '1 day' ELSE interval '0' END))/60))
);
INSERT INTO service_order_day_periods(service_order_id,day_id,id,position,kind,start_time,end_time,pause_minutes)
SELECT d.service_order_id,d.id,d.id||'-'||p.kind,p.position,p.kind,p.start_time,p.end_time,
 CASE WHEN d.pause_period=p.kind THEN d.pause_minutes ELSE NULL END
FROM service_order_days d CROSS JOIN LATERAL (VALUES
 (0,'outbound',d.outbound_start,d.outbound_end),
 (1,'work',d.work_start,d.work_end),
 (2,'inbound',d.inbound_start,d.inbound_end)
) p(position,kind,start_time,end_time)
WHERE p.start_time IS NOT NULL OR p.end_time IS NOT NULL OR (d.pause_period=p.kind AND d.pause_minutes IS NOT NULL);
-- Old clients must not overwrite a multi-period day with the single-period DTO.
ALTER TABLE app_instance DROP CONSTRAINT app_instance_contract_version_check;
ALTER TABLE app_instance ALTER COLUMN contract_version SET DEFAULT 3;
UPDATE app_instance SET contract_version=3;
ALTER TABLE app_instance ADD CONSTRAINT app_instance_contract_version_check CHECK(contract_version=3);
