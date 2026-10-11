import { reportTeam, type Kind } from "../../contracts/domain.js";
import { reference } from "./catalog-repository.js";
import { type DB, fail, insert, fileId, date } from "../relational-utils.js";

export async function fileLink(
  db: DB,
  table: string,
  parent: Record<string, unknown>,
  media: any,
  position: number,
  purpose: string,
  extra: Record<string, unknown> = {},
) {
  await insert(db, table, {
    ...parent,
    file_id: fileId(media),
    name: media.name || "imagem",
    position,
    purpose,
    created_at: media.createdAt ? new Date(media.createdAt) : new Date(),
    ...extra,
  });
}
export async function prepareRecordSave(
  db: DB,
  kind: Kind,
  id: string,
  input: any,
  userId: string,
  readCurrent: (db: DB, filter: { id: string }) => Promise<any[]>,
) {
  await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
    kind + ":" + id,
  ]);
  const before = (await readCurrent(db, { id }))[0];
  if ((before?.version || 0) !== input.baseVersion)
    throw fail(
      409,
      "Conflito: existe uma edição mais recente no servidor. Seus dados locais foram preservados.",
    );
  const client = await reference(
    db,
    input.clientId,
    "clients",
    before?.clientId === input.clientId,
  );
  const oldTeam = before && kind === "reports" ? reportTeam(before) : [];
  const tech = await reference(
    db,
    input.technicianId,
    "technicians",
    before?.technicianId === input.technicianId ||
      oldTeam.some((t) => t.technicianId === input.technicianId),
  );
  const equipment = await reference(
    db,
    input.equipmentId,
    "equipment",
    before?.equipmentId === input.equipmentId,
  );
  if (equipment && equipment.clientId !== input.clientId)
    throw fail(422, "Equipamento não pertence ao cliente selecionado.");
  const clientSnapshot =
    before?.clientId === input.clientId
      ? before?.payload.clientSnapshot
      : client;
  const common = {
    id,
    number: input.number,
    client_id: input.clientId,
    equipment_id: input.equipmentId,
    date: date(input.date),
    status: input.status,
    client_name: clientSnapshot?.name || client?.name || null,
    client_cnpj: clientSnapshot?.identifier || client?.identifier || null,
    created_by: userId,
    updated_by: userId,
    finalized_at:
      input.status === "finalized"
        ? (before as any)?.finalizedAt || new Date()
        : null,
    finalized_by:
      input.status === "finalized"
        ? (before as any)?.finalizedBy || userId
        : null,
  };
  const p = input.payload;
  return { before, common, p, oldTeam, tech, equipment };
}
