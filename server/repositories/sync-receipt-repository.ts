import type { DB } from "../relational-utils.js";
import { fail } from "../relational-utils.js";

export async function receiptFor<T>(
  db: DB,
  userId: string,
  mutationId: string | undefined,
  hash: string,
): Promise<T | null> {
  if (!mutationId) return null;
  await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
    userId + mutationId,
  ]);
  const row = (
    await db.query(
      "SELECT * FROM sync_receipts WHERE user_id=$1 AND mutation_id=$2",
      [userId, mutationId],
    )
  ).rows[0];
  if (row && row.request_hash !== hash)
    throw fail(
      409,
      "Identificador de envio reutilizado com conteúdo diferente.",
    );
  return row?.response ?? null;
}

export async function saveReceipt(
  db: DB,
  userId: string,
  mutationId: string | undefined,
  hash: string,
  response: unknown,
) {
  if (mutationId)
    await db.query(
      "INSERT INTO sync_receipts(user_id,mutation_id,request_hash,response) VALUES($1,$2,$3,$4)",
      [userId, mutationId, hash, JSON.stringify(response)],
    );
}
