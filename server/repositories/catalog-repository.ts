import type { Catalog, CatalogKind } from "../../contracts/domain.js";
import {
  canonicalDocument,
  permanentEquipment,
} from "../../contracts/domain.js";
import {
  type DB,
  fail,
  upsert,
  nullable,
  year,
  textNA,
  textNAColumns,
  audit,
} from "../relational-utils.js";
export const catalogTables = {
  clients: "clients",
  technicians: "technicians",
  equipment: "equipment",
  parts: "parts",
} as const;
export async function catalogItems(
  db: DB,
  kind: CatalogKind,
  options: { id?: string; activeOnly?: boolean } = {},
): Promise<Catalog[]> {
  const rows = (
    await db.query(
      `SELECT * FROM ${catalogTables[kind]} WHERE ($1::text IS NULL OR id=$1) AND (NOT $2::boolean OR active) ORDER BY name`,
      [options.id, !!options.activeOnly],
    )
  ).rows;
  const codes =
    kind === "parts"
      ? (
          await db.query(
            "SELECT * FROM part_codes WHERE part_id=ANY($1::text[]) ORDER BY created_at,code",
            [rows.map((r: any) => r.id)],
          )
        ).rows
      : [];
  return rows.map((r: any) => ({
    id: r.id,
    kind,
    name: r.name,
    identifier: r.cnpj || r.cpf || r.code || null,
    clientId: r.client_id || null,
    active: r.active,
    version: r.version,
    data:
      kind === "equipment"
        ? {
            type: r.type,
            brand: r.brand,
            model: r.model,
            serial: r.serial,
            nominalCapacity: r.nominal_capacity,
            year: r.manufacture_year == null ? "" : String(r.manufacture_year),
            plate: textNA(r, "plate"),
            fleet: textNA(r, "fleet"),
          }
        : kind === "parts"
          ? {
              supplier: r.supplier,
              codeHistory: codes
                .filter((c: any) => c.part_id === r.id && c.code !== r.code)
                .map((c: any) => c.code),
            }
          : kind === "technicians"
            ? { userId: r.user_id }
            : {},
  }));
}
export async function reference(
  db: DB,
  id: string | null,
  kind: CatalogKind,
  archived = false,
): Promise<Catalog | null> {
  if (!id) return null;
  const item = (await catalogItems(db, kind, { id }))[0];
  if (!item || (!item.active && !archived))
    throw fail(422, "Cadastro inexistente ou desativado: " + kind);
  return item;
}
export async function partByCode(
  db: DB,
  code: string,
): Promise<Catalog | undefined> {
  const row = (
    await db.query(
      "SELECT p.id FROM parts p JOIN part_codes c ON c.part_id=p.id WHERE c.code=$1 AND p.active",
      [code],
    )
  ).rows[0];
  return row ? (await catalogItems(db, "parts", { id: row.id }))[0] : undefined;
}
export async function saveCatalog(
  db: DB,
  kind: CatalogKind,
  id: string,
  input: any,
  userId: string,
) {
  await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
    kind + ":" + id,
  ]);
  const before = (await catalogItems(db, kind, { id }))[0];
  if ((before?.version || 0) !== input.baseVersion)
    throw fail(409, "Cadastro alterado. Recarregue antes de editar.");
  let identifier: string | null = null;
  try {
    if (kind !== "equipment")
      identifier = canonicalDocument(kind, input.identifier || "");
  } catch (e: any) {
    throw fail(422, e.message);
  }
  const data: Record<string, unknown> = { id, name: input.name, active: true };
  if (kind === "clients") data.cnpj = identifier;
  if (kind === "technicians") {
    data.cpf = identifier;
    data.user_id = nullable(input.data?.userId);
  }
  if (kind === "equipment") {
    if (!input.clientId) throw fail(422, "Vincule o equipamento a um cliente.");
    await reference(
      db,
      input.clientId,
      "clients",
      before?.clientId === input.clientId,
    );
    const p = permanentEquipment(input.data);
    Object.assign(data, {
      client_id: input.clientId,
      type: p.type,
      brand: p.brand,
      model: p.model,
      serial: p.serial,
      nominal_capacity: Object.prototype.hasOwnProperty.call(
        input.data,
        "nominalCapacity",
      )
        ? p.nominalCapacity
        : before?.data.nominalCapacity || "",
      manufacture_year: year(p.year),
      ...textNAColumns("plate", p.plate),
      ...textNAColumns("fleet", p.fleet),
    });
  }
  if (kind === "parts") {
    const occupied = (
      await db.query("SELECT part_id FROM part_codes WHERE code=$1", [
        identifier,
      ])
    ).rows[0];
    if (occupied && occupied.part_id !== id)
      throw fail(
        409,
        "Código já pertence a outra peça, inclusive no histórico.",
      );
    Object.assign(data, {
      code: identifier,
      supplier: input.data?.supplier || "",
    });
  }
  await upsert(db, catalogTables[kind], data);
  if (kind === "parts")
    await db.query(
      "INSERT INTO part_codes(code,part_id) VALUES($1,$2) ON CONFLICT(code) DO NOTHING",
      [identifier, id],
    );
  const saved = (await catalogItems(db, kind, { id }))[0];
  await audit(db, userId, kind, id, "save", before, saved);
  return saved;
}
export async function archiveCatalog(
  db: DB,
  kind: CatalogKind,
  id: string,
  version: number,
  userId: string,
) {
  await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
    kind + ":" + id,
  ]);
  const before = (await catalogItems(db, kind, { id }))[0];
  if (!before) throw fail(404, "Cadastro não encontrado.");
  if (before.version !== version)
    throw fail(409, "Cadastro alterado. Recarregue.");
  await db.query(
    `UPDATE ${catalogTables[kind]} SET active=false,version=version+1,updated_at=now() WHERE id=$1`,
    [id],
  );
  await audit(db, userId, kind, id, "archive", before, {
    ...before,
    active: false,
    version: version + 1,
  });
  return { ok: true, version: version + 1 };
}
