import type { Catalog, CatalogKind } from "../../contracts/domain.js";
import { canAdminister } from "../../contracts/domain.js";
import type { User } from "../auth.js";
import { fail, type DB } from "../relational-utils.js";
import { catalogItems } from "./catalog-repository.js";

export async function latestCatalogCreation(
  db: DB,
  kind: CatalogKind,
  userId: string,
) {
  const row = (
    await db.query(
      `SELECT entity_id FROM audit
     WHERE user_id=$1 AND entity_type=$2 AND action='save' AND before_data IS NULL
     ORDER BY id DESC LIMIT 1`,
      [userId, kind],
    )
  ).rows[0];
  return row?.entity_id as string | undefined;
}

export async function catalogWithPermissions(
  db: DB,
  kind: CatalogKind,
  items: Catalog[],
  user: User,
): Promise<Catalog[]> {
  const admin = canAdminister(user.role);
  const latest =
    !admin && kind !== "technicians"
      ? await latestCatalogCreation(db, kind, user.id)
      : undefined;
  return items.map((item) => ({
    ...item,
    permissions: {
      edit:
        kind !== "technicians" && item.active && (admin || item.id === latest),
      archive: kind !== "technicians" && admin,
    },
  }));
}

export async function assertCatalogSave(
  db: DB,
  kind: CatalogKind,
  id: string,
  user: User,
) {
  if (canAdminister(user.role)) return;
  if (kind === "technicians")
    throw fail(
      403,
      "Cadastros técnicos são gerenciados por administradores na aba Cadastros.",
    );
  // Serialize create/edit per user and kind: a concurrent creation must revoke
  // the previous permission before another edit can be accepted.
  await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
    `catalog-creator:${user.id}:${kind}`,
  ]);
  const before = (await catalogItems(db, kind, { id }))[0];
  if (
    before &&
    (!before.active || (await latestCatalogCreation(db, kind, user.id)) !== id)
  )
    throw fail(
      403,
      "Você só pode editar o último cadastro que criou deste tipo.",
    );
}
