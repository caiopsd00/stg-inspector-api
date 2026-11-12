import type { DayPeriod } from "../../contracts/domain.js";
import {
  nullable,
  reading,
  readingColumns,
  time,
} from "../relational-utils.js";

export function periodColumns(period: DayPeriod) {
  return {
    id: period.id,
    kind: period.kind,
    start_time: nullable(period.start),
    end_time: nullable(period.end),
    pause_minutes: nullable(period.pauseMinutes),
    ...readingColumns("odometer_start", period.odometerStart),
    ...readingColumns("odometer_end", period.odometerEnd),
  };
}

export function periodFromRow(row: any): DayPeriod {
  const odometerStart = reading(row, "odometer_start");
  const odometerEnd = reading(row, "odometer_end");
  return {
    id: row.id,
    kind: row.kind,
    start: time(row.start_time),
    end: time(row.end_time),
    pauseMinutes:
      row.pause_minutes == null ? "" : String(Number(row.pause_minutes)),
    ...(odometerStart ? { odometerStart } : {}),
    ...(odometerEnd ? { odometerEnd } : {}),
  };
}
