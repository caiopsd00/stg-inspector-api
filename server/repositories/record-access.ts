import type { User } from "../auth.js";
import { canAdminister, isTechnician } from "../../contracts/domain.js";
import type { DB } from "../relational-utils.js";
import { fail } from "../relational-utils.js";

export type RecordKind = "reports" | "inspections";
export const recordTables = {
  reports: "service_orders",
  inspections: "inspections",
} as const;

// Only an unassigned working draft is private to its original author. As soon
// as any real team member/approver is assigned, only the normal team rule applies.
export function unassignedWorkingDraft(kind: RecordKind, alias: "r" | "i") {
  const noTeam = kind === "reports"
    ? `NOT EXISTS (SELECT 1 FROM service_order_team t WHERE t.service_order_id=${alias}.id)`
    : `(${alias}.technician_id IS NULL AND ${alias}.approved_by_technician_id IS NULL)`;
  return `(${alias}.status='draft' AND ${alias}.working_copy IS NOT NULL AND ${noTeam})`;
}

export async function technicianIdForUser(
  db: DB,
  user: User,
): Promise<string | null> {
  if (!isTechnician(user.role)) return null;
  const row = (
    await db.query(
      "SELECT id FROM technicians WHERE user_id=$1 AND active LIMIT 1",
      [user.id],
    )
  ).rows[0];
  return row?.id || null;
}

export async function assertTechnicianCanSave(
  db: DB,
  kind: RecordKind,
  id: string,
  user: User,
) {
  // Use the same lock as the persistence layer, including administrator writes.
  await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
    `${kind}:${id}`,
  ]);
  if (canAdminister(user.role)) return;
  const ownId = await technicianIdForUser(db, user);
  if (!ownId) throw fail(403, "Seu usuário não possui cadastro técnico ativo.");
  const existing = (
    await db.query(
      `SELECT id FROM ${recordTables[kind]} WHERE id=$1 FOR UPDATE`,
      [id],
    )
  ).rows[0];
  if (existing) {
    const membership = (
      await db.query(
        kind === "reports"
          ? `SELECT 1 FROM service_orders r WHERE r.id=$1 AND (
               EXISTS (SELECT 1 FROM service_order_team tm WHERE tm.service_order_id=r.id AND tm.technician_id=$2)
               OR (r.created_by=$3 AND ${unassignedWorkingDraft(kind, "r")}))`
          : `SELECT 1 FROM inspections i WHERE i.id=$1 AND (
               i.technician_id=$2 OR i.approved_by_technician_id=$2
               OR (i.created_by=$3 AND ${unassignedWorkingDraft(kind, "i")}))`,
        [id, ownId, user.id],
      )
    ).rows[0];
    if (!membership) throw fail(404, "Registro não encontrado.");
  }
  // A technician may create a record for any registered team. After saving,
  // an assigned record is visible only to its resulting members or administrators.
}
