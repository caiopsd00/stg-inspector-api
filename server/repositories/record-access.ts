import type { User } from "../auth.js";
import { reportTeam } from "../../contracts/domain.js";
import type { DB } from "../relational-utils.js";
import { fail } from "../relational-utils.js";

export type RecordKind = "reports" | "inspections";
export const recordTables = {
  reports: "service_orders",
  inspections: "inspections",
} as const;

export async function technicianIdForUser(
  db: DB,
  user: User,
): Promise<string | null> {
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
  input: { technicianId: string | null; payload: Record<string, any> },
  user: User,
) {
  if (user.role === "admin") return;
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
          ? "SELECT 1 FROM service_order_team WHERE service_order_id=$1 AND technician_id=$2"
          : "SELECT 1 FROM inspections WHERE id=$1 AND technician_id=$2",
        [id, ownId],
      )
    ).rows[0];
    if (!membership) throw fail(404, "Registro não encontrado.");
  }
  const assigned =
    kind === "reports"
      ? reportTeam(input).some((member) => member.technicianId === ownId)
      : input.technicianId === ownId;
  if (!assigned)
    throw fail(
      403,
      kind === "reports"
        ? "Inclua seu cadastro técnico na equipe do atendimento."
        : "A inspeção deve ser realizada pelo seu cadastro técnico.",
    );
}
