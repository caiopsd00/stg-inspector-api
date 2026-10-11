import type { Kind } from "../../contracts/domain.js";
import type { DB } from "../relational-utils.js";
import { isoDate, stamp, reading, textNA } from "../relational-utils.js";
import { recordTables } from "./record-access.js";

export type RecordFilter = {
  id?: string;
  from?: string;
  to?: string;
  clientId?: string;
  technicianId?: string;
  status?: "draft" | "finalized";
  q?: string;
  ownTechnicianId?: string | null;
  searchTechnician?: boolean;
};

export const eqSnapshot = (r: any) => ({
  type: r.equipment_type,
  brand: r.equipment_brand,
  model: r.equipment_model,
  serial: r.equipment_serial,
  year: r.equipment_year == null ? "" : String(r.equipment_year),
  plate: textNA(r, "equipment_plate"),
  fleet: textNA(r, "equipment_fleet"),
  odometer: reading(r, "odometer"),
  hourmeterLower: reading(r, "hourmeter_lower"),
  hourmeterUpper: reading(r, "hourmeter_upper"),
});
export const snap = (id: string | null, name: string, identifier: string) =>
  id ? { id, name, identifier } : null;

export async function recordRows(
  db: DB,
  kind: Kind,
  filter: RecordFilter = {},
) {
  const isReport = kind === "reports",
    table = recordTables[kind];
  const techJoin = isReport
    ? "LEFT JOIN service_order_team primary_team ON primary_team.service_order_id=r.id AND primary_team.position=0"
    : "";
  const techId = isReport ? "primary_team.technician_id" : "r.technician_id",
    techName = isReport ? "primary_team.technician_name" : "r.technician_name";
  const teamFilter = isReport
    ? "EXISTS (SELECT 1 FROM service_order_team tm WHERE tm.service_order_id=r.id AND tm.technician_id=$5)"
    : "r.technician_id=$5";
  const ownFilter = isReport
    ? "EXISTS (SELECT 1 FROM service_order_team own_team WHERE own_team.service_order_id=r.id AND own_team.technician_id=$8)"
    : "r.technician_id=$8";
  const teamSearch = isReport
    ? "OR EXISTS (SELECT 1 FROM service_order_team tm WHERE tm.service_order_id=r.id AND tm.technician_name ILIKE '%'||$7||'%')"
    : "";
  const rows = (
    await db.query(
      `SELECT r.*,${techId} primary_technician_id,${techName} primary_technician_name FROM ${table} r ${techJoin}
    WHERE ($1::text IS NULL OR r.id=$1) AND ($2::date IS NULL OR r.date>=$2) AND ($3::date IS NULL OR r.date<=$3)
    AND ($4::text IS NULL OR r.client_id=$4) AND ($5::text IS NULL OR ${teamFilter}) AND ($6::text IS NULL OR r.status=$6)
    AND ($7::text IS NULL OR r.number ILIKE '%'||$7||'%' OR r.client_name ILIKE '%'||$7||'%' OR ($9::boolean AND (${techName} ILIKE '%'||$7||'%' ${teamSearch})))
    AND ($8::text IS NULL OR ${ownFilter}) ORDER BY r.updated_at DESC`,
      [
        filter.id,
        filter.from,
        filter.to,
        filter.clientId,
        filter.technicianId,
        filter.status,
        filter.q,
        filter.ownTechnicianId,
        filter.searchTechnician !== false,
      ],
    )
  ).rows;
  if (!rows.length) return { rows, children: {} as Record<string, any[]> };
  const ids = rows.map((r: any) => r.id);
  const children: Record<string, any[]> = {};
  const tables = isReport
    ? [
        "service_order_team",
        "service_order_reasons",
        "service_order_services",
        "service_order_parts",
        "service_order_days",
        "service_order_day_periods",
        "service_order_day_participants",
        "service_order_participant_periods",
        "service_order_files",
        "service_order_part_codes",
      ]
    : ["inspection_items", "inspection_files"];
  for (const name of tables) {
    const files = name.endsWith("_files");
    children[name] = (
      await db.query(
        `SELECT c.*${files ? ",f.width,f.height" : ""} FROM ${name} c ${files ? "JOIN files f ON f.id=c.file_id" : ""} WHERE c.${isReport ? "service_order_id" : "inspection_id"}=ANY($1::text[]) ORDER BY ${files ? "c.position,c.id" : name === "inspection_items" ? "c.section_position,c.position" : "c.position"}`,
        [ids],
      )
    ).rows;
  }
  return { rows, children };
}

export function entryFromRow(r: any, kind: Kind, payload: any) {
  return {
    id: r.id,
    kind,
    number: r.number,
    clientId: r.client_id,
    equipmentId: r.equipment_id,
    technicianId: r.primary_technician_id || null,
    clientName: r.client_name,
    technicianName: r.primary_technician_name || undefined,
    date: isoDate(r.date),
    status: r.status,
    payload,
    version: r.version,
    createdAt: stamp(r.created_at),
    updatedAt: stamp(r.updated_at),
    finalizedAt: stamp(r.finalized_at),
    finalizedBy: r.finalized_by,
  };
}
