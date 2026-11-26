import { reportTeam, type Entry } from "../../contracts/domain.js";
import { pool } from "../db.js";
import { catalogTables, reference } from "../repositories/catalog-repository.js";
import { fail } from "../relational-utils.js";
import { documentForRecord } from "../documents.js";
import { getObjectStorage } from "../object-storage/index.js";
import { concurrencySetting, createConcurrencyLimit } from "../concurrency.js";

type GenerateDocument = (
  item: Entry,
  format: "pdf" | "docx",
) => Promise<Buffer>;

export function createDocumentService(
  generate: GenerateDocument = (item, format) =>
    documentForRecord(item, format, getObjectStorage()),
  limit = concurrencySetting("DOCUMENT_CONCURRENCY"),
) {
  const run = createConcurrencyLimit(
    limit,
    "Há outro documento em geração. Aguarde e tente novamente.",
  );
  return (item: Entry, format: "pdf" | "docx") =>
    run(() => generate(item, format));
}

// A working copy keeps raw selections for later editing. A valid-looking ID
// there is not proof that its catalogue row exists or belongs to the client.
export async function validateWorkingDocumentLinks(item: Entry) {
  const client = await reference(pool, item.clientId, "clients", true);
  const equipment = await reference(pool, item.equipmentId, "equipment", true);
  if (equipment && equipment.clientId !== client?.id)
    throw fail(422, "Equipamento não pertence ao cliente selecionado.");
  await reference(pool, item.vehicleId ?? null, "vehicles", true);
  const technicians = item.kind === "reports"
    ? reportTeam(item).map((member) => member.technicianId)
    : [item.technicianId, item.payload.approvedByTechnicianId as string | null | undefined];
  const checkLinks = async (kind: "technicians" | "parts", ids: (string | null | undefined)[]) => {
    const requested = [...new Set(ids.filter(Boolean))];
    if (!requested.length) return;
    const result = await pool.query(
      `SELECT id FROM ${catalogTables[kind]} WHERE id=ANY($1::text[])`, [requested],
    );
    if (result.rowCount !== requested.length) throw fail(422, "Cadastro inexistente: " + kind);
  };
  await checkLinks("technicians", technicians);
  if (item.kind === "reports")
    await checkLinks("parts", item.payload.parts.map((part: { catalogId?: string }) => part.catalogId));
}
