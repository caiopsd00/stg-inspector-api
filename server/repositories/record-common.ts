import { reportTeam, type Kind } from "../../contracts/domain.js";
import { reference } from "./catalog-repository.js";
import { type DB, fail, insert, fileId, date } from "../relational-utils.js";

export async function fileLink(
  db: DB,
  table: "service_order_files" | "inspection_files",
  parent: Record<string, unknown>,
  media: any,
  position: number,
  purpose: string,
  extra: Record<string, unknown> = {},
) {
  const id = fileId(media);
  const isReport = table === "service_order_files";
  const recordId = parent[isReport ? "service_order_id" : "inspection_id"];
  let capture;
  if (media.captureId) {
    if (purpose !== "technician_signature" && purpose !== "client_signature")
      throw fail(422, "Uma assinatura não pode ser usada como foto.");
    capture = (
      await db.query(
        `SELECT id,signed_at FROM signature_captures
       WHERE id=$1 AND file_id=$2 AND kind=$3 AND record_id=$4 AND signer_role=$5`,
        [
          media.captureId,
          id,
          isReport ? "reports" : "inspections",
          recordId,
          purpose === "technician_signature" ? "technician" : "client",
        ],
      )
    ).rows[0];
    if (!capture)
      throw fail(422, "Assinatura não pertence a este registro ou signatário.");
  }
  await insert(db, table, {
    ...parent,
    file_id: id,
    name: media.name || "imagem",
    position,
    purpose,
    created_at:
      capture?.signed_at ??
      (media.createdAt ? new Date(media.createdAt) : new Date()),
    capture_id: capture?.id || null,
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
  const p = input.payload;
  if ((before?.version || 0) !== input.baseVersion)
    throw fail(
      409,
      "Conflito: existe uma edição mais recente no servidor. Seus dados locais foram preservados.",
    );
  if (before?.payload.formRevision === 2 && p.formRevision !== 2)
    throw fail(
      428,
      "Este registro usa o formulário novo. Edite-o pelo web atualizado.",
    );
  if (p.formRevision === 2)
    for (const key of ["technicianSignature", "clientSignature"]) {
      const signature = p[key];
      if (
        signature &&
        !signature.captureId &&
        signature.uri !== before?.payload[key]?.uri
      )
        throw fail(
          422,
          "Capture a assinatura pelo formulário para registrar nome e horário.",
        );
    }
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
  const vehicleId =
    input.vehicleId === undefined ? before?.vehicleId || null : input.vehicleId;
  const vehicle = await reference(
    db,
    vehicleId,
    "vehicles",
    before?.vehicleId === vehicleId,
  );
  const vehicleSnapshot =
    vehicle &&
    (before?.vehicleId === vehicleId
      ? before?.payload.vehicleSnapshot || null
      : null);
  const clientSnapshot =
    before?.clientId === input.clientId
      ? before?.payload.clientSnapshot
      : client;
  const filling =
    !before &&
    (
      await db.query(
        `WITH fill AS (
       DELETE FROM record_fill_starts WHERE kind=$1 AND record_id=$2 AND user_id=$3 RETURNING started_at
     ), effective AS (SELECT COALESCE((SELECT started_at FROM fill),now()) AS started_at)
     SELECT started_at,(started_at AT TIME ZONE 'America/Sao_Paulo')::date AS date FROM effective`,
        [kind, id, userId],
      )
    ).rows[0];
  const common = {
    id,
    number: input.number,
    client_id: input.clientId,
    equipment_id: input.equipmentId,
    date:
      p.formRevision === 2 ? before?.date || filling.date : date(input.date),
    ...(filling ? { filling_started_at: filling.started_at } : {}),
    form_revision: p.formRevision || 1,
    status: input.status,
    client_name: clientSnapshot?.name || client?.name || null,
    client_cnpj: clientSnapshot?.identifier || client?.identifier || null,
    vehicle_id: vehicleId,
    vehicle_plate: vehicle
      ? (vehicleSnapshot?.plate ?? vehicle.identifier)
      : null,
    vehicle_model: vehicle
      ? (vehicleSnapshot?.model ?? vehicle.data.model)
      : null,
    vehicle_color: vehicle
      ? (vehicleSnapshot?.color ?? vehicle.data.color)
      : null,
    vehicle_rental_company: vehicle
      ? (vehicleSnapshot?.rentalCompany ?? vehicle.data.rentalCompanyName)
      : null,
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
  return { before, common, p, oldTeam, tech, equipment };
}
