import { sha } from "../auth.js";
import { pool, transaction } from "../db.js";
import {
  archiveCatalog,
  catalogItems,
  partByCode,
  saveCatalog,
} from "../repositories/catalog-repository.js";
import type { CatalogKind } from "../../contracts/domain.js";
import type { z } from "zod";
import type { catalogInput } from "../validation.js";
import {
  receiptFor,
  saveReceipt,
} from "../repositories/sync-receipt-repository.js";

export function listCatalogItems(kind: CatalogKind) {
  return catalogItems(pool, kind, { activeOnly: true });
}

export function findPartByCode(code: string) {
  return partByCode(pool, code.trim().toUpperCase());
}

export async function saveCatalogItem(
  kind: CatalogKind,
  id: string,
  input: z.infer<typeof catalogInput>,
  userId: string,
) {
  const hash = sha(JSON.stringify({ action: "catalog.put", kind, id, input }));
  return transaction(async (db) => {
    const receipt = await receiptFor<Awaited<ReturnType<typeof saveCatalog>>>(
      db,
      userId,
      input.mutationId,
      hash,
    );
    if (receipt) return receipt;
    const saved = await saveCatalog(db, kind, id, input, userId);
    await saveReceipt(db, userId, input.mutationId, hash, saved);
    return saved;
  });
}

export async function archiveCatalogItem(
  kind: CatalogKind,
  id: string,
  input: { baseVersion: number; mutationId?: string },
  userId: string,
) {
  const hash = sha(
    JSON.stringify({ action: "catalog.delete", kind, id, input }),
  );
  return transaction(async (db) => {
    const receipt = await receiptFor<
      Awaited<ReturnType<typeof archiveCatalog>>
    >(db, userId, input.mutationId, hash);
    if (receipt) return receipt;
    const result = await archiveCatalog(
      db,
      kind,
      id,
      input.baseVersion,
      userId,
    );
    await saveReceipt(db, userId, input.mutationId, hash, result);
    return result;
  });
}
