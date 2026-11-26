import type { Kind } from "../../contracts/domain.js";
import type { DB } from "../relational-utils.js";
import { isoDate, stamp, reading, textNA } from "../relational-utils.js";
import { recordTables, unassignedWorkingDraft } from "./record-access.js";

export type RecordFilter = {
  id?: string;
  from?: string;
  to?: string;
  clientId?: string;
  technicianId?: string;
  status?: "draft" | "finalized";
  q?: string;
  ownTechnicianId?: string | null;
  ownUserId?: string;
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
export const vehicleSnap = (r: any) =>
  r.vehicle_id
    ? {
        plate: r.vehicle_plate,
        model: r.vehicle_model,
        color: r.vehicle_color,
        rentalCompany: r.vehicle_rental_company,
      }
    : null;

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
    techName = "professional.name";
  const teamFilter = isReport
    ? "EXISTS (SELECT 1 FROM service_order_team tm WHERE tm.service_order_id=r.id AND tm.technician_id=$5)"
    : "r.technician_id=$5";
  const ownFilter = isReport
    ? "EXISTS (SELECT 1 FROM service_order_team own_team WHERE own_team.service_order_id=r.id AND own_team.technician_id=$8)"
    : "(r.technician_id=$8 OR r.approved_by_technician_id=$8)";
  const unassigned = unassignedWorkingDraft(kind, "r");
  const teamSearch = isReport
    ? "OR EXISTS (SELECT 1 FROM service_order_team tm WHERE tm.service_order_id=r.id AND (SELECT u.name FROM technicians t JOIN users u ON u.id=t.user_id WHERE t.id=tm.technician_id) ILIKE '%'||$7||'%')"
    : "";
  const rows = (
    await db.query(
      `SELECT r.*,client.name AS client_name,client.cnpj AS client_cnpj,
        professional.name AS technician_name,technician.cpf AS technician_cpf,
        ${isReport ? "" : "COALESCE(professional.name,r.performed_by) AS performed_by,COALESCE(professional.name,r.examiner) AS examiner,COALESCE(approver.name,r.approved_by) AS approved_by,"}
        ${techId} primary_technician_id,${techName} primary_technician_name,
        CASE WHEN ${unassigned} THEN r.created_by END AS draft_author_id
        FROM ${table} r ${techJoin}
        LEFT JOIN clients client ON client.id=r.client_id
        LEFT JOIN technicians technician ON technician.id=${techId}
        LEFT JOIN users professional ON professional.id=technician.user_id
        ${isReport ? "" : "LEFT JOIN technicians approved ON approved.id=r.approved_by_technician_id LEFT JOIN users approver ON approver.id=approved.user_id"}
    WHERE ($1::text IS NULL OR r.id=$1) AND ($2::date IS NULL OR r.date>=$2) AND ($3::date IS NULL OR r.date<=$3)
    AND ($4::text IS NULL OR r.client_id=$4) AND ($5::text IS NULL OR ${teamFilter}) AND ($6::text IS NULL OR r.status=$6)
    AND ($7::text IS NULL OR COALESCE(r.working_copy->>'number',r.number) ILIKE '%'||$7||'%' OR client.name ILIKE '%'||$7||'%' OR ($9::boolean AND (${techName} ILIKE '%'||$7||'%' ${teamSearch})))
    AND ($8::text IS NULL OR ${ownFilter} OR (r.created_by=$10::text AND ${unassigned})) ORDER BY r.updated_at DESC`,
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
        filter.ownUserId,
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
    : [
        "inspection_items",
        "inspection_files",
        "inspection_days",
        "inspection_day_periods",
      ];
  for (const name of tables) {
    const files = name.endsWith("_files");
    children[name] = (
      await db.query(
        `SELECT c.*${name === "service_order_team" ? ",u.name AS technician_name,t.cpf AS technician_cpf" : ""}${files ? ",f.width,f.height,sc.signer_name" : ""} FROM ${name} c ${name === "service_order_team" ? "JOIN technicians t ON t.id=c.technician_id JOIN users u ON u.id=t.user_id" : ""} ${files ? "JOIN files f ON f.id=c.file_id LEFT JOIN signature_captures sc ON sc.id=c.capture_id" : ""} WHERE c.${isReport ? "service_order_id" : "inspection_id"}=ANY($1::text[]) ORDER BY ${files ? "c.position,c.id" : name === "inspection_items" ? "c.section_position,c.position" : "c.position"}`,
        [ids],
      )
    ).rows;
  }
  return { rows, children };
}

export function entryFromRow(r: any, kind: Kind, payload: any) {
  const copy = r.working_copy;
  return {
    id: r.id,
    kind,
    number: copy?.number ?? r.number ?? "",
    clientId: r.client_id,
    equipmentId: r.equipment_id,
    vehicleId: r.vehicle_id,
    technicianId: r.primary_technician_id || null,
    clientName: r.client_name,
    technicianName: r.primary_technician_name || undefined,
    date: isoDate(r.date),
    status: r.status,
    payload: copy ? {
      ...copy.payload,
      clientSnapshot: payload.clientSnapshot,
      technicianSnapshot: payload.technicianSnapshot,
      vehicleSnapshot: payload.vehicleSnapshot,
      ...(kind === "reports"
        ? { teamSnapshot: payload.teamSnapshot, auxiliaryNames: payload.auxiliaryNames }
        : { id: r.id, createdAt: stamp(r.created_at), updatedAt: stamp(r.updated_at), finalizedAt: stamp(r.finalized_at) || null }),
    } : payload,
    version: r.version,
    createdAt: stamp(r.created_at),
    updatedAt: stamp(r.updated_at),
    finalizedAt: stamp(r.finalized_at),
    finalizedBy: r.finalized_by,
    ...(copy ? {
      clientId: copy.clientId,
      equipmentId: copy.equipmentId,
      vehicleId: copy.vehicleId,
      technicianId: copy.technicianId,
      workingCopy: true,
      ...(r.draft_author_id ? { draftAuthorId: r.draft_author_id } : {}),
      documentSignatures: {
        technicianSignature: payload.technicianSignature,
        clientSignature: payload.clientSignature,
        ...(kind === "inspections" ? { signature: payload.signature } : {}),
      },
      serverTechnicianIds: kind === "reports"
        ? payload.teamSnapshot.map((member: any) => member.technicianId)
        : [r.technician_id, r.approved_by_technician_id].filter(Boolean),
    } : {}),
  };
}
