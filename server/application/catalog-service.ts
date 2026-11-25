import { sha } from "../auth.js";
import { pool, transaction } from "../db.js";
import {
  archiveCatalog,
  catalogItems,
  partByCode,
  saveCatalog,
} from "../repositories/catalog-repository.js";
import { canAdminister, type CatalogKind } from "../../contracts/domain.js";
import type { User } from "../auth.js";
import { fail } from "../relational-utils.js";
import {
  assertCatalogSave,
  catalogWithPermissions,
} from "../repositories/catalog-access.js";
import type { z } from "zod";
import type { catalogInput } from "../validation.js";
import {
  receiptFor,
  saveReceipt,
} from "../repositories/sync-receipt-repository.js";

export function listCatalogItems(kind: CatalogKind, user: User) {
  return transaction(async (db) => {
    await db.query(
      "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY",
    );
    return catalogWithPermissions(
      db,
      kind,
      await catalogItems(db, kind, { activeOnly: true }),
      user,
    );
  });
}

export async function findPartByCode(code: string, user: User) {
  const item = await partByCode(pool, code.trim().toUpperCase());
  return item && (await catalogWithPermissions(pool, "parts", [item], user))[0];
}

export async function saveCatalogItem(
  kind: CatalogKind,
  id: string,
  input: z.infer<typeof catalogInput>,
  user: User,
) {
  const hash = sha(JSON.stringify({ action: "catalog.put", kind, id, input }));
  return transaction(async (db) => {
    await assertCatalogSave(db, kind, id, user);
    const receipt = await receiptFor<Awaited<ReturnType<typeof saveCatalog>>>(
      db,
      user.id,
      input.mutationId,
      hash,
    );
    if (receipt)
      return (await catalogWithPermissions(db, kind, [receipt], user))[0];
    const saved = await saveCatalog(db, kind, id, input, user.id);
    await saveReceipt(db, user.id, input.mutationId, hash, saved);
    return (await catalogWithPermissions(db, kind, [saved], user))[0];
  });
}

export async function archiveCatalogItem(
  kind: CatalogKind,
  id: string,
  input: { baseVersion: number; mutationId?: string },
  user: User,
) {
  if (!canAdminister(user.role))
    throw fail(403, "Somente administradores podem excluir cadastros.");
  const hash = sha(
    JSON.stringify({ action: "catalog.delete", kind, id, input }),
  );
  return transaction(async (db) => {
    const receipt = await receiptFor<
      Awaited<ReturnType<typeof archiveCatalog>>
    >(db, user.id, input.mutationId, hash);
    if (receipt) return receipt;
    const result = await archiveCatalog(
      db,
      kind,
      id,
      input.baseVersion,
      user.id,
    );
    await saveReceipt(db, user.id, input.mutationId, hash, result);
    return result;
  });
}
