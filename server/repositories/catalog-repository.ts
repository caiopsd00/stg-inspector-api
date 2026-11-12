import type { Catalog, CatalogKind } from "../../contracts/domain.js";
import {
  canonicalDocument,
  equipmentLabel,
  isTechnician,
  permanentEquipment,
  validateEquipment,
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
  vehicles: "vehicles",
  rentalCompanies: "rental_companies",
} as const;
export async function catalogItems(
  db: DB,
  kind: CatalogKind,
  options: { id?: string; activeOnly?: boolean } = {},
): Promise<Catalog[]> {
  const rows = (
    await db.query(
      `SELECT c.*${kind === "vehicles" ? ", rental.name AS rental_company_name" : ""}
       FROM ${catalogTables[kind]} c
       ${kind === "vehicles" ? "LEFT JOIN rental_companies rental ON rental.id=c.rental_company_id" : ""}
       WHERE ($1::text IS NULL OR c.id=$1) AND (NOT $2::boolean OR c.active)
       ORDER BY c.${kind === "vehicles" ? "plate" : "name"}`,
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
    name:
      kind === "equipment"
        ? equipmentLabel(r, r.name)
        : kind === "vehicles"
          ? r.plate
          : r.name,
    identifier:
      r.cnpj || r.cpf || r.code || (kind === "vehicles" ? r.plate : null),
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
          : kind === "vehicles"
            ? {
                rentalCompanyId: r.rental_company_id,
                rentalCompanyName: r.rental_company_name,
                model: r.model,
                color: r.color,
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
    if (kind !== "equipment" && kind !== "rentalCompanies")
      identifier = canonicalDocument(kind, input.identifier || "");
  } catch (e: any) {
    throw fail(422, e.message);
  }
  const data: Record<string, unknown> = { id, name: input.name, active: true };
  if (kind !== "equipment" && kind !== "vehicles" && !input.name.trim())
    throw fail(422, "Informe o nome.");
  if (kind === "clients") data.cnpj = identifier;
  if (kind === "technicians") {
    const linkedUser = before?.data.userId || null;
    if (input.data?.userId && input.data.userId !== linkedUser)
      throw fail(422, "Vincule o cadastro técnico pela tela de usuários.");
    if (linkedUser) {
      const user = (
        await db.query("SELECT role,active FROM users WHERE id=$1", [
          linkedUser,
        ])
      ).rows[0];
      if (!user?.active || !isTechnician(user.role))
        throw fail(422, "O usuário vinculado não possui perfil técnico ativo.");
    }
    data.cpf = identifier;
    data.user_id = linkedUser;
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
    try {
      validateEquipment(p);
    } catch (error) {
      throw fail(422, (error as Error).message);
    }
    Object.assign(data, {
      name: equipmentLabel(p),
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
  if (kind === "vehicles") {
    const rentalId = input.data?.rentalCompanyId;
    if (typeof rentalId !== "string" || !rentalId)
      throw fail(422, "Selecione a locadora do veículo.");
    await reference(
      db,
      rentalId,
      "rentalCompanies",
      before?.data.rentalCompanyId === rentalId,
    );
    const { model = "", color = "" } = input.data;
    if (
      typeof model !== "string" ||
      model.length > 300 ||
      typeof color !== "string" ||
      color.length > 300
    )
      throw fail(422, "Modelo ou cor do veículo inválidos.");
    delete data.name;
    Object.assign(data, {
      rental_company_id: rentalId,
      plate: identifier,
      model: model.trim(),
      color: color.trim(),
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
